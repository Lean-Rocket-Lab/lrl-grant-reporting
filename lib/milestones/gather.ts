// lib/milestones/gather.ts — collect one company's history for the milestone suggester. READ-ONLY.
//
// Spec: docs/sprints/milestone-suggester.md §3. Every source is read through GHL alone:
//   1+2. contact notes (Zoom summaries carry `<!-- lrl:zoom-summary -->`; the rest are staff-written)
//   2.   activity_notes on Activities
//   3.   Activities (grants, referrals, program acceptance, appointments)
//   4.   1:1 email synced into Conversations (campaign blasts filtered, quoted history stripped)
//   5.   call transcripts — NOT gathered yet (untested on a real LC Phone call; spec §3 row 5)
// Plus the company's existing milestones, for dedupe (rule 4) and the active cap (§4a).

import { GhlClient, ghl } from '../ghl/client';
import { getRelatedRecordIds } from '../ghl/associations';
import { listActivitiesForCompany, type ActivitySummary } from '../activities/list';
import { MILESTONES_OBJECT, type ExistingMilestone, type EvidenceSource } from './schema';
import { classifyNote, clip, htmlToText, stripQuotedReply } from './text';

export interface HistoryItem {
  source: EvidenceSource;
  ref: string;      // record id the reviewer can open
  date: string;     // YYYY-MM-DD
  title: string;
  text: string;
}

export interface CompanyHistory {
  companyId: string;
  companyName: string;
  companyDescription: string;
  contactIds: string[];
  existing: ExistingMilestone[];
  items: HistoryItem[];  // oldest → newest
  counts: Record<EvidenceSource, number> & { emailsSeen: number; campaignFiltered: number };
}

export interface GatherOptions {
  client?: GhlClient;
  /** Override contact discovery (comma-separated ids on the CLI). */
  contactIds?: string[];
  /** Skip source 4. Email is on by default — spec §3a governs how it may be used. */
  includeEmail?: boolean;
  /** Only email newer than this many days. */
  emailDays?: number;
  /** Max 1:1 emails per contact after filtering. */
  emailMax?: number;
}

const day = (s: string | undefined) => (s ?? '').slice(0, 10);

async function readCompany(companyId: string, client: GhlClient) {
  const data = await client.request<any>({ path: `/objects/business/records/${companyId}` });
  const r = data.record ?? data;
  const p = r?.properties ?? {};
  return { name: String(p.name ?? ''), description: String(p.description ?? '') };
}

async function readExistingMilestones(companyId: string, client: GhlClient): Promise<ExistingMilestone[]> {
  const ids = await getRelatedRecordIds(companyId, MILESTONES_OBJECT, client);
  const out: ExistingMilestone[] = [];
  for (const id of ids) {
    try {
      const data = await client.request<any>({ path: `/objects/${MILESTONES_OBJECT}/records/${id}` });
      const p = (data.record ?? data)?.properties ?? {};
      out.push({
        id,
        milestone: String(p.milestone ?? ''),
        status: String(p.status ?? ''),
        definitionOfDone: p.definition_of_done ? String(p.definition_of_done) : undefined,
        category: p.milestone_category ? String(p.milestone_category) : undefined,
      });
    } catch { /* deleted records linger as relations for a while */ }
  }
  return out;
}

/** Contacts are found through the company's Activities (contacts/search rejects a businessId filter — 400). */
async function discoverContacts(activities: ActivitySummary[], client: GhlClient): Promise<string[]> {
  const ids = new Set<string>();
  for (const a of activities) {
    for (const c of await getRelatedRecordIds(a.id, 'contact', client)) ids.add(c);
  }
  return Array.from(ids);
}

