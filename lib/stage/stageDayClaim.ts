// lib/stage/stageDayClaim.ts — mutual exclusion for "one stage record per company per DAY".
//
// THE RACE, measured on live 2026-09-04: the Client Stage Tracking object held **8 company+day pairs
// with more than one record** (CP Design had three on 2026-08-26), scattered across 08-11 → 08-27.
// The scorer appends a new record per scoring EVENT by design — multi-day history is correct, and 31
// companies legitimately have several — but two records for one company on ONE day is always a bug.
//
// WHY IT HAPPENED. Both call sites do a check-then-act with nothing in between:
//
//     const ctx = await getCompanyStageContext(companyId, today)   // → todayRecordId: null
//     …
//     await createStageRecord(...)                                  // ← two callers both get here
//
// `getCompanyStageContext` resolves `todayRecordId` through the GHL records SEARCH, which is
// **~12 seconds behind a create** (measured 2026-08-19, the same lag that made activity ingestion
// duplicate). Two scoring events for one company inside that window both read null and both create.
// The webhook path is where this bites: it fires on a contact/company change, and a burst of edits
// to one company delivers several times in seconds. The nightly is sequential per company and never
// raced itself, which is why the duplicate dates look scattered rather than nightly.
//
// THE FIX is the one that already works for activities: claim the (company, day) pair in Postgres —
// immediately consistent, unlike the GHL index — under the existing UNIQUE (source, source_record_id).
// `onConflictDoNothing` IS the mutual exclusion; exactly one caller creates and the rest update the
// winner's record. No new table, and the same degradation contract as `lib/activities/claims.ts`:
// with no database this reports `unavailable` and the caller keeps its old behaviour rather than
// blocking, because a missed score is worse than a rare duplicate.

import { claimSourceEvent, resolveClaim, releaseClaim } from '../activities/claims';

/**
 * The claim `source` for stage scoring.
 *
 * ⚠️ Deliberately NOT one of the activity source labels. It shares the table, not the namespace —
 * `<companyId>:<day>` could never collide with an activity's key in practice, but relying on that
 * would be relying on an accident.
 */
export const STAGE_CLAIM_SOURCE = 'Client Stage';

/** One company, one day. The whole identity of a scoring snapshot. */
export const stageDayKey = (companyId: string, day: string) => `${companyId}:${day.slice(0, 10)}`;

export interface StageDayClaim {
  /** 'create' = you won, create the record then call `publishStageDay`. */
  action: 'create' | 'update';
  /** Set when action is 'update' — the record to overwrite instead of creating a second one. */
  recordId?: string;
  /** True when no database was available, so exclusion was not actually enforced. */
  degraded?: boolean;
}

/**
 * Decide whether to create today's stage record or overwrite one that already exists.
 *
 * `knownRecordId` is `getCompanyStageContext`'s `todayRecordId`. When the search index has already
 * caught up it is authoritative and no claim is needed — the record is visibly there. The claim only
 * covers the window where it is NOT yet visible, which is exactly where the duplicates came from.
 */
export async function claimStageDay(
  companyId: string,
  day: string,
  knownRecordId?: string | null,
): Promise<StageDayClaim> {
  if (knownRecordId) return { action: 'update', recordId: knownRecordId };

  const claim = await claimSourceEvent(STAGE_CLAIM_SOURCE, stageDayKey(companyId, day));
  if (claim.status === 'existing' && claim.activityRecordId) {
    return { action: 'update', recordId: claim.activityRecordId };
  }
  // 'won' → ours to create. 'unavailable' → no DB; create as before and say so.
  return { action: 'create', ...(claim.status === 'unavailable' ? { degraded: true } : {}) };
}

/** Publish the record id so a concurrent caller updates it instead of creating a second one. */
export async function publishStageDay(companyId: string, day: string, recordId: string): Promise<void> {
  await resolveClaim(STAGE_CLAIM_SOURCE, stageDayKey(companyId, day), recordId);
}

/**
 * Give the claim back when the create FAILED, so the next delivery can try.
 *
 * Without this a company whose create threw — a 500, a bad option value — would hold an unresolved
 * claim forever, and every later attempt would wait out the 4s window and then take it over anyway.
 * Releasing turns a permanent stall into an immediate retry.
 */
export async function abandonStageDay(companyId: string, day: string): Promise<void> {
  await releaseClaim(STAGE_CLAIM_SOURCE, stageDayKey(companyId, day));
}
