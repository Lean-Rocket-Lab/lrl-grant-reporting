// lib/lists/apply.ts — put a contact on lists. ADD-ONLY, equality-guarded, verified by read-back.
//
// Contract (CLAUDE.md hard-won rules):
//  - read first, write only what changes: a re-delivered webhook reports `noop` and writes nothing;
//  - contact custom fields take { id, value: [LABELS] } (a total overwrite of THAT field, which is
//    fine for a one-option checkbox); never the handoff's `field_value` shape;
//  - read back after writing: a field that did not persist is `unverified`, never `added`;
//  - never remove a list. Removal belongs to the contact on /email-preferences.

import { getContact, setContactCustomFields } from '../ghl/contacts';
import { ghl, type GhlClient } from '../ghl/client';
import type { Contact } from '../ghl/types';
import { logChange } from '../audit/log';
import { LIST_FIELDS, SUBSCRIBED, currentLists, withImplied, type ListKey } from './fields';

export type ListSource = 'form' | 'event' | 'opportunity' | 'backfill';

export interface ListApplyResult {
  contactId: string;
  status: 'added' | 'noop' | 'skipped' | 'dry-run' | 'error';
  wanted: ListKey[];
  already: ListKey[];
  added: ListKey[];
  /** Written but not seen on read-back. */
  unverified: ListKey[];
  reason?: string;
  error?: string;
}

export interface ListApplyOptions {
  source: ListSource;
  /** Short provenance shown in the change log, e.g. 'form:IJqdy…' or 'event:Coffee + Connect'. */
  detail?: string;
  dryRun?: boolean;
  client?: GhlClient;
  /** A contact already fetched by the caller; saves one GET. */
  contact?: Contact | null;
}

export async function addContactToLists(contactId: string, lists: ListKey[], opts: ListApplyOptions): Promise<ListApplyResult> {
  const wanted = withImplied(lists);
  const base = { contactId, wanted, already: [] as ListKey[], added: [] as ListKey[], unverified: [] as ListKey[] };
  if (!wanted.length) return { ...base, status: 'skipped', reason: 'no-lists' };

  const client = opts.client ?? ghl();
  const contact = opts.contact ?? (await getContact(contactId, client).catch(() => null));
  if (!contact) return { ...base, status: 'skipped', reason: 'no-contact' };

  const now = currentLists(contact.customFields);
  const already = wanted.filter((k) => now.has(k));
  const missing = wanted.filter((k) => !now.has(k));
  if (!missing.length) return { ...base, already, status: 'noop' };

  const label = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || contactId;
  const changes = missing.map((k) => ({ field: LIST_FIELDS[k].label, from: null, to: SUBSCRIBED, source: opts.detail ?? opts.source }));

  if (opts.dryRun) {
    await logChange({ objectType: 'contact', recordId: contactId, recordLabel: label, actorKind: 'sync', actorName: `lists:${opts.source}`, changes, applied: false });
    return { ...base, already, added: missing, status: 'dry-run' };
  }

  try {
    await setContactCustomFields(contactId, missing.map((k) => ({ id: LIST_FIELDS[k].fieldId, value: [SUBSCRIBED] })), client);
  } catch (err: any) {
    const error = `${err?.status ?? ''} ${err?.message ?? err} ${err?.body ? JSON.stringify(err.body) : ''}`.trim();
    await logChange({ objectType: 'contact', recordId: contactId, recordLabel: label, actorKind: 'sync', actorName: `lists:${opts.source}`, changes, applied: false, error });
    return { ...base, already, status: 'error', error };
  }

  const after = await getContact(contactId, client).catch(() => null);
  const afterLists = currentLists(after?.customFields);
  const added = missing.filter((k) => afterLists.has(k));
  const unverified = missing.filter((k) => !afterLists.has(k));
  await logChange({
    objectType: 'contact', recordId: contactId, recordLabel: label, actorKind: 'sync', actorName: `lists:${opts.source}`,
    changes: changes.filter((c) => added.some((k) => LIST_FIELDS[k].label === c.field)),
    applied: true,
    error: unverified.length ? `not persisted on read-back: ${unverified.join(', ')}` : undefined,
  });
  return { ...base, already, added, unverified, status: added.length ? 'added' : 'error', error: unverified.length ? 'read-back mismatch' : undefined };
}
