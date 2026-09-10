// lib/activities/reportingPeriod.ts — which six-month window a Client Reporting snapshot covers.
//
// Zach, 2026-09-10 (CORRECTING an earlier reading of the cadence):
//
//     "The Metric reporting cycles are April 1 – September 30 and October 1 – March 31. We send out
//      surveys for the April–September window in September and October. We send out surveys for the
//      October–March in March and April. We submit reports on the 15th of April and October for the
//      previous periods."
//
// So the windows END on 30 September and 31 March, and each survey is collected in the boundary
// month itself or the month after:
//
//     collected Sep or Oct  →  covers Apr 1 – Sep 30   (period end Sep 30)
//     collected Mar or Apr  →  covers Oct 1 – Mar 31   (period end Mar 31)
//
// ⚠️ This file previously used Feb-end/Aug-end boundaries, read from "September for an October 15th
// date". That got the COLLECTION months right and the WINDOW a month short: a survey collected in
// September asks about a window that ends 30 September, not 31 August. The 189 snapshots written
// under the old boundaries were remapped by `scripts-ts/metrics-period-remap.ts`.
//
// The period is stored as a DATE (`reporting_period`), stamped with the window's END — the most
// reportable form of it ("the snapshot as at 30 Sep 2026") and the one that sorts.
//
// WHY THIS MATTERS MORE THAN IT LOOKS: the period is half of the idempotency key for a metrics
// snapshot (`<contactId>:<periodEnd>`). Derive it inconsistently and either two submissions collide
// into one record, or one client ends up with two snapshots for the same half-year — and a
// follow-on-funding figure counted twice is exactly the kind of error that still looks plausible.

/** The two boundaries a reporting window can end on: end of March, end of September. */
const BOUNDARY_MONTHS = [2, 8]; // 0-indexed: March, September

const endOfMonth = (year: number, monthIndex: number) => new Date(Date.UTC(year, monthIndex + 1, 0));
const startOfMonth = (year: number, monthIndex: number) => new Date(Date.UTC(year, monthIndex, 1));

/** Every Mar-end / Sep-end boundary around a date, most recent first. */
function boundariesNear(at: Date): Date[] {
  const y = at.getUTCFullYear();
  const out: Date[] = [];
  for (const year of [y - 1, y, y + 1]) for (const m of BOUNDARY_MONTHS) out.push(endOfMonth(year, m));
  return out.sort((a, b) => b.getTime() - a.getTime());
}

export interface ReportingPeriod {
  /** Last day of the six-month window, as YYYY-MM-DD. This is what `reporting_period` stores. */
  end: string;
  /** First day of the window, for display and for report-time filtering. */
  start: string;
  /** "Apr–Sep 2026" / "Oct 2025–Mar 2026". */
  label: string;
}

/**
 * Describe the window that ENDS on `end` — the inverse of the rule below.
 *
 * Kept separate because a STORED `reporting_period` must label itself from what it is, not by being
 * fed back through the submission rule. Round-tripping a stored end through `reportingPeriodFor`
 * happens to agree for the current boundaries, but it would silently relabel a legacy value written
 * under the old Feb-end/Aug-end scheme as a window it never described.
 */
export function reportingPeriodFromEnd(end: Date | string): ReportingPeriod {
  const at = typeof end === 'string' ? new Date(end.length === 10 ? `${end}T12:00:00Z` : end) : end;
  if (Number.isNaN(at.getTime())) throw new Error(`reportingPeriodFromEnd: unparseable date ${String(end)}`);
  const last = endOfMonth(at.getUTCFullYear(), at.getUTCMonth());
  const start = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() - 5, 1));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const mon = (d: Date) => d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const label =
    start.getUTCFullYear() === last.getUTCFullYear()
      ? `${mon(start)}–${mon(last)} ${last.getUTCFullYear()}`
      : `${mon(start)} ${start.getUTCFullYear()}–${mon(last)} ${last.getUTCFullYear()}`;
  return { end: iso(last), start: iso(start), label };
}

/**
 * The reporting period a submission on `submittedAt` describes.
 *
 * The rule is the cadence itself: a survey is collected in the boundary month or the month after, so
 * the answer is **the latest boundary whose own month has begun**. A submission on 5 September is
 * for the window ending 30 September even though it has not closed yet; one on 25 August is for the
 * window that ended 31 March, because the April–September window is still running.
 *
 * That replaces a 21-day day-count grace, which could not reach the start of the collection month
 * and would have put an early-September survey in the wrong half-year. Deterministic either way,
 * which is what makes it safe to use as an idempotency key.
 */
export function reportingPeriodFor(submittedAt: Date | string): ReportingPeriod {
  const at = typeof submittedAt === 'string' ? new Date(submittedAt) : submittedAt;
  if (Number.isNaN(at.getTime())) throw new Error(`reportingPeriodFor: unparseable date ${String(submittedAt)}`);

  const reached = (b: Date) => startOfMonth(b.getUTCFullYear(), b.getUTCMonth()).getTime() <= at.getTime();
  const end =
    boundariesNear(at).find(reached) ??
    endOfMonth(at.getUTCFullYear() - 1, BOUNDARY_MONTHS[1]);

  return reportingPeriodFromEnd(end);
}

/**
 * `activity_name` for a metrics snapshot: "Metrics – <Company> – <Apr–Sep 2026>".
 *
 * Zach, 2026-09-10: *"Our Metric activity naming convention doesn't include the company name."* It
 * is the same three-part shape `defaultActivityName` gives every other activity type
 * ("<Type> – <Company> – <date>"), with the period label standing in for the day, because a
 * six-month window is what this record is about. The company cannot be dropped: these records are
 * read in flat lists at report time, where "Metrics – Apr–Sep 2026" identifies nobody.
 */
export function metricsActivityName(companyName: string | null | undefined, periodLabel: string): string {
  return ['Metrics', String(companyName ?? '').trim(), periodLabel].filter(Boolean).join(' – ');
}
