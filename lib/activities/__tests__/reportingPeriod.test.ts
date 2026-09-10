// Which half-year a Client Reporting submission describes.
//
// Zach's cadence, corrected 2026-09-10: the windows are **Apr 1 – Sep 30** and **Oct 1 – Mar 31**.
// Surveys go out in September/October for Apr–Sep, and in March/April for Oct–Mar; reports are filed
// on 15 April and 15 October for the window that just closed.
//
// This is half of the metrics idempotency key, so a wrong answer either collides two submissions or
// gives one client two snapshots for the same half-year.

import { describe, it, expect } from 'vitest';
import { reportingPeriodFor, reportingPeriodFromEnd, metricsActivityName } from '../reportingPeriod';

describe('reportingPeriodFor', () => {
  it('maps a September collection to the Apr–Sep window', () => {
    expect(reportingPeriodFor('2026-09-12')).toMatchObject({
      start: '2026-04-01', end: '2026-09-30', label: 'Apr–Sep 2026',
    });
  });

  it('maps a March collection to the Oct–Mar window', () => {
    expect(reportingPeriodFor('2026-03-08')).toMatchObject({
      start: '2025-10-01', end: '2026-03-31', label: 'Oct 2025–Mar 2026',
    });
  });

  it('counts the WHOLE collection month, not just its last days', () => {
    // The old rule allowed a boundary up to 21 days in the future, which could not reach 1 September
    // from 30 September — so a survey filled in on the day it arrived landed a half-year early.
    expect(reportingPeriodFor('2026-09-01').end).toBe('2026-09-30');
    expect(reportingPeriodFor('2026-03-01').end).toBe('2026-03-31');
    expect(reportingPeriodFor('2026-09-30').end).toBe('2026-09-30');
  });

  it('keeps a straggler in the window it reports on', () => {
    // The 15th-of-the-month report date means submissions arrive after the window closed.
    expect(reportingPeriodFor('2026-10-15').end).toBe('2026-09-30');
    expect(reportingPeriodFor('2026-10-31').end).toBe('2026-09-30');
    expect(reportingPeriodFor('2026-04-15').end).toBe('2026-03-31');
  });

  it('does NOT pull a mid-cycle submission into a window that has not started closing', () => {
    // August is nearer to 30 September than to 31 March, but the Apr–Sep window is still running and
    // its collection month has not begun.
    expect(reportingPeriodFor('2026-08-25').end).toBe('2026-03-31');
    expect(reportingPeriodFor('2026-06-10').end).toBe('2026-03-31');
    expect(reportingPeriodFor('2026-02-25').end).toBe('2025-09-30');
  });

  it('is stable across a year boundary', () => {
    expect(reportingPeriodFor('2027-01-05').end).toBe('2026-09-30');
    expect(reportingPeriodFor('2026-12-31').end).toBe('2026-09-30');
  });

  it('is deterministic — the same submission always yields the same key', () => {
    const a = reportingPeriodFor('2026-09-12T14:03:22.000Z');
    const b = reportingPeriodFor(new Date('2026-09-12T23:59:59.000Z'));
    expect(a.end).toBe(b.end);
  });

  it('refuses an unparseable date rather than inventing a period', () => {
    expect(() => reportingPeriodFor('not a date')).toThrow(/unparseable/);
  });

  it('never lands on a boundary the new cadence does not use', () => {
    // A guard against a half-applied change: every month of a year must resolve to Mar-end or Sep-end.
    const ends = new Set<string>();
    for (let m = 1; m <= 12; m += 1) ends.add(reportingPeriodFor(`2026-${String(m).padStart(2, '0')}-15`).end.slice(5));
    expect(Array.from(ends).sort()).toEqual(['03-31', '09-30']);
  });
});

describe('reportingPeriodFromEnd', () => {
  it('describes the window ending on a date', () => {
    expect(reportingPeriodFromEnd('2026-09-30')).toMatchObject({
      start: '2026-04-01', end: '2026-09-30', label: 'Apr–Sep 2026',
    });
    expect(reportingPeriodFromEnd('2026-03-31')).toMatchObject({
      start: '2025-10-01', end: '2026-03-31', label: 'Oct 2025–Mar 2026',
    });
  });

  it('labels a LEGACY period end honestly instead of relabelling it', () => {
    // 2026-08-31 was written under the old boundaries. It describes Mar–Aug, and saying so is better
    // than pushing it through the submission rule and calling it Oct–Mar.
    expect(reportingPeriodFromEnd('2026-08-31').label).toBe('Mar–Aug 2026');
    expect(reportingPeriodFromEnd('2026-02-28').label).toBe('Sep 2025–Feb 2026');
  });

  it('agrees with reportingPeriodFor on every period it produces', () => {
    for (const d of ['2026-03-05', '2026-04-15', '2026-09-02', '2026-10-15', '2027-01-01']) {
      const p = reportingPeriodFor(d);
      expect(reportingPeriodFromEnd(p.end)).toEqual(p);
    }
  });

  it('refuses an unparseable date', () => {
    expect(() => reportingPeriodFromEnd('nope')).toThrow(/unparseable/);
  });
});

describe('metricsActivityName', () => {
  it('names a snapshot with its company', () => {
    expect(metricsActivityName('Jarsa', 'Apr–Sep 2026')).toBe('Metrics – Jarsa – Apr–Sep 2026');
  });

  it('omits an unresolved company rather than leaving an empty segment', () => {
    expect(metricsActivityName(null, 'Apr–Sep 2026')).toBe('Metrics – Apr–Sep 2026');
    expect(metricsActivityName('   ', 'Apr–Sep 2026')).toBe('Metrics – Apr–Sep 2026');
  });
});
