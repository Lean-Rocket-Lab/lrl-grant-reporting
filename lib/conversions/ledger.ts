// lib/conversions/ledger.ts — send each conversion AT MOST ONCE per channel.
//
// GHL re-delivers webhooks (retries, a workflow re-run, a manual "re-enroll"), and an analytics
// platform counts every hit it gets: a double delivery is a double conversion that never washes out.
// So each send claims `(conversion:<channel>, <conversion id>)` in the same Postgres claims ledger the
// activity adapters use (UNIQUE source + source_record_id) before it goes out.
//
//   won        → send; on `sent`, the claim is resolved and every later delivery is `already-sent`
//   existing   → already sent, skip
//   unavailable (no DATABASE_URL, i.e. local dev) → send anyway and say it was unguarded
//
// A send that does NOT go out (skipped, failed) releases its claim, so a fixed config or a retry can
// still deliver it. Dry runs never claim — a plan must not consume the idempotency key.

import { claimSourceEvent, releaseClaim, resolveClaim } from '../activities/claims';

export type Channel = 'ga4' | 'linkedin' | 'meta';

export interface LedgerOutcome<R> {
  result: R | { status: 'skipped'; reason: 'already-sent' };
  guarded: boolean;
}

export const ledgerSource = (channel: Channel) => `conversion:${channel}`;

export async function sendOnce<R extends { status: string }>(
  channel: Channel,
  conversionId: string,
  send: () => Promise<R>,
  opts: { dryRun?: boolean } = {},
): Promise<LedgerOutcome<R>> {
  if (opts.dryRun) return { result: await send(), guarded: false };
  const source = ledgerSource(channel);
  const claim = await claimSourceEvent(source, conversionId);
  if (claim.status === 'existing') return { result: { status: 'skipped', reason: 'already-sent' }, guarded: true };
  const guarded = claim.status === 'won';
  let result: R;
  try {
    result = await send();
  } catch (e) {
    if (guarded) await releaseClaim(source, conversionId);
    throw e;
  }
  if (guarded) {
    if (result.status === 'sent') await resolveClaim(source, conversionId, `sent:${new Date().toISOString()}`);
    else await releaseClaim(source, conversionId);
  }
  return { result, guarded };
}
