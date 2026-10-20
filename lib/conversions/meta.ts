// lib/conversions/meta.ts — send a server-side conversion to Meta's Conversions API (CAPI).
//
// Meta's browser Pixel (loaded from GTM, PageView only) is the eyewitness: it cookies the visitor
// and ties the browser to the ad click. THIS is the clerk: it reports that a form was actually filed
// or a meeting actually booked, with the contact's hashed email/phone, from the server. Each
// conversion is reported from exactly ONE side, so nothing here needs browser-side deduplication —
// do not add `fbq('track','Lead')` tags in GTM for the same events, or Meta counts them twice.
//
// Config (all three environments):
//   META_PIXEL_ID        the Dataset ("Pixel") id — Events Manager > Data sources > Settings
//   META_CAPI_TOKEN      Conversions API access token generated on that same Settings page
//   META_API_VERSION     optional Graph API version, default v21.0
//   META_TEST_EVENT_CODE optional; when set, a DRY RUN really sends, tagged as a Test Event, which
//                        shows in Events Manager > Test Events without counting. Leave unset in prod.
// Unset = `skipped / not-configured`, never a throw.
//
// Matching keys, best → worst: fbc (built from the landing URL's `fbclid`) · fbp (browser cookie —
// GHL does not store it, so usually absent) · SHA-256 email · SHA-256 phone · IP + user agent, which
// GHL's attribution record does carry. Email/phone are normalised exactly as Meta specifies before
// hashing (lowercase trimmed email; digits-only E.164 phone). Nothing is ever sent unhashed except
// IP/UA, which Meta requires raw.

import { createHash } from 'node:crypto';

export type MetaEventName = 'Lead' | 'Schedule' | 'CompleteRegistration' | 'Purchase' | (string & {});

export interface MetaConversion {
  eventName: MetaEventName;
  /** Stable id for this conversion; Meta de-duplicates on (event_name, event_id). */
  eventId: string;
  occurredAt?: Date;
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  /** The page the conversion happened on (the stored attribution URL is the best we have). */
  sourceUrl?: string | null;
  /** Raw `fbclid` from the landing URL; becomes `fbc`. */
  fbclid?: string | null;
  /** Landing time, for the `fbc` timestamp. Defaults to occurredAt. */
  clickedAt?: Date | null;
  clientIp?: string | null;
  userAgent?: string | null;
  value?: { amount: number; currencyCode: string } | null;
  customData?: Record<string, string | number | undefined | null>;
}

export interface MetaResult {
  status: 'sent' | 'planned' | 'skipped' | 'failed';
  reason?: 'not-configured' | 'no-identifier' | 'unauthorized' | 'http-error';
  detail?: string;
  /** How many identifiers were attached (match quality proxy). */
  matchKeys?: string[];
  /** Set when a dry run was really delivered as a Test Event. */
  testEventCode?: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const hashEmail = (email: string) => sha(email.trim().toLowerCase());

/** `+1 (517) 555-0100` → sha256(`15175550100`). A 10-digit US number gets the `1`. */
export function normalizePhone(phone: string | null | undefined): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.length === 10 ? `1${digits}` : digits;
}
export const hashPhone = (phone: string) => { const n = normalizePhone(phone); return n ? sha(n) : null; };

