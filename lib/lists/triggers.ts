// lib/lists/triggers.ts — the three trigger entry points the webhook handlers call.
//
// Each one is FAULT-ISOLATED: it never throws, so a list problem can never break the conversion,
// activity ingest or GA4/LinkedIn/Meta send that shares its webhook. Outcomes go to change_log
// (actor `lists:<source>`) and to the handler's JSON result under `lists`.

import { getContact } from '../ghl/contacts';
import { ghl, type GhlClient } from '../ghl/client';
import { addContactToLists, type ListApplyResult } from './apply';
import { formLists, opportunityLists, isNewOpportunity, eventTagLists, PROGRAM_AFFILIATION_FIELD, type FieldReader } from './rules';
import { loadEventRows, findEventRow } from './eventMap';
import { recentSubmissionFormIds } from './submissions';

export interface ListTriggerResult {
  trigger: 'form' | 'event' | 'opportunity';
  rule?: string | null;
  why?: string[];
  outcome?: ListApplyResult;
  skipped?: string;
  error?: string;
}

interface TriggerOpts { dryRun?: boolean; client?: GhlClient }

const fieldReader = (customFields: Array<{ id: string; value?: unknown }> | undefined): FieldReader => {
  const byId = new Map((customFields ?? []).map((f) => [f.id, f.value]));
  return (id) => byId.get(id);
};

/**
 * A form or survey was submitted. GHL's Form Submitted payload carries no form id, and the contact's
 * Latest Attribution is overwritten as soon as they book a meeting (the Intake flow does exactly
 * that), so the candidates are: an explicit formId, the attributed form, AND the contact's own
 * submissions from the last 2 hours (lib/lists/submissions.ts). Every candidate with a rule applies.
 */
export async function runFormListTrigger(input: { contactId: string; formId?: string }, opts: TriggerOpts & { now?: Date } = {}): Promise<ListTriggerResult> {
  try {
    const client = opts.client ?? ghl();
    const contact: any = await getContact(input.contactId, client).catch(() => null);
    if (!contact) return { trigger: 'form', skipped: 'no-contact' };
    const attr = contact.lastAttribution ?? {};
    const attributed = /^(form|survey)$/i.test(String(attr.medium ?? '')) && attr.mediumId ? String(attr.mediumId) : undefined;
    const recent = await recentSubmissionFormIds(input.contactId, client, opts.now);
    const candidates = Array.from(new Set([input.formId, attributed, ...recent].filter(Boolean) as string[]));
    if (!candidates.length) return { trigger: 'form', skipped: 'no-form-id' };
    const read = fieldReader(contact.customFields);
    const decisions = candidates.map((id) => ({ id, ...formLists(id, read) })).filter((d) => d.rule);
    if (!decisions.length) return { trigger: 'form', rule: null, skipped: `no list rule for ${candidates.join(', ')}` };
    const lists = Array.from(new Set(decisions.flatMap((d) => d.lists)));
    const rule = decisions.map((d) => d.rule).join('+');
    const why = decisions.flatMap((d) => d.why);
    const outcome = await addContactToLists(input.contactId, lists, { source: 'form', detail: `form:${rule}`, dryRun: opts.dryRun, client, contact });
    return { trigger: 'form', rule, why, outcome };
  } catch (err: any) {
    console.error('[lists] form trigger failed', input.contactId, err?.message ?? err);
    return { trigger: 'form', error: String(err?.message ?? err) };
  }
}

/** An event registration. Lists come from the event's Tags in Event_list_db. */
export async function runEventListTrigger(input: { contactId: string; eventId?: string; eventName?: string }, opts: TriggerOpts = {}): Promise<ListTriggerResult> {
  try {
    let rows;
    try { rows = await loadEventRows(); } catch (err: any) {
      console.error('[lists] Event_list_db unreadable', err?.code ?? '', err?.message ?? err);
      return { trigger: 'event', skipped: 'event-map-unavailable', error: String(err?.message ?? err) };
    }
    const hit = findEventRow(rows, input.eventId, input.eventName);
    if (!hit) return { trigger: 'event', skipped: `event not in Event_list_db (${input.eventId ?? ''} ${input.eventName ?? ''})`.trim() };
    const { lists, unknownTags } = eventTagLists(hit.row.tags);
    const why = [`matched by ${hit.matchedBy}: ${hit.row.name}`, `tags: ${hit.row.tags || '(none)'}`];
    if (unknownTags.length) why.push(`unknown tags ignored: ${unknownTags.join(', ')}`);
    if (!lists.length) return { trigger: 'event', rule: 'event-tags', why, skipped: 'event has no list tags' };
    const outcome = await addContactToLists(input.contactId, lists, { source: 'event', detail: `event:${hit.row.name}`, dryRun: opts.dryRun, client: opts.client });
    return { trigger: 'event', rule: 'event-tags', why, outcome };
  } catch (err: any) {
    console.error('[lists] event trigger failed', input.contactId, err?.message ?? err);
    return { trigger: 'event', error: String(err?.message ?? err) };
  }
}

/** Read the opportunity's "LRL Program Affiliation" values from either GHL response shape. */
export function programAffiliation(opp: any): string[] {
  const cf = (opp?.customFields ?? []).find((f: any) => f?.id === PROGRAM_AFFILIATION_FIELD);
  const v = cf?.fieldValueArray ?? cf?.fieldValue ?? cf?.value;
  return Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',').map((s) => s.trim()) : [];
}

/** An opportunity changed stage/status. Only a NEW opportunity (playbook #6: "created") triggers.
 *  NOT HOOKED IN as of 2026-11-25 (Zach): forms/surveys cover program deals; re-enable with coworking. */
export async function runOpportunityListTrigger(opportunityId: string, opts: TriggerOpts & { now?: Date; ignoreAge?: boolean } = {}): Promise<ListTriggerResult> {
  try {
    const client = opts.client ?? ghl();
    const data = await client.request<any>({ path: `/opportunities/${opportunityId}`, autoLocation: false });
    const opp = data?.opportunity ?? data;
    if (!opp?.id) return { trigger: 'opportunity', skipped: 'no-opportunity' };
    if (!opp.contactId) return { trigger: 'opportunity', skipped: 'no-contact' };
    const d = opportunityLists(opp.pipelineId, programAffiliation(opp));
    if (!d.rule) return { trigger: 'opportunity', rule: null, skipped: 'pipeline has no list rule' };
    if (!opts.ignoreAge && !isNewOpportunity(opp.createdAt, opts.now)) {
      return { trigger: 'opportunity', rule: d.rule, skipped: `not new (created ${opp.createdAt ?? 'unknown'})` };
    }
    if (!d.lists.length) return { trigger: 'opportunity', rule: d.rule, skipped: 'no program affiliation that maps to a list' };
    const outcome = await addContactToLists(opp.contactId, d.lists, { source: 'opportunity', detail: `opportunity:${d.rule}`, dryRun: opts.dryRun, client });
    return { trigger: 'opportunity', rule: d.rule, outcome };
  } catch (err: any) {
    console.error('[lists] opportunity trigger failed', opportunityId, err?.message ?? err);
    return { trigger: 'opportunity', error: String(err?.message ?? err) };
  }
}
