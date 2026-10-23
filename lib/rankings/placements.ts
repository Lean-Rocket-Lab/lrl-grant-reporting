// lib/rankings/placements.ts — the ONE table of website pages that Zach ranks by hand.
//
// Each placement is a page on leanrocketlab.org that sorts its Profiles by one NUMERICAL `rank_*`
// field on custom_objects.profiles (lower = shown first, blank = after the ranked ones, alphabetical).
// Adding a page = one row here + one field in GHL (folder "Page Ranking", Yo0DNfBKHOjxx92IsmGM).
//
// Membership values are option KEYS, because that is what the object search returns for a
// multi-select. A label here would match nothing and fail silently.

export const PROFILES_OBJECT = 'custom_objects.profiles';

export type ProfileType = 'person' | 'resource';
export type MembershipField = 'roles' | 'programs' | 'collectives';

export interface Placement {
  /** Bare field key on custom_objects.profiles. */
  field: string;
  label: string;
  /**
   * Who is listed: profiles whose `membership.field` contains `membership.value`. `null` = every
   * profile of the placement's type (the Resources directory page).
   */
  membership: { field: MembershipField; value: string } | null;
  /**
   * Which profile types have their own list. The four directory pages have ONE list; every program
   * and collective page shows People and Resources in separate tabs, so both lists are numbered 1..n
   * in the SAME field and rank independently.
   */
  types: ProfileType[];
}

export const PLACEMENTS: Placement[] = [
  // Directory pages. Someone on Team AND Board appears on both lists and is ranked separately on each.
  { field: 'rank_our_team', label: 'Team page', membership: { field: 'roles', value: 'team' }, types: ['person'] },
  { field: 'rank_eir', label: 'EIRs page', membership: { field: 'roles', value: 'eir' }, types: ['person'] },
  { field: 'rank_board', label: 'Board page', membership: { field: 'roles', value: 'board' }, types: ['person'] },
  { field: 'rank_resources', label: 'Resources page', membership: null, types: ['resource'] },
  // Program and collective pages: People and Resources tabs.
  { field: 'rank_local', label: 'LOCAL', membership: { field: 'programs', value: 'local' }, types: ['person', 'resource'] },
  { field: 'rank_sama', label: 'Sales & Marketing Accelerator', membership: { field: 'programs', value: 'sales_and_marketing_accelerator' }, types: ['person', 'resource'] },
  { field: 'rank_manutech', label: 'ManuTech Incubator', membership: { field: 'programs', value: 'manutech_incubator' }, types: ['person', 'resource'] },
  { field: 'rank_i40', label: 'i4.0 Accelerator', membership: { field: 'programs', value: 'industry_40_accelerator' }, types: ['person', 'resource'] },
  { field: 'rank_lean_startup', label: 'Lean Startup', membership: { field: 'collectives', value: 'lean_startup' }, types: ['person', 'resource'] },
  { field: 'rank_mainstreet', label: 'Mainstreet', membership: { field: 'collectives', value: 'mainstreet' }, types: ['person', 'resource'] },
  { field: 'rank_manufacturing', label: 'Manufacturing Tech', membership: { field: 'collectives', value: 'manufacturing' }, types: ['person', 'resource'] },
];

export const RANK_FIELDS: string[] = PLACEMENTS.map((p) => p.field);

export function placementFor(field: string): Placement | undefined {
  return PLACEMENTS.find((p) => p.field === field);
}

/** `profile_status` values. Only `published` shows on the site, so it is the default scope. */
export const STATUSES = ['published', 'approved', 'pending', 'hidden'] as const;
export type ProfileStatus = (typeof STATUSES)[number];
export const DEFAULT_STATUSES: ProfileStatus[] = ['published'];
