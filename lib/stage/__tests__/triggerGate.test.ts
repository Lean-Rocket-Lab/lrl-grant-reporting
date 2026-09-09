// The regression test for the bug that gave Aiden four different scores.
//
// `runStageScoreTrigger` consults its input-hash gate only when it believes today's record exists.
// That belief came from `getCompanyStageContext`, which resolves through the GHL records SEARCH —
// ~12 seconds behind a create. So every webhook delivery inside that window found no record, skipped
// the gate, and paid for a fresh AI call. Measured 2026-09-09: four calls in 21 seconds, MRL
// 7 → 6 → 7 → 7, Churchill 3 → 3 → 2 → 2.
//
// THE ASSERTION THAT MATTERS: with the search index blind but the Postgres claim present and the
// inputs unchanged, `scoreCompany` must NOT be called.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const scoreCompany = vi.fn();
const getCompanyStageContext = vi.fn();
const getEnricherState = vi.fn();
const todayStageRecordId = vi.fn();
const setEnricherState = vi.fn();

vi.mock('../scoreCompany', () => ({
  scoreCompany: (...a: unknown[]) => scoreCompany(...a),
  routePath: () => 'both',
  SCORE_SYSTEM_PROMPT: '',
}));
vi.mock('../priorAssessment', () => ({
  getCompanyStageContext: (...a: unknown[]) => getCompanyStageContext(...a),
  getStageAssociationId: async () => 'assoc_1',
  STAGE_OBJECT: 'custom_objects.business_stage',
  STAGE_ASSOCIATION_KEY: 'company_business_stage',
}));
vi.mock('../../enrichment/stateStore', () => ({
  getEnricherState: (...a: unknown[]) => getEnricherState(...a),
  setEnricherState: (...a: unknown[]) => setEnricherState(...a),
  // Deterministic, so the gate's comparison is exact and the test asserts behaviour rather than
  // guessing at a hash it cannot compute.
  fingerprint: () => 'HASH',
  normalizeCompanyAddress: (v: unknown) => String(v ?? ''),
  addressNeedsGeocode: () => false,
}));
vi.mock('../stageDayClaim', () => ({
  todayStageRecordId: (...a: unknown[]) => todayStageRecordId(...a),
  claimStageDay: async () => ({ action: 'create' }),
  publishStageDay: async () => {},
  abandonStageDay: async () => {},
  STAGE_CLAIM_SOURCE: 'Client Stage',
  stageDayKey: (c: string, d: string) => `${c}:${d.slice(0, 10)}`,
}));
vi.mock('../../enrichment/configStore', () => ({
  resolveEnricherConfig: async () => ({ enricher: 'client-stage-scorer', sourceObject: 'business', enabled: true, groups: [], combine: 'AND' }),
}));
vi.mock('../../ghl/catalogCache', () => ({ getCatalog: async () => ({ byKey: {}, fields: [], folders: [] }) }));
vi.mock('../../ghl/client', () => ({ ghl: () => ({ locationId: 'loc' }) }));
vi.mock('../../ghl/records', () => ({
  // Enough populated inputs that the "nothing to score from" guard passes.
  readRecordFields: async () => ({
    get: (k: string) => ({
      business_model: 'Both — developing a product AND running a service',
      description: 'A real company doing real things',
      where_are_you_today: 'I have a stable, profitable business',
    } as Record<string, unknown>)[k.replace(/^business\./, '')],
  }),
}));

import { runStageScoreTrigger } from '../trigger';

beforeEach(() => {
  for (const m of [scoreCompany, getCompanyStageContext, getEnricherState, todayStageRecordId, setEnricherState]) m.mockReset();
  scoreCompany.mockResolvedValue(null); // if it IS called, fail loudly rather than write
});

describe('the scorer gate, inside the search-index lag', () => {
  it('does NOT re-score when the search is blind but the CLAIM says we scored today', async () => {
    // Delivery #2, ~13 seconds after #1 — the exact original bug. The index has not caught up, so
    // ctx.todayRecordId is null; Postgres holds the claim; the inputs have not changed.
    getCompanyStageContext.mockResolvedValue({ prior: null, todayRecordId: null });
    todayStageRecordId.mockResolvedValue('rec_from_claim');
    getEnricherState.mockResolvedValue({ scoreInputHash: 'HASH' });

    const res = await runStageScoreTrigger('co_1', { today: '2026-09-09' } as any);

    expect(res.ran).toBe(false);
    expect(res.reason).toBe('inputs unchanged since last score');
    expect(scoreCompany).not.toHaveBeenCalled(); // ← no AI call, which is the whole point
  });

  it('DOES re-score when the inputs genuinely changed', async () => {
    // The behaviour Zach asked to keep: a real answer change must produce a new score.
    getCompanyStageContext.mockResolvedValue({ prior: null, todayRecordId: null });
    todayStageRecordId.mockResolvedValue('rec_from_claim');
    getEnricherState.mockResolvedValue({ scoreInputHash: 'A_DIFFERENT_HASH' });
    await runStageScoreTrigger('co_1', { today: '2026-09-09' } as any);
    expect(scoreCompany).toHaveBeenCalled();
  });

  it('honours --force / opts.force regardless of the gate', async () => {
    getCompanyStageContext.mockResolvedValue({ prior: null, todayRecordId: null });
    todayStageRecordId.mockResolvedValue('rec_from_claim');
    getEnricherState.mockResolvedValue({ scoreInputHash: 'HASH' });
    await runStageScoreTrigger('co_1', { today: '2026-09-09', force: true } as any);
    expect(scoreCompany).toHaveBeenCalled();
  });

  it('consults the gate even when the search index shows nothing', async () => {
    // The bug in one line: with todayRecordId null and no claim, the old code never read state.
    getCompanyStageContext.mockResolvedValue({ prior: null, todayRecordId: null });
    todayStageRecordId.mockResolvedValue('rec_from_claim');
    getEnricherState.mockResolvedValue({ scoreInputHash: 'anything' });
    await runStageScoreTrigger('co_1', { today: '2026-09-09' } as any);
    expect(getEnricherState).toHaveBeenCalledWith('co_1');
  });

  it('asks Postgres for today’s record, not only the lagging search', async () => {
    getCompanyStageContext.mockResolvedValue({ prior: null, todayRecordId: null });
    todayStageRecordId.mockResolvedValue(null);
    getEnricherState.mockResolvedValue(null);
    await runStageScoreTrigger('co_1', { today: '2026-09-09' } as any);
    expect(todayStageRecordId).toHaveBeenCalledWith('co_1', '2026-09-09');
  });

  it('still scores a genuinely first-time company', async () => {
    // Nothing claimed, nothing prior → the gate must not block the first score.
    getCompanyStageContext.mockResolvedValue({ prior: null, todayRecordId: null });
    todayStageRecordId.mockResolvedValue(null);
    getEnricherState.mockResolvedValue(null);
    scoreCompany.mockResolvedValue(null);
    await runStageScoreTrigger('co_1', { today: '2026-09-09' } as any);
    expect(scoreCompany).toHaveBeenCalled();
  });
});