/** `fbclid` from a landing URL, if any. */
export function fbclidFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).searchParams.get('fbclid') || null; } catch {
    const m = String(url).match(/[?&]fbclid=([^&#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
}

/** Meta's `fbc` format: `fb.1.<click time ms>.<fbclid>` (subdomain index 1 = leanrocketlab.org). */
export function buildFbc(fbclid: string, clickedAt: Date): string {
  return `fb.1.${clickedAt.getTime()}.${fbclid}`;
}

export function metaConfigured(): boolean {
  return Boolean(process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN);
}

/** The CAPI request body. Exported for tests — the shape is the contract. */
export function buildMetaBody(c: MetaConversion): { body: Record<string, unknown>; matchKeys: string[] } {
  const when = c.occurredAt ?? new Date();
  const user: Record<string, unknown> = {};
  const matchKeys: string[] = [];
  if (c.email) { user.em = [hashEmail(c.email)]; matchKeys.push('em'); }
  const ph = c.phone ? hashPhone(c.phone) : null;
  if (ph) { user.ph = [ph]; matchKeys.push('ph'); }
  if (c.firstName) { user.fn = [sha(c.firstName.trim().toLowerCase())]; matchKeys.push('fn'); }
  if (c.lastName) { user.ln = [sha(c.lastName.trim().toLowerCase())]; matchKeys.push('ln'); }
  if (c.fbclid) { user.fbc = buildFbc(c.fbclid, c.clickedAt ?? when); matchKeys.push('fbc'); }
  if (c.clientIp) { user.client_ip_address = c.clientIp; matchKeys.push('ip'); }
  if (c.userAgent) { user.client_user_agent = c.userAgent; matchKeys.push('ua'); }

  const custom: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(c.customData ?? {})) if (v !== undefined && v !== null && v !== '') custom[k] = v;
  if (c.value && c.value.amount > 0) { custom.value = c.value.amount; custom.currency = c.value.currencyCode; }

  const event: Record<string, unknown> = {
    event_name: c.eventName,
    event_time: Math.floor(when.getTime() / 1000),
    event_id: c.eventId,
    action_source: 'website',
    user_data: user,
  };
  if (c.sourceUrl) event.event_source_url = c.sourceUrl;
  if (Object.keys(custom).length) event.custom_data = custom;
  return { body: { data: [event] }, matchKeys };
}

const MAX_AGE_MS = 7 * 24 * 3600 * 1000; // Meta rejects events older than 7 days

export async function sendMetaConversion(
  c: MetaConversion,
  opts: { dryRun?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<MetaResult> {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) return { status: 'skipped', reason: 'not-configured', detail: 'META_PIXEL_ID / META_CAPI_TOKEN unset' };
  const { body, matchKeys } = buildMetaBody(c);
  // IP+UA alone is too weak to be worth a send; Meta would accept it and match almost nothing.
  if (!matchKeys.some((k) => ['em', 'ph', 'fbc'].includes(k))) {
    return { status: 'skipped', reason: 'no-identifier', detail: 'no email, phone, or fbclid to match on', matchKeys };
  }
  if (c.occurredAt && Date.now() - c.occurredAt.getTime() > MAX_AGE_MS) {
    return { status: 'failed', reason: 'http-error', detail: 'Meta rejects Conversions API events older than 7 days', matchKeys };
  }
  const testCode = process.env.META_TEST_EVENT_CODE;
  if (opts.dryRun && !testCode) {
    return { status: 'planned', detail: `would send ${c.eventName} matched on ${matchKeys.join(' + ')}`, matchKeys };
  }
  if (opts.dryRun && testCode) (body as any).test_event_code = testCode;

  const version = process.env.META_API_VERSION || 'v21.0';
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`https://graph.facebook.com/${version}/${encodeURIComponent(pixelId)}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
  });
  if (res.status === 401 || res.status === 403) {
    return { status: 'failed', reason: 'unauthorized', detail: `${res.status} — token expired/revoked or lacks ads_management: ${await res.text().catch(() => '')}`, matchKeys };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Meta reports a bad token as 400 with error.code 190, not 401. Surface it the same way.
    const unauthorized = /"code"\s*:\s*190\b/.test(text);
    return { status: 'failed', reason: unauthorized ? 'unauthorized' : 'http-error', detail: `${res.status} ${text}`, matchKeys };
  }
  return opts.dryRun ? { status: 'planned', detail: `delivered as Test Event ${testCode}`, matchKeys, testEventCode: testCode } : { status: 'sent', matchKeys };
}
