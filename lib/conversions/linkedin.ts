// lib/conversions/linkedin.ts — send a server-side conversion to LinkedIn's Conversions API (CAPI).
//
// Used for conversions that have no page to fire the Insight Tag on — GHL Events registrations first.
// The site-side conversions ("Lead: Form Submitted" on `/submitted`, "Lead: Booked Appointment" on
// `/booked`) stay on the Insight Tag; do not duplicate them here or LinkedIn counts them twice.
//
// Config (all three environments):
//   LINKEDIN_CAPI_TOKEN          OAuth access token with the `rw_conversions` scope
//   LINKEDIN_EVENT_CONVERSION_ID numeric id of the "Event Registration" conversion
//                                (Campaign Manager > Conversion tracking > Create > Conversions API)
//   LINKEDIN_API_VERSION         optional, YYYYMM. LinkedIn retires versions after ~12 months.
// Unset = `skipped / not-configured`, never a throw.
//
// ⚠️ TOKENS EXPIRE (60 days for a standard member token). A 401 here is almost always expiry, and is
// reported as `failed / unauthorized` so it surfaces rather than silently stopping attribution.
//
// Matching: SHA-256 of the trimmed, lowercased email (LinkedIn's required normalization), plus the
// first-party click id `li_fat_id` when the contact's attribution URL carries one (an ad click with
// enhanced conversion tracking on). Names are sent unhashed in `userInfo`, as the API specifies.

import { createHash } from 'node:crypto';

export interface LinkedInConversion {
  conversionId?: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  /** LinkedIn first-party click id, from the landing URL's `li_fat_id` param. */
  liFatId?: string | null;
  occurredAt?: Date;
  /** Stable id for this conversion. LinkedIn de-duplicates on it (and against the Insight Tag). */
  eventId: string;
  value?: { amount: number; currencyCode: string } | null;
}

export interface LinkedInResult {
  status: 'sent' | 'planned' | 'skipped' | 'failed';
  reason?: 'not-configured' | 'no-identifier' | 'unauthorized' | 'http-error';
  detail?: string;
}

export const sha256Email = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

/** `li_fat_id` from a landing URL, if any. */
export function liFatIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).searchParams.get('li_fat_id') || null;
  } catch {
    const m = String(url).match(/[?&]li_fat_id=([^&#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
}

export function buildLinkedInBody(c: LinkedInConversion, conversionId: string) {
  const userIds: Array<{ idType: string; idValue: string }> = [];
  if (c.email) userIds.push({ idType: 'SHA256_EMAIL', idValue: sha256Email(c.email) });
  if (c.liFatId) userIds.push({ idType: 'LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID', idValue: c.liFatId });
  const user: Record<string, unknown> = { userIds };
  if (c.firstName || c.lastName) user.userInfo = { firstName: c.firstName ?? '', lastName: c.lastName ?? '' };
  const body: Record<string, unknown> = {
    conversion: `urn:lla:llaPartnerConversion:${conversionId}`,
    conversionHappenedAt: (c.occurredAt ?? new Date()).getTime(),
    user,
    eventId: c.eventId,
  };
  if (c.value && c.value.amount > 0) body.conversionValue = { currencyCode: c.value.currencyCode, amount: String(c.value.amount) };
  return body;
}

export async function sendLinkedInConversion(
  c: LinkedInConversion,
  opts: { dryRun?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<LinkedInResult> {
  const token = process.env.LINKEDIN_CAPI_TOKEN;
  const conversionId = c.conversionId ?? process.env.LINKEDIN_EVENT_CONVERSION_ID;
  if (!token || !conversionId) return { status: 'skipped', reason: 'not-configured', detail: 'LINKEDIN_CAPI_TOKEN / LINKEDIN_EVENT_CONVERSION_ID unset' };
  if (!c.email && !c.liFatId) return { status: 'skipped', reason: 'no-identifier', detail: 'no email and no li_fat_id to match on' };
  const body = buildLinkedInBody(c, conversionId);
  // LinkedIn has no validate-only endpoint, so a dry run plans and stops.
  if (opts.dryRun) return { status: 'planned', detail: `would send ${body.conversion} matched on ${(body.user as any).userIds.map((u: any) => u.idType).join(' + ')}` };
  const f = opts.fetchImpl ?? fetch;
  const res = await f('https://api.linkedin.com/rest/conversionEvents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'LinkedIn-Version': process.env.LINKEDIN_API_VERSION || '202509',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401) return { status: 'failed', reason: 'unauthorized', detail: `401 — token expired or lacks rw_conversions: ${await res.text().catch(() => '')}` };
  if (!res.ok) return { status: 'failed', reason: 'http-error', detail: `${res.status} ${await res.text().catch(() => '')}` };
  return { status: 'sent' };
}
