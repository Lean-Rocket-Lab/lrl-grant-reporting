// Folding a company's stage history down to (initial, current) per scale.
//
// The case that matters is the MIXED one: the scorer routes on business model, so a company can hold
// a Churchill-only record and a TRL/MRL/CRL-only record. Reading the scales off the first and last
// records wholesale reports "no history" for exactly those companies, which is the bug these pin.

import { describe, it, expect } from 'vitest';
import { foldCompanyRecords } from '../portfolio';

const rec = (date: string, props: Record<string, unknown>, createdAt = `${date}T12:00:00.000Z`) => ({
  createdAt,
  properties: { rescore_date: date, ...props },
});

describe('foldCompanyRecords', () => {
  it('reads initial from the earliest record and current from the latest', () => {
    const row = foldCompanyRecords('c1', 'GigNGo', 'both_i_m_dev', [
      rec('2026-08-05', { churchill_score: 2, trl: 8, mrl: 9, crl: 7 }),
      rec('2026-07-31', { churchill_score: 1, trl: 8, mrl: 1, crl: 7 }),
    ]);
    expect(row.scores.churchill).toEqual({ initial: 1, current: 2 });
    expect(row.scores.mrl).toEqual({ initial: 1, current: 9 });
    expect(row.scores.trl).toEqual({ initial: 8, current: 8 });
    // 1 churchill + 8 mrl + 0 trl + 0 crl
    expect(row.advanced).toBe(9);
    expect(row.scalesCompared).toBe(4);
    expect(row.snapshots).toBe(2);
    expect(row.firstDate).toBe('2026-07-31');
    expect(row.lastDate).toBe('2026-08-05');
  });

  it('resolves each scale independently when records carry different scales', () => {
    const row = foldCompanyRecords('c2', 'Split Path', null, [
      rec('2026-07-01', { churchill_score: 2 }),
      rec('2026-09-01', { trl: 4, mrl: 3, crl: 5 }),
    ]);
    // Churchill appears only on the FIRST record: it is both the initial and the current value,
    // not "missing" because the last record omitted it.
    expect(row.scores.churchill).toEqual({ initial: 2, current: 2 });
    expect(row.scores.trl).toEqual({ initial: 4, current: 4 });
    expect(row.advanced).toBe(0);
    expect(row.scalesCompared).toBe(4);
  });

  it('counts a single snapshot as no movement, not as advancement', () => {
    const row = foldCompanyRecords('c3', 'Only Once', 'delivering_o', [rec('2026-09-10', { churchill_score: 3 })]);
    expect(row.snapshots).toBe(1);
    expect(row.scores.churchill).toEqual({ initial: 3, current: 3 });
    expect(row.advanced).toBe(0);
  });

  it('reports a scale with no data as null on both ends and excludes it from the total', () => {
    const row = foldCompanyRecords('c4', 'Service Only', 'delivering_o', [
      rec('2026-07-31', { churchill_score: 4 }),
      rec('2026-08-05', { churchill_score: 2 }),
    ]);
    expect(row.scores.trl).toEqual({ initial: null, current: null });
    expect(row.advanced).toBe(-2);
    expect(row.scalesCompared).toBe(1);
  });

  it('orders by assessment date, not by the order GHL returned the records', () => {
    const row = foldCompanyRecords('c5', 'Out Of Order', null, [
      rec('2026-08-24', { trl: 7 }),
      rec('2026-07-31', { trl: 3 }),
      rec('2026-08-05', { trl: 5 }),
    ]);
    expect(row.scores.trl).toEqual({ initial: 3, current: 7 });
    expect(row.advanced).toBe(4);
  });

  it('falls back to createdAt when two records share an assessment date', () => {
    const row = foldCompanyRecords('c6', 'Same Day', null, [
      rec('2026-09-10', { churchill_score: 5 }, '2026-09-10T18:00:00.000Z'),
      rec('2026-09-10', { churchill_score: 2 }, '2026-09-10T09:00:00.000Z'),
    ]);
    expect(row.scores.churchill).toEqual({ initial: 2, current: 5 });
  });

  it('treats empty strings as missing rather than as zero', () => {
    const row = foldCompanyRecords('c7', 'Blank Fields', null, [rec('2026-09-01', { trl: '', churchill_score: 3 })]);
    expect(row.scores.trl.current).toBeNull();
    expect(row.scores.churchill.current).toBe(3);
  });
});
