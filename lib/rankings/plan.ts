// lib/rankings/plan.ts — what a Rankings save must write. PURE: no GHL, no I/O.
//
// `writeRecordFields` sends every scalar it is handed (CLAUDE.md), so the diff lives HERE: only a
// record whose rank actually changes is in `set` or `clear`. Saving an untouched list must plan zero
// writes — a write path that cannot report `noop` is broken.

import type { Placement, ProfileStatus, ProfileType } from './placements';

/** The slice of a Profile the planner needs. `ranks` holds the CURRENT stored value per rank field. */
export interface RankProfile {
  id: string;
  name: string;
  profileType: ProfileType | null;
  profileStatus: ProfileStatus | null;
  roles: string[];
  programs: string[];
  collectives: string[];
  ranks: Record<string, number | null>;
}

export interface RankPlan {
  set: Array<{ id: string; from: number | null; to: number }>;
  clear: Array<{ id: string; from: number }>;
  unchanged: string[];
}

/** Is this profile listed on `placement` in the `type` list, within the shown `statuses`? */
export function inScope(p: RankProfile, placement: Placement, type: ProfileType, statuses: readonly string[]): boolean {
  if (p.profileType !== type) return false;
  if (!p.profileStatus || !statuses.includes(p.profileStatus)) return false;
  const m = placement.membership;
  return !m || p[m.field].includes(m.value);
}

export class RankPlanError extends Error {}

/**
 * Ranked ids get 1..n in order. In-scope profiles that hold a rank but are no longer in
 * `orderedIds` get cleared.
 *
 * Scope includes `statuses`: the UI shows published profiles by default, and a hidden profile that
 * holds a rank was never on screen, so it must not be cleared by a save the user made without
 * seeing it. Profiles of the OTHER type share the field (People and Resources are separate tabs on
 * the site) and are never touched.
 */
export function planRanking(args: {
  profiles: RankProfile[];
  placement: Placement;
  type: ProfileType;
  orderedIds: string[];
  statuses: readonly string[];
}): RankPlan {
  const { profiles, placement, type, orderedIds, statuses } = args;
  const field = placement.field;
  if (!placement.types.includes(type)) throw new RankPlanError(`${placement.label} has no ${type} list`);

  const scoped = new Map(profiles.filter((p) => inScope(p, placement, type, statuses)).map((p) => [p.id, p]));
  if (new Set(orderedIds).size !== orderedIds.length) throw new RankPlanError('orderedIds contains duplicates');
  const outside = orderedIds.filter((id) => !scoped.has(id));
  if (outside.length) throw new RankPlanError(`not in ${placement.label} / ${type}: ${outside.join(', ')}`);

  const plan: RankPlan = { set: [], clear: [], unchanged: [] };
  const ranked = new Set(orderedIds);

  orderedIds.forEach((id, i) => {
    const from = scoped.get(id)!.ranks[field] ?? null;
    const to = i + 1;
    if (from === to) plan.unchanged.push(id);
    else plan.set.push({ id, from, to });
  });

  for (const p of Array.from(scoped.values())) {
    if (ranked.has(p.id)) continue;
    const from = p.ranks[field] ?? null;
    if (from == null) continue; // already blank: nothing to write, and not worth reporting
    plan.clear.push({ id: p.id, from });
  }

  return plan;
}
