// lib/conversions/ga4.ts — send a server-side conversion to GA4 via the Measurement Protocol.
//
// WHY SERVER-SIDE: GHL Events pages accept no tracking code (only a Meta Pixel ID), so GA4 never sees
// an event registration happen in the browser. The registration is reported from here instead, keyed
// to the visitor's GA client id, which GHL stores on the contact (`lastAttributionSource.gaClientId`,
// verified live 2026-10-19). With the client id, GA4 ties the conversion to the same user it already
// saw browsing the Wix site and the apply./go. funnels.
//
// Config (all three environments: .env.local, Vercel, GitHub secrets):
//   GA4_MEASUREMENT_ID   G-4WMKNE5XEZ (the "LRL Website" stream)
//   GA4_API_SECRET       GA4 Admin > Data streams > LRL Website > Measurement Protocol API secrets
// Unset = every send reports `skipped / not-configured`. Never a throw: a missing analytics secret
// must not break the activity ingestion it rides along with.
//
// Rules that are easy to get wrong:
//   • GHL stores the raw cookie value `GA1.1.1664579354.1792433630`. GA4 wants `1664579354.1792433630`.
//   • No client id → DO NOT invent one. A random id is a fake user in GA4 forever. Skip and say so.
//   • No personal data in params. GA4's terms forbid it, and nothing here needs it.
//   • The MP endpoint returns 2xx even for a malformed hit. A dry run uses the /debug endpoint, which
//     returns validation messages instead of recording anything — that is the only real check.

export interface Ga4Hit {
  /** Raw or normalized GA client id. */
  clientId: string | null | undefined;
  /** GA session id, when GHL captured one (often null). Improves session attribution when present. */
  sessionId?: string | number | null;
  /** GA4 event name, e.g. 'event_registration'. Snake case, ≤40 chars. */
  name: string;
  params?: Record<string, string | number | undefined | null>;
  /** When it happened. Defaults to now; GA4 accepts up to 72h in the past. */
  occurredAt?: Date;
}

export type Ga4Status = 'sent' | 'validated' | 'skipped' | 'failed';
export interface Ga4Result {
  status: Ga4Status;
  reason?: 'not-configured' | 'no-client-id' | 'too-old' | 'http-error' | 'validation-error';
  detail?: string;
  clientId?: string;
  /** Validation messages from the /debug endpoint, on a dry run. */
  validation?: unknown[];
}

const GA_COOKIE = /^GA\d\.\d\.(\d+\.\d+)$/;
const BARE_ID = /^\d+\.\d+$/;

/** `GA1.1.123.456` → `123.456`. Already-bare ids pass through. Anything else → null. */
export function normalizeGaClientId(raw: string | null | undefined): string | null {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  const m = v.match(GA_COOKIE);
  if (m) return m[1];
  return BARE_ID.test(v) ? v : null;
}

export function ga4Configured(): boolean {
  return Boolean(process.env.GA4_MEASUREMENT_ID && process.env.GA4_API_SECRET);
}

/** The MP request body. Exported for tests — the shape is the contract. */
export function buildGa4Body(hit: Ga4Hit, clientId: string) {
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(hit.params ?? {})) if (v !== undefined && v !== null && v !== '') params[k] = v;
  // Without engagement_time_msec GA4 can drop the event from realtime and engagement reports.
  if (params.engagement_time_msec === undefined) params.engagement_time_msec = 1;
  const sid = hit.sessionId == null ? '' : String(hit.sessionId).trim();
  if (sid) params.session_id = sid;
  const body: Record<string, unknown> = { client_id: clientId, events: [{ name: hit.name, params }] };
  if (hit.occurredAt) body.timestamp_micros = hit.occurredAt.getTime() * 1000;
  return body;
}

const MAX_AGE_MS = 72 * 3600 * 1000;

export async function sendGa4Event(
  hit: Ga4Hit,
  opts: { dryRun?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<Ga4Result> {
  if (!ga4Configured()) return { status: 'skipped', reason: 'not-configured', detail: 'GA4_MEASUREMENT_ID / GA4_API_SECRET unset' };
  const clientId = normalizeGaClientId(hit.clientId);
  if (!clientId) {
    return { status: 'skipped', reason: 'no-client-id', detail: hit.clientId ? `unrecognised GA client id "${hit.clientId}"` : 'contact has no GA client id (never browsed a tagged page)' };
  }
  // GA4 silently discards hits older than 72h. Say so rather than "send" into the void (a backfill).
  if (hit.occurredAt && Date.now() - hit.occurredAt.getTime() > MAX_AGE_MS) {
    return { status: 'skipped', reason: 'too-old', clientId, detail: 'GA4 rejects Measurement Protocol events older than 72 hours' };
  }
  const f = opts.fetchImpl ?? fetch;
  const qs = `measurement_id=${encodeURIComponent(process.env.GA4_MEASUREMENT_ID!)}&api_secret=${encodeURIComponent(process.env.GA4_API_SECRET!)}`;
  const base = opts.dryRun ? 'https://www.google-analytics.com/debug/mp/collect' : 'https://www.google-analytics.com/mp/collect';
  const res = await f(`${base}?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGa4Body(hit, clientId)),
  });
  if (!res.ok) {
    // Full body, always — a truncated error is how a contract hides for weeks.
    return { status: 'failed', reason: 'http-error', clientId, detail: `${res.status} ${await res.text().catch(() => '')}` };
  }
  if (opts.dryRun) {
    const j: any = await res.json().catch(() => ({}));
    const msgs: unknown[] = j?.validationMessages ?? [];
    return msgs.length
      ? { status: 'failed', reason: 'validation-error', clientId, validation: msgs, detail: JSON.stringify(msgs) }
      : { status: 'validated', clientId, validation: [] };
  }
  return { status: 'sent', clientId };
}