async function readNotes(contactId: string, companyId: string, client: GhlClient): Promise<HistoryItem[]> {
  const data = await client.request<any>({ path: `/contacts/${contactId}/notes`, autoLocation: false });
  const out: HistoryItem[] = [];
  for (const n of data.notes ?? []) {
    // A note tagged to a DIFFERENT company (the contact moved, or works two jobs) is not this company's history.
    if (n.businessId && n.businessId !== companyId) continue;
    const { kind, text } = classifyNote(String(n.body ?? ''));
    if (!text) continue;
    const appt = (n.relations ?? []).find((r: any) => r.objectKey === 'appointment')?.recordId;
    out.push({
      source: kind,
      ref: appt ? `appointment:${appt}` : `note:${n.id}`,
      date: day(n.dateAdded),
      title: kind === 'zoom_summary' ? 'Zoom AI summary' : `Staff note${n.createdBy?.name ? ` (${n.createdBy.name})` : ''}`,
      text: clip(text, 6000),
    });
  }
  return out;
}

function activityItem(a: ActivitySummary): HistoryItem {
  // Grant line items etc. are noise for milestone purposes — keep the fields that say what happened.
  const keep = /status|award|grant_reason|referral|counterparty|program|event_name|attended|service_topic/i;
  const details = a.details
    .filter((d) => keep.test(d.key) && !/expense/i.test(d.key))
    .map((d) => `${d.label}: ${d.value}`)
    .join('; ');
  return {
    source: 'activity',
    ref: `activity:${a.id}`,
    date: a.date,
    title: `Activity — ${a.typeLabel}: ${a.name}`,
    text: clip([a.notes && `Notes: ${a.notes}`, details].filter(Boolean).join('\n'), 2000),
  };
}

async function readEmails(
  contactId: string,
  client: GhlClient,
  opts: { days: number; max: number },
): Promise<{ items: HistoryItem[]; seen: number; campaign: number }> {
  const since = Date.now() - opts.days * 86_400_000;
  const items: HistoryItem[] = [];
  let seen = 0;
  let campaign = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 10 && items.length < opts.max; page++) {
    const data = await client.request<any>({
      path: '/conversations/messages/export',
      params: { channel: 'Email', contactId, limit: 100, sortBy: 'createdAt', sortOrder: 'desc', cursor },
    });
    const msgs: any[] = data.messages ?? [];
    let reachedOld = false;
    for (const m of msgs) {
      seen++;
      if (Date.parse(m.dateAdded) < since) { reachedOld = true; continue; }
      if (m.source === 'campaign') { campaign++; continue; } // newsletters — spec §3a
      const body = stripQuotedReply(htmlToText(String(m.body ?? '')));
      if (!body) continue;
      items.push({
        source: 'email',
        ref: `message:${m.id}`,
        date: day(m.dateAdded),
        title: `Email ${m.direction === 'inbound' ? 'from client' : 'from LRL'} — ${m.subject ?? '(no subject)'}`,
        text: clip(body, 2500),
      });
      if (items.length >= opts.max) break;
    }
    cursor = data.nextCursor;
    if (!cursor || !msgs.length || reachedOld) break;
  }
  return { items, seen, campaign };
}

export async function gatherCompanyHistory(companyId: string, opts: GatherOptions = {}): Promise<CompanyHistory> {
  const client = opts.client ?? ghl();
  const [company, activities, existing] = await Promise.all([
    readCompany(companyId, client),
    listActivitiesForCompany(companyId, client),
    readExistingMilestones(companyId, client),
  ]);
  const contactIds = opts.contactIds?.length ? opts.contactIds : await discoverContacts(activities, client);

  const items: HistoryItem[] = activities.map(activityItem);
  let emailsSeen = 0;
  let campaignFiltered = 0;
  for (const cid of contactIds) {
    items.push(...(await readNotes(cid, companyId, client)));
    if (opts.includeEmail !== false) {
      const e = await readEmails(cid, client, { days: opts.emailDays ?? 180, max: opts.emailMax ?? 40 });
      items.push(...e.items);
      emailsSeen += e.seen;
      campaignFiltered += e.campaign;
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date));

  const counts = { zoom_summary: 0, staff_note: 0, activity: 0, email: 0, call_transcript: 0, emailsSeen, campaignFiltered };
  for (const i of items) counts[i.source]++;
  return {
    companyId,
    companyName: company.name,
    companyDescription: clip(company.description, 1500),
    contactIds,
    existing,
    items,
    counts,
  };
}
