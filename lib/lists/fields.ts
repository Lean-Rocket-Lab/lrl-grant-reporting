// lib/lists/fields.ts — the marketing list fields, in one place.
//
// Each list is a CHECKBOX contact custom field in the GHL folder "Marketing Lists" with a single
// option, "Subscribed". The field IS the list: smart lists filter on it, and nothing else (no tags)
// decides membership. Ids measured live 2026-11-25. Source of truth for the rules:
// claude/email-playbook.md (LRL Marketing project); build plan: docs/sprints/email-lists.md.

export const SUBSCRIBED = 'Subscribed';

export type ListKey =
  | 'lean_startup'
  | 'mainstreet_collective'
  | 'local'
  | 'sama'
  | 'manutech'
  | 'coworking'
  | 'exit_readiness';

export interface ListField {
  key: ListKey;
  fieldId: string;
  fieldKey: string;
  label: string;
}

export const LIST_FIELDS: Readonly<Record<ListKey, ListField>> = {
  lean_startup: { key: 'lean_startup', fieldId: '58IUSDgIzyyb9J9WUz5x', fieldKey: 'contact.list__lean_startup', label: 'List - Lean Startup' },
  mainstreet_collective: { key: 'mainstreet_collective', fieldId: 'JLF9PcdpJ6jweOyyxiQK', fieldKey: 'contact.list__mainstreet_collective', label: 'List - Mainstreet Collective' },
  local: { key: 'local', fieldId: 'YXhhbiGQY0Q86W6k6Cob', fieldKey: 'contact.list__local', label: 'List - LOCAL' },
  sama: { key: 'sama', fieldId: '888rrqEk1AO25nO3xpK1', fieldKey: 'contact.list__sama', label: 'List - SAMA' },
  manutech: { key: 'manutech', fieldId: 'rkYcZWqgA3ARImhzLjxU', fieldKey: 'contact.list__manutech', label: 'List - ManuTech' },
  coworking: { key: 'coworking', fieldId: 'ZYc1eH4F2MYWfzGNTuJG', fieldKey: 'contact.list__coworking', label: 'List - Coworking' },
  exit_readiness: { key: 'exit_readiness', fieldId: 'mPvI7CxivJ8e8mbVMpe1', fieldKey: 'contact.list__exit_readiness', label: 'List - Exit Readiness' },
};

export const ALL_LIST_KEYS = Object.keys(LIST_FIELDS) as ListKey[];

/** A contact custom-field value counts as subscribed when it holds the "Subscribed" option. */
export function isSubscribedValue(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((x) => String(x).trim() === SUBSCRIBED);
  return typeof v === 'string' && v.split(',').some((x) => x.trim() === SUBSCRIBED);
}

/** Which lists this contact is on right now, read from its custom fields. */
export function currentLists(customFields: Array<{ id: string; value?: unknown }> | undefined): Set<ListKey> {
  const byId = new Map((customFields ?? []).map((f) => [f.id, f.value]));
  const out = new Set<ListKey>();
  for (const f of Object.values(LIST_FIELDS)) if (isSubscribedValue(byId.get(f.fieldId))) out.add(f.key);
  return out;
}

/** House rule from the playbook: LOCAL always implies Mainstreet. Returns a sorted, de-duped list. */
export function withImplied(lists: Iterable<ListKey>): ListKey[] {
  const s = new Set(lists);
  if (s.has('local')) s.add('mainstreet_collective');
  return ALL_LIST_KEYS.filter((k) => s.has(k));
}
