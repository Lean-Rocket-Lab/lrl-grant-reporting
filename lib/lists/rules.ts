// lib/lists/rules.ts — WHICH lists a trigger puts a contact on. Pure functions, no I/O.
//
// Every trigger is ADD-ONLY: these functions return lists to add, never lists to remove. Removal is
// the contact's own choice on the /email-preferences page. Zach, 2026-11-25: a contact who unticked a
// list and later registers for that program's event, or applies to it, IS re-added — so there is no
// opt-out check here on purpose.
//
// Rule source: the trigger map in the Marketing project's email playbook (handoff 2026-11-25), with
// live ids measured the same day. A new form or pipeline is a row in the tables below.

import { withImplied, type ListKey } from './fields';

// ─── Forms and surveys ────────────────────────────────────────────────────────────────────────────

/** Form / survey ids (GHL `mediumId` on the contact's Latest Attribution). */
export const FORM_IDS = {
  intakeSurvey: 'IJqdyjwPnCbeiEb0wsat', // survey "Intake Form"
  samaApplicationForm: 'mWU9Z0cDIii1pz33WK0E', // form "SAMA Cohort Application"
  samaApplicationSurvey: 'PKhp7NVOdeXlWI3WHnEx', // survey "SAMA Application"
  localFellowsApplication: 'UXZGE7hDYludF7ZgjE2P', // form "LOCAL Fellows Application"
  joinACollective: 'TzYr5INmfN4QfOQVCk97', // form "Join a Collective"
} as const;

/** Contact custom fields the rules read (ids measured live 2026-11-25). */
export const RULE_FIELDS = {
  whereAreYouToday: 'kUmwGRyvStc0dflxqJcd', // RADIO "Where are you today?"
  annualRevenue: 'q8hglJ0FpCWy76eB5R8W', // NUMERICAL "Annual Revenue"
  hobbyToGrow: 'oYMykFJqcK8oVST28MFR', // RADIO "This is a hobby that I want to grow into a business."
  businessModel: 'G7RXSwbDQCy1BJoThVRd', // RADIO "Business Model"
  howManufactured: 'xfpN9qCSTL4W25Mq4cDg', // SINGLE_OPTIONS "How is your product manufactured today?"
  resourcesWanted: 'RMWYxsHs2NFj90ctEfoW', // CHECKBOX "My company is most interested in the following resources."
  programsWanted: '0iWQZZ8RQaQpEbLOBQj7', // CHECKBOX "My company is interested in the following programs"
  dateOfIncorporation: 'wG0tcMIZF9C1ayNmj5zy', // DATE "Date of Incorporation"
  collectivesToJoin: 'nAVD5JISjCsk6A3gsGKR', // CHECKBOX "Enroll in the following Collectives at Lean Rocket Lab"
} as const;

export type FieldReader = (fieldId: string) => unknown;

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean)
    : typeof v === 'string' && v.trim() ? [v.trim()] : [];
const first = (v: unknown): string => asList(v)[0] ?? '';
const startsWith = (v: unknown, prefix: string) => first(v).toLowerCase().startsWith(prefix.toLowerCase());

/** Parse a GHL DATE value (ISO string, YYYY-MM-DD, or epoch ms) to a Date, or null. */
export function parseGhlDate(v: unknown): Date | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : /^\d{10,13}$/.test(String(v)) ? Number(v) : NaN;
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface IntakeDecision {
  lists: ListKey[];
  why: string[];
}

/**
 * The Intake survey rule (playbook #2).
 *  - Lean Startup: stage is idea / researching or prototyping / early product, OR revenue is zero
 *    (pre-revenue), OR "hobby I want to grow" is Yes, OR the business started in 2025 or later.
 *    Exception: when the ONLY Lean Startup signal is the 2025+ start date and the contact fits
 *    Mainstreet, Mainstreet only.
 *  - Mainstreet: Business Model is the service option or "Both".
 *  - ManuTech: manufactured anything but "software only", OR wants Prototyping or Engineering /
 *    Manufacturing resources, OR program interest includes Industry 4.0.
 */
export function intakeLists(read: FieldReader): IntakeDecision {
  const why: string[] = [];
  const lists = new Set<ListKey>();

  const where = read(RULE_FIELDS.whereAreYouToday);
  const earlyStage = startsWith(where, 'I have an idea') || startsWith(where, "I'm researching or prototyping") || startsWith(where, 'I have an early product');
  const revenueRaw = read(RULE_FIELDS.annualRevenue);
  const preRevenue = revenueRaw !== undefined && revenueRaw !== null && revenueRaw !== '' && Number(revenueRaw) === 0;
  const hobby = /^yes$/i.test(first(read(RULE_FIELDS.hobbyToGrow)));
  const started = parseGhlDate(read(RULE_FIELDS.dateOfIncorporation));
  const youngBusiness = Boolean(started && started.getUTCFullYear() >= 2025);

  const model = first(read(RULE_FIELDS.businessModel));
  const mainstreet = /^delivering or operating a service/i.test(model) || /^both/i.test(model);

  const strongLean = earlyStage || preRevenue || hobby;
  if (strongLean) {
    lists.add('lean_startup');
    if (earlyStage) why.push('stage: early');
    if (preRevenue) why.push('revenue: 0');
    if (hobby) why.push('hobby to grow: yes');
  } else if (youngBusiness && !mainstreet) {
    lists.add('lean_startup');
    why.push('started 2025+');
  } else if (youngBusiness && mainstreet) {
    why.push('started 2025+ but Mainstreet fit: Mainstreet only');
  }
  if (mainstreet) { lists.add('mainstreet_collective'); why.push('business model: service or both'); }

  const manufactured = first(read(RULE_FIELDS.howManufactured));
  const physical = manufactured !== '' && !/software only/i.test(manufactured);
  const resources = asList(read(RULE_FIELDS.resourcesWanted));
  const wantsBuildHelp = resources.some((r) => /^prototyping$/i.test(r) || /^engineering \/ manufacturing resources$/i.test(r));
  const i40 = asList(read(RULE_FIELDS.programsWanted)).some((p) => /industry 4\.0/i.test(p));
  if (physical || wantsBuildHelp || i40) {
    lists.add('manutech');
    if (physical) why.push(`manufactured: ${manufactured}`);
    if (wantsBuildHelp) why.push('wants prototyping / engineering');
    if (i40) why.push('program interest: i4.0');
  }
  return { lists: withImplied(lists), why };
}

