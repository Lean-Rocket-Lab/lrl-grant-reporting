// One stage record per company per DAY. The scorer appends per scoring EVENT on purpose, so
// multi-DAY history is correct — 31 companies legitimately have several. Two records on ONE day is
// always a bug, and it happened 8 times between 08-11 and 08-27 because both call sites did a
// check-then-act against the GHL search index, which lags a create by ~12s.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const claimSourceEvent = vi.fn();
const resolveClaim = vi.fn();
const releaseClaim = vi.fn();
const lookupClaimMock = vi.fn();
vi.mock('../../activities/claims', () => ({
  claimSourceEvent: (...a: unknown[]) => claimSourceEvent(...a),
  resolveClaim: (...a: unknown[]) => resolveClaim(...a),
  releaseClaim: (...a: unknown[]) => releaseClaim(...a),
  lookupClaim: (...a: unknown[]) => lookupClaimMock(...a),
}));

import { claimStageDay, publishStageDay, abandonStageDay, stageDayKey, STAGE_CLAIM_SOURCE } from '../stageDayClaim';

beforeEach(() => { claimSourceEvent.mockReset(); resolveClaim.mockReset(); releaseClaim.mockReset(); });

describe('stageDayKey', () => {
  it('is the company and the day, and nothing else', () => {
    expect(stageDayKey('co_1', '2026-08-26')).toBe('co_1:2026-08-26');
  });

  it('truncates a timestamp to the day, so two scores hours apart collide deliberately', () => {
    expect(stageDayKey('co_1', '2026-08-26T23:59:00.000Z')).toBe('co_1:2026-08-26');
    expect(stageDayKey('co_1', '2026-08-26T00:01:00.000Z')).toBe('co_1:2026-08-26');
  });

  it('separates days, so genuine history is never blocked', () => {
    expect(stageDayKey('co_1', '2026-08-26')).not.toBe(stageDayKey('co_1', '2026-08-27'));
  });

  it('separates companies scored on the same day', () => {
    expect(stageDayKey('co_1', '2026-08-26')).not.toBe(stageDayKey('co_2', '2026-08-26'));
  });
});

describe('claimStageDay', () => {
  it('trusts a record the search already found, without spending a claim', async () => {
    const d = await claimStageDay('co_1', '2026-08-26', 'rec_known');
    expect(d).toEqual({ action: 'update', recordId: 'rec_known' });
    expect(claimSourceEvent).not.toHaveBeenCalled();
  });

  it('creates when it wins the claim', async () => {
    claimSourceEvent.mockResolvedValue({ status: 'won' });
    expect(await claimStageDay('co_1', '2026-08-26', null)).toEqual({ action: 'create' });
    expect(claimSourceEvent).toHaveBeenCalledWith(STAGE_CLAIM_SOURCE, 'co_1:2026-08-26');
  });

  it('UPDATES the winner’s record when someone else already claimed the day', async () => {
    // This is the case that used to produce a duplicate: the search says null, but another delivery
    // has already created the record and the index has not caught up.
    claimSourceEvent.mockResolvedValue({ status: 'existing', activityRecordId: 'rec_theirs' });
    expect(await claimStageDay('co_1', '2026-08-26', null)).toEqual({ action: 'update', recordId: 'rec_theirs' });
  });

  it('still creates — and says it is degraded — with no database', async () => {
    // Same contract as activity ingestion: a missed score is worse than a rare duplicate, so the
    // absence of Postgres must not block scoring. It must be VISIBLE, though.
    claimSourceEvent.mockResolvedValue({ status: 'unavailable' });
    expect(await claimStageDay('co_1', '2026-08-26', null)).toEqual({ action: 'create', degraded: true });
  });

  it('creates when the holder claimed but never published (a crashed create)', async () => {
    // claimSourceEvent itself waits, then hands the claim over. Nothing extra to do here beyond
    // making sure a claim with no record id does not become an update to `undefined`.
    claimSourceEvent.mockResolvedValue({ status: 'existing' });
    expect(await claimStageDay('co_1', '2026-08-26', null)).toEqual({ action: 'create' });
  });
});

describe('publishStageDay / abandonStageDay', () => {
  it('publishes under the same key it claimed', async () => {
    await publishStageDay('co_1', '2026-08-26T10:00:00Z', 'rec_new');
    expect(resolveClaim).toHaveBeenCalledWith(STAGE_CLAIM_SOURCE, 'co_1:2026-08-26', 'rec_new');
  });

  it('releases the same key, so a failed create retries instead of stalling', async () => {
    await abandonStageDay('co_1', '2026-08-26');
    expect(releaseClaim).toHaveBeenCalledWith(STAGE_CLAIM_SOURCE, 'co_1:2026-08-26');
  });
});

// ── the gate-bypass window ────────────────────────────────────────────────────────────────────────
// The scorer consults its input-hash gate only when it can SEE today's record. That check used the
// GHL search index alone, which lags a create by ~12s — so every webhook delivery inside that window
// found no record, skipped the gate, and ran a full AI re-score.
//
// Measured on Aiden Brunin's intake 2026-09-09: four scoring calls in 21 seconds, MRL flip-flopping
// 7 → 6 → 7 → 7, Churchill 3 → 3 → 2 → 2. One score, three different values across the stage record,
// the company, and the email sent to the client.

import { todayStageRecordId } from '../stageDayClaim';

describe('todayStageRecordId — the immediately-consistent answer', () => {
  it('returns the claimed record id for the company+day', async () => {
    lookupClaimMock.mockReset();
    lookupClaimMock.mockResolvedValue('rec_today');
    expect(await todayStageRecordId('co_1', '2026-09-09')).toBe('rec_today');
    expect(lookupClaimMock).toHaveBeenCalledWith(STAGE_CLAIM_SOURCE, 'co_1:2026-09-09');
  });

  it('returns null when nothing has been claimed, so a first score still runs', async () => {
    lookupClaimMock.mockReset();
    lookupClaimMock.mockResolvedValue(null);
    expect(await todayStageRecordId('co_1', '2026-09-09')).toBeNull();
  });

  it('asks under the SAME key the claim was written with', async () => {
    // A key mismatch here would silently reopen the window: the gate would never see the record.
    expect(stageDayKey('co_1', '2026-09-09T18:00:00Z')).toBe('co_1:2026-09-09');
  });
});
