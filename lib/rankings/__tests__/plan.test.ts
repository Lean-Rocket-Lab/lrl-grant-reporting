import { describe, it, expect } from 'vitest';
import { planRanking, RankPlanError, type RankProfile } from '../plan';
import { placementFor } from '../placements';

const local = placementFor('rank_local')!;
const team = placementFor('rank_our_team')!;
const board = placementFor('rank_board')!;
const resources = placementFor('rank_resources')!;
const PUB = ['published'];

function prof(id: string, over: Partial<RankProfile> & { rank?: number | null } = {}): RankProfile {
  const { rank = null, ...rest } = over;
  return {
    id,
    name: id,
    profileType: 'person',
    profileStatus: 'published',
    roles: [],
    programs: ['local'],
    collectives: [],
    ranks: { rank_local: rank },
    ...rest,
  };
}

describe('planRanking', () => {
  it('reorder writes only the records whose number changes', () => {
    const profiles = [prof('a', { rank: 1 }), prof('b', { rank: 2 }), prof('c', { rank: 3 })];
    const plan = planRanking({ profiles, placement: local, type: 'person', orderedIds: ['a', 'c', 'b'], statuses: PUB });
    expect(plan.set).toEqual([{ id: 'c', from: 3, to: 2 }, { id: 'b', from: 2, to: 3 }]);
    expect(plan.clear).toEqual([]);
    expect(plan.unchanged).toEqual(['a']);
  });

  it('adding from unranked appends with the next number', () => {
    const profiles = [prof('a', { rank: 1 }), prof('b')];
    const plan = planRanking({ profiles, placement: local, type: 'person', orderedIds: ['a', 'b'], statuses: PUB });
    expect(plan.set).toEqual([{ id: 'b', from: null, to: 2 }]);
    expect(plan.unchanged).toEqual(['a']);
  });

  it('removing a ranked profile clears it and renumbers the rest', () => {
    const profiles = [prof('a', { rank: 1 }), prof('b', { rank: 2 }), prof('c', { rank: 3 })];
    const plan = planRanking({ profiles, placement: local, type: 'person', orderedIds: ['b', 'c'], statuses: PUB });
    expect(plan.clear).toEqual([{ id: 'a', from: 1 }]);
    expect(plan.set).toEqual([{ id: 'b', from: 2, to: 1 }, { id: 'c', from: 3, to: 2 }]);
  });

  it('saving an untouched list plans zero writes (noop is reachable)', () => {
    const profiles = [prof('a', { rank: 1 }), prof('b', { rank: 2 }), prof('u')];
    const plan = planRanking({ profiles, placement: local, type: 'person', orderedIds: ['a', 'b'], statuses: PUB });
    expect(plan.set).toEqual([]);
    expect(plan.clear).toEqual([]);
    expect(plan.unchanged).toEqual(['a', 'b']);
  });

  it('people and resources share the field without disturbing each other', () => {
    const profiles = [
      prof('p1', { rank: 1 }),
      prof('p2', { rank: 2 }),
      prof('r1', { rank: 1, profileType: 'resource' }),
      prof('r2', { rank: 2, profileType: 'resource' }),
    ];
    const plan = planRanking({ profiles, placement: local, type: 'person', orderedIds: ['p2'], statuses: PUB });
    expect(plan.set).toEqual([{ id: 'p2', from: 2, to: 1 }]);
    expect(plan.clear).toEqual([{ id: 'p1', from: 1 }]);
    const touched = [...plan.set, ...plan.clear].map((x) => x.id).concat(plan.unchanged);
    expect(touched).not.toContain('r1');
    expect(touched).not.toContain('r2');
  });

  it('never clears a ranked profile outside the shown statuses or outside the placement', () => {
    const profiles = [
      prof('a', { rank: 1 }),
      prof('hidden', { rank: 2, profileStatus: 'hidden' }),
      prof('left', { rank: 3, programs: [] }), // no longer in LOCAL, still holds a stale rank
    ];
    const plan = planRanking({ profiles, placement: local, type: 'person', orderedIds: ['a'], statuses: PUB });
    expect(plan.clear).toEqual([]);
    expect(plan.set).toEqual([]);
  });

  it('rejects ids that are not in the list, duplicates, and a type the page does not have', () => {
    const profiles = [prof('a'), prof('r', { profileType: 'resource' })];
    expect(() => planRanking({ profiles, placement: local, type: 'person', orderedIds: ['r'], statuses: PUB })).toThrow(RankPlanError);
    expect(() => planRanking({ profiles, placement: local, type: 'person', orderedIds: ['a', 'a'], statuses: PUB })).toThrow(RankPlanError);
    expect(() => planRanking({ profiles, placement: team, type: 'resource', orderedIds: [], statuses: PUB })).toThrow(RankPlanError);
  });

  it('the Resources page lists every resource and no people', () => {
    const profiles = [
      prof('r1', { profileType: 'resource', programs: [], ranks: { rank_resources: 1 } }),
      prof('r2', { profileType: 'resource', programs: [], ranks: { rank_resources: null } }),
      prof('p', { ranks: { rank_resources: 5 } }),
    ];
    const plan = planRanking({ profiles, placement: resources, type: 'resource', orderedIds: ['r2'], statuses: PUB });
    expect(plan.set).toEqual([{ id: 'r2', from: null, to: 1 }]);
    expect(plan.clear).toEqual([{ id: 'r1', from: 1 }]);
    expect(() => planRanking({ profiles, placement: resources, type: 'resource', orderedIds: ['p'], statuses: PUB })).toThrow(RankPlanError);
  });

  it('someone on Team AND Board is ranked separately on each', () => {
    const both = prof('k', { roles: ['team', 'board'], programs: [], ranks: { rank_our_team: 2, rank_board: null } });
    const plan = planRanking({ profiles: [both], placement: board, type: 'person', orderedIds: ['k'], statuses: PUB });
    expect(plan.set).toEqual([{ id: 'k', from: null, to: 1 }]);
    expect(planRanking({ profiles: [both], placement: team, type: 'person', orderedIds: ['k'], statuses: PUB }).set)
      .toEqual([{ id: 'k', from: 2, to: 1 }]);
  });

  it('Team page membership is the roles key', () => {
    const profiles = [prof('t', { roles: ['team'], programs: [], ranks: { rank_our_team: null } })];
    const plan = planRanking({ profiles, placement: team, type: 'person', orderedIds: ['t'], statuses: PUB });
    expect(plan.set).toEqual([{ id: 't', from: null, to: 1 }]);
  });
});