const COLLECTIVE_OPTION: Record<string, ListKey> = {
  'lean startup': 'lean_startup',
  mainstreet: 'mainstreet_collective',
  'manufacturing tech': 'manutech',
};

/** Lists for one form or survey submission (playbook #2 to #5). Unknown form = none. */
export function formLists(formId: string | undefined, read: FieldReader): { lists: ListKey[]; rule: string | null; why: string[] } {
  switch (formId) {
    case FORM_IDS.intakeSurvey: {
      const d = intakeLists(read);
      return { lists: d.lists, rule: 'intake', why: d.why };
    }
    case FORM_IDS.samaApplicationForm:
    case FORM_IDS.samaApplicationSurvey:
      return { lists: ['sama'], rule: 'sama-application', why: [] };
    case FORM_IDS.localFellowsApplication:
      return { lists: withImplied(['local'] as ListKey[]), rule: 'local-application', why: [] };
    case FORM_IDS.joinACollective: {
      const picked = asList(read(RULE_FIELDS.collectivesToJoin));
      const lists = picked.map((p) => COLLECTIVE_OPTION[p.toLowerCase()]).filter(Boolean) as ListKey[];
      return { lists: withImplied(lists), rule: 'join-a-collective', why: picked.length ? [`picked: ${picked.join(', ')}`] : ['nothing picked'] };
    }
    default:
      return { lists: [], rule: null, why: [] };
  }
}

// ─── Opportunities ────────────────────────────────────────────────────────────────────────────────

export const PIPELINES = {
  clientJourney: 'cVtiFjiPXoIqPEkmYG7j',
  localFellowsBootcamp: 'Ewioq7ycVmNpJ9oCM3JC',
  samaCohort: 'nRK4xQsQ9V4jmXbmz5YO',
  manutech: 'UFM2Q21TZZYxQCBjcGgt',
  coworkingSpace: 'J7q7yXiSL14Vts7FWJqe', // no rule yet: coworking triggers are off (2026-11-25)
} as const;

/** Opportunity field "LRL Program Affiliation" (MULTIPLE_OPTIONS). */
export const PROGRAM_AFFILIATION_FIELD = 'kdK09OxbOSuA3ZnxzRyG';

const AFFILIATION_LISTS: Record<string, ListKey[]> = {
  local: ['local'],
  'sales and marketing accelerator': ['sama'],
  manutech: ['manutech'],
  // 'co-working' and 'gateway' map to no list on purpose. Coworking triggers are OFF for now
  // (Zach 2026-11-25: least important, add later). Re-enable here and in PIPELINES/EVENT_TAG_LISTS.
};

/**
 * Playbook #6 is "opportunity CREATED in a pipeline". GHL only tells us about stage/status changes,
 * so an opportunity counts as a trigger only while it is new. That keeps a staff cleanup pass (moving
 * old records between stages) from re-subscribing people who unsubscribed.
 */
export const OPP_CREATED_WINDOW_HOURS = 48;

export function opportunityLists(
  pipelineId: string | undefined,
  programAffiliation: string[],
): { lists: ListKey[]; rule: string | null } {
  switch (pipelineId) {
    case PIPELINES.clientJourney: {
      const lists = programAffiliation.flatMap((p) => AFFILIATION_LISTS[p.trim().toLowerCase()] ?? []);
      return { lists: withImplied(lists), rule: 'client-journey' };
    }
    case PIPELINES.localFellowsBootcamp:
      return { lists: withImplied(['local'] as ListKey[]), rule: 'local-fellows-pipeline' };
    case PIPELINES.samaCohort:
      return { lists: ['sama'], rule: 'sama-cohort-pipeline' };
    case PIPELINES.manutech:
      return { lists: ['manutech'], rule: 'manutech-pipeline' };
    default:
      return { lists: [], rule: null };
  }
}

/** True when the opportunity was created within the trigger window. */
export function isNewOpportunity(createdAt: string | undefined, now: Date = new Date()): boolean {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t <= OPP_CREATED_WINDOW_HOURS * 3600_000;
}

// ─── Events ───────────────────────────────────────────────────────────────────────────────────────

const EVENT_TAG_LISTS: Record<string, ListKey> = {
  'lean-startup': 'lean_startup',
  mainstreet: 'mainstreet_collective',
  local: 'local',
  sama: 'sama',
  manutech: 'manutech',
  i40: 'manutech',
  'manufacturing-tech': 'manutech',
  // coworking: off for now (2026-11-25)
  'exit-readiness': 'exit_readiness',
};

/** Lists for an event's Tags cell ("sama, manutech, i40"). Unknown tags are reported, not guessed. */
export function eventTagLists(tagsCell: string | undefined): { lists: ListKey[]; unknownTags: string[] } {
  const tags = (tagsCell ?? '').split(/[,;]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const lists: ListKey[] = [];
  const unknownTags: string[] = [];
  for (const t of tags) {
    const k = EVENT_TAG_LISTS[t];
    if (k) lists.push(k); else unknownTags.push(t);
  }
  return { lists: withImplied(lists), unknownTags };
}
