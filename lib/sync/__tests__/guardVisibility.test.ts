// A suppressed write and nothing happening at all used to be indistinguishable.
//
// The change-log row was gated on `guard.keep.length`, so a change set that was ENTIRELY suppressed
// produced NO row. Measured 2026-09-09: a company's mrl_current stayed at 6 while its stage record
// said 7, because the 6→7 write was suppressed as a value repeat — correctly — and left no trace
// anywhere except a console.warn on the server.
//
// Worse, `flagForReview` is only called for `guard.loops`, which carries the oscillation kinds only.
// A `non-converging` suppression — "we wrote X, the field still reads Y, check the mapping" — reached
// nobody at all.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const logChange = vi.fn();
const flagForReview = vi.fn();
const guardChanges = vi.fn();
const recordLedger = vi.fn();

vi.mock('../../audit/log', () => ({ logChange: (...a: unknown[]) => logChange(...a) }));
vi.mock('../reviewQueue', () => ({ flagForReview: (...a: unknown[]) => flagForReview(...a) }));
vi.mock('../convergenceGuard', () => ({
  guardChanges: (...a: unknown[]) => guardChanges(...a),
  recordLedger: (...a: unknown[]) => recordLedger(...a),
}));
vi.mock('../../audit/label', () => ({
  resolveRecordLabel: async () => 'Acme Inc',
  labelFromFields: () => 'Acme Inc',
}));

import { syncConnection } from '../apply';

const conn = {
  name: 'contact-to-company', sourceObject: 'contact', targetObject: 'business',
  rows: [{ sourceKey: 'contact.mrl_current', targetKey: 'business.mrl_current', direction: 'up', enabled: true }],
} as any;

/** Source holds 7, target holds 6 — the exact MRL case. */
const deps = {
  readRecordFields: async (obj: string) =>
    new Map<string, unknown>([[obj === 'contact' ? 'mrl_current' : 'mrl_current', obj === 'contact' ? 7 : 6]]) as any,
  resolveCounterpartIds: async () => ['co_1'],
  getCatalog: async () => ({ byKey: {}, fields: [], folders: [] }) as any,
  writeRecordFields: async () => ({ written: [], skipped: [] }),
};

beforeEach(() => { logChange.mockReset(); flagForReview.mockReset(); guardChanges.mockReset(); recordLedger.mockReset(); });

describe('convergence-guard visibility', () => {
  it('logs an applied:false row when EVERY change is suppressed', async () => {
    // The regression: keep is empty, so the old code logged nothing whatsoever.
    guardChanges.mockResolvedValue({
      keep: [],
      suppressed: [{ key: 'business.mrl_current', kind: 'value-repeat', reason: 'value repeat: 7 written 12s ago' }],
      loops: [],
    });
    await syncConnection(conn, 'ct_1', { apply: true }, deps as any);

    const suppressionRows = logChange.mock.calls.map((c) => c[0]).filter((r: any) => r.applied === false);
    expect(suppressionRows).toHaveLength(1);
    expect(String(suppressionRows[0].error)).toContain('convergence guard suppressed 1 field');
    expect(String(suppressionRows[0].rationale)).toContain('value repeat');
    expect(suppressionRows[0].changes[0].field).toBe('business.mrl_current');
  });

  it('names a non-converging suppression, which previously reached nobody', async () => {
    guardChanges.mockResolvedValue({
      keep: [],
      suppressed: [{ key: 'business.county', kind: 'non-converging', reason: 'non-converging: last wrote "X" but field is "Y" — check mapping transform/options' }],
      loops: [], // ← deliberately empty: non-converging never populates loops, so no review item
    });
    await syncConnection(conn, 'ct_1', { apply: true }, deps as any);

    const rows = logChange.mock.calls.map((c) => c[0]).filter((r: any) => r.applied === false);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].rationale)).toContain('check mapping transform/options');
    expect(flagForReview).not.toHaveBeenCalled(); // documents the remaining gap, deliberately
  });

  it('keeps the applied row separate from the suppression row', async () => {
    // A partial suppression must not blur the two: the applied row still means "what landed".
    guardChanges.mockResolvedValue({
      keep: [{ fieldKey: 'business.mrl_current', from: 6, to: 7 }],
      suppressed: [{ key: 'business.county', kind: 'non-converging', reason: 'non-converging' }],
      loops: [],
    });
    await syncConnection(conn, 'ct_1', { apply: true }, deps as any);

    const all = logChange.mock.calls.map((c) => c[0]);
    expect(all.filter((r: any) => r.applied === false)).toHaveLength(1);
    expect(all.filter((r: any) => r.applied === true)).toHaveLength(1);
  });

  it('logs nothing extra when there is nothing to suppress', async () => {
    guardChanges.mockResolvedValue({ keep: [{ fieldKey: 'business.mrl_current', from: 6, to: 7 }], suppressed: [], loops: [] });
    await syncConnection(conn, 'ct_1', { apply: true }, deps as any);
    expect(logChange.mock.calls.map((c) => c[0]).filter((r: any) => r.applied === false)).toHaveLength(0);
  });
});
