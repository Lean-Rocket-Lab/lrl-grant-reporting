// lib/conversions/site.ts — a site conversion (form submitted, meeting booked) reported server-side
// to GA4, LinkedIn and Meta, at most once per channel.
//
// WHY SERVER-SIDE (decided 2026-10-20): GTM fires these today from the `/submitted` and `/booked`
// confirmation pages. That counts only browsers that run the tags; Safari cookie limits and ad
// blockers remove a share that only grows, and Meta in particular matches poorly on cookies alone.
// GHL knows the submission for certain and holds the email and phone, so it is the better-informed
// reporter. The browser tags remain for what only they can do — cookie the visitor and send page
// views — see docs/sprints/form-booking-conversions.md.
//
// Modes (CONVERSION_SYNC_MODE):
//   shadow  (default) resolve everything, VALIDATE the GA4 hit on the debug endpoint, plan LinkedIn
//           and Meta, send nothing, log one `[conversion-sync] shadow` line per conversion. This is
//           the two-week side-by-side against the GTM counts — with zero double counting.
//   live    send. Flip the same day the two GTM URL-rule tags are paused, never before.
//
// Identity (= the dedupe key on every channel; choose once, never change):
//   meeting_booked  appt:<appointmentId>
//   form_submitted  form:<contactId>:<formId|formName|form>:<UTC hour>   (GHL's Form Submitted
//                   payload carries no submission id; a re-delivered webhook within the hour
//                   converges, a real resubmission a day later counts)
//   either          an explicit `conversionKey` in the webhook's Custom Data wins.
//
// No Activity is created here (Zach, 10-20: "only ad conversions for now"). Submissions and
// appointments already live in GHL; the Activities object stays for grant KPIs.

import { ghl, type GhlClient } from '../ghl/client';
import { getContact } from '../ghl/contacts';
import { sendGa4Event, gaClientIdFromLinker, gaSessionIdFromLinker, type Ga4Result } from './ga4';
import { sendLinkedInConversion, liFatIdFromUrl, type LinkedInResult } from './linkedin';
import { sendMetaConversion, fbclidFromUrl, type MetaResult } from './meta';
import { sendOnce, type Channel } from './ledger';

export type SiteConversionType = 'form_submitted' | 'meeting_booked';

export const SITE_CONVERSION_TYPES: readonly SiteConversionType[] = ['form_submitted', 'meeting_booked'];

/** Per-type platform names. GA4 names are the existing key events; Meta's are standard events. */
export const CHANNEL_EVENTS: Record<SiteConversionType, { ga4: string; meta: 'Lead' | 'Schedule'; linkedinEnv: string }> = {
  form_submitted: { ga4: 'form_submitted', meta: 'Lead', linkedinEnv: 'LINKEDIN_FORM_CONVERSION_ID' },
  meeting_booked: { ga4: 'meeting_booked', meta: 'Schedule', linkedinEnv: 'LINKEDIN_BOOKING_CONVERSION_ID' },
};

export interface SiteConversionInput {
  type: SiteConversionType;
  contactId: string;
  /** GHL appointment id (meeting_booked). */
  appointmentId?: string;
  /** GHL form id or name (form_submitted). */
  formId?: string;
  formName?: string;
  /** Explicit dedupe key from Custom Data; overrides the derived one. */
  conversionKey?: string;
  occurredAt?: Date;
}

export interface SiteConversionOptions {
  dryRun?: boolean;
  mode?: 'shadow' | 'live';
  channels?: Channel[];
  client?: GhlClient;
  fetchImpl?: typeof fetch;
}

export interface SiteConversionResult {
  type: SiteConversionType;
  contactId: string;
  key?: string;
  mode: 'shadow' | 'live';
  status: 'reported' | 'skipped';
  reason?: 'no-key' | 'no-contact';
  detail?: string;
  /** What the contact's attribution record offered, for the log line and the operator. */
  identifiers?: { gaClientId: boolean; gaSessionId: boolean; liFatId: boolean; fbclid: boolean; email: boolean; phone: boolean; utmSource?: string | null; utmCampaign?: string | null; formId?: string | null };
  conversions?: {
    ga4?: Ga4Result | { status: 'skipped'; reason: 'already-sent' | 'channel-off' };
    linkedin?: LinkedInResult | { status: 'skipped'; reason: 'already-sent' | 'channel-off' };
    meta?: MetaResult | { status: 'skipped'; reason: 'already-sent' | 'channel-off' };
  };
}

export function conversionMode(): 'shadow' | 'live' {
  return process.env.CONVERSION_SYNC_MODE === 'live' ? 'live' : 'shadow';
}

/** Channels on, from CONVERSION_SYNC_CHANNELS (default all three). Unknown names are ignored. */
export function conversionChannels(raw = process.env.CONVERSION_SYNC_CHANNELS): Channel[] {
  const all: Channel[] = ['ga4', 'linkedin', 'meta'];
  if (!raw) return all;
  const picked = raw.split(',').map((s) => s.trim().toLowerCase()).filter((s): s is Channel => (all as string[]).includes(s));
  return picked.length ? picked : all;
}

const hourBucket = (d: Date) => d.toISOString().slice(0, 13); // 2026-10-20T19

/** The conversion's identity. Null when nothing stable can be derived. */
export function siteConversionKey(input: SiteConversionInput, now: Date = new Date()): string | null {
  const explicit = (input.conversionKey ?? '').trim();
  if (explicit) return explicit;
  if (input.type === 'meeting_booked') {
    return input.appointmentId ? `appt:${input.appointmentId}` : null;
  }
  const form = (input.formId || input.formName || 'form').trim().replace(/\s+/g, '-').slice(0, 60);
  return `form:${input.contactId}:${form}:${hourBucket(input.occurredAt ?? now)}`;
}

const GHL_ID = /^[A-Za-z0-9]{15,30}$/;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Pull the input out of GHL's standard payload (top-level contact fields + `customData`) and the query. */
export function extractConversionPayload(body: any, query: Record<string, unknown>): Partial<SiteConversionInput> & { via?: string } {
  const b = body && typeof body === 'object' ? body : {};
  const cd = b.customData && typeof b.customData === 'object' ? b.customData : {};
  const rawType = str(query.type) ?? str(cd.type) ?? str(b.type);
  const type = (SITE_CONVERSION_TYPES as readonly string[]).includes(rawType ?? '') ? (rawType as SiteConversionType) : undefined;

  let contactId: string | undefined; let via: string | undefined;
  for (const [path, v] of [['customData.contactId', cd.contactId], ['contact_id', b.contact_id], ['contactId', b.contactId], ['contact.id', b.contact?.id], ['id', b.id]] as const) {
    if (typeof v === 'string' && GHL_ID.test(v)) { contactId = v; via = path; break; }
  }
  if (!contactId && typeof query.contactId === 'string' && GHL_ID.test(query.contactId)) { contactId = query.contactId; via = 'query'; }

  const appointmentId = [cd.appointmentId, cd.appointment_id, b.appointmentId, b.appointment?.id, b.calendar?.appointmentId, b.calendar?.id, query.appointmentId]
    .map(str).find((v) => v && GHL_ID.test(v));
  const formId = [cd.formId, cd.form_id, b.formId, b.form_id, b.form?.id, query.formId].map(str).find(Boolean);
  // One workflow can carry both the Form Submitted and Survey Submitted triggers; GHL leaves the
  // merge field that does not apply blank, so take whichever label arrived.
  const formName = [cd.formName, cd.form_name, cd.surveyName, cd.survey_name, b.formName, b.form?.name, b.surveyName, b.survey?.name, query.formName, query.surveyName].map(str).find(Boolean);
  const conversionKey = [cd.conversionKey, b.conversionKey, query.conversionKey].map(str).find(Boolean);
  return { type, contactId, appointmentId, formId, formName, conversionKey, via };
}

export async function reportSiteConversion(
  input: SiteConversionInput,
  opts: SiteConversionOptions = {},
): Promise<SiteConversionResult> {
  const mode = opts.mode ?? conversionMode();
  const base = { type: input.type, contactId: input.contactId, mode };
  // meeting_booked can be refused before the contact fetch; form_submitted may still learn its form
  // id from the contact's attribution record below, so its key is derived after.
  if (input.type === 'meeting_booked' && !siteConversionKey(input)) {
    return { ...base, status: 'skipped', reason: 'no-key', detail: 'meeting_booked needs an appointmentId (send {"appointmentId":"{{appointment.id}}"} in Custom Data)' };
  }

  const client = opts.client ?? ghl();
  const contact: any = await getContact(input.contactId, client).catch(() => null);
  if (!contact) return { ...base, key: siteConversionKey(input) ?? undefined, status: 'skipped', reason: 'no-contact' };

  const attr: any = contact.lastAttribution ?? contact.firstAttribution ?? {};
  // WHICH FORM: GHL's Form Submitted webhook carries no form id (measured 2026-10-20: `triggerData`
  // is `{}`), but the contact's Latest Attribution does — `medium: "form"`, `mediumId: <form id>`
  // (the popup's "Medium Id"). Same for surveys. Use it when the webhook supplied nothing, so the key
  // distinguishes forms and GA4 gets a label.
  const attributedForm = input.type === 'form_submitted' && !input.formId && !input.formName && /^(form|survey)$/i.test(String(attr.medium ?? '')) && attr.mediumId
    ? String(attr.mediumId)
    : undefined;
  if (attributedForm) input = { ...input, formId: attributedForm };
  const key = siteConversionKey(input);
  if (!key) return { ...base, status: 'skipped', reason: 'no-key' };
  const first: any = contact.firstAttribution ?? {};
  const url: string | null = attr.url ?? null;
  const occurredAt = input.occurredAt ?? new Date();
  const gaClientId = attr.gaClientId || gaClientIdFromLinker(url) || gaClientIdFromLinker(first.url) || null;
  const gaSessionId = attr.gaSessionId || gaSessionIdFromLinker(url) || null;
  const liFatId = liFatIdFromUrl(url);
  const fbclid = fbclidFromUrl(url) ?? fbclidFromUrl(first.url);
  const identifiers = {
    gaClientId: Boolean(gaClientId), gaSessionId: Boolean(gaSessionId), liFatId: Boolean(liFatId), fbclid: Boolean(fbclid),
    email: Boolean(contact.email), phone: Boolean(contact.phone),
    utmSource: attr.utmSource ?? null, utmCampaign: attr.campaign ?? null, formId: input.formId ?? null,
  };

  // Shadow mode is a dry run on every channel, plus the log line that IS the shadow count.
  const dryRun = Boolean(opts.dryRun) || mode === 'shadow';
  const channels = opts.channels ?? conversionChannels();
  const on = (c: Channel) => channels.includes(c);
  const names = CHANNEL_EVENTS[input.type];
  const fetchImpl = opts.fetchImpl;
  const off = { status: 'skipped' as const, reason: 'channel-off' as const };

  const [ga4, linkedin, meta] = await Promise.all([
    on('ga4')
      ? sendOnce('ga4', key, () => sendGa4Event({
          clientId: gaClientId,
          sessionId: gaSessionId,
          name: names.ga4,
          occurredAt,
          // No personal data: which form / which conversion type only.
          params: { lrl_conversion: input.type, lrl_form: (input.formName ?? input.formId ?? undefined)?.slice(0, 100), lrl_reporter: 'server' },
        }, { dryRun, fetchImpl }), { dryRun }).then((o) => o.result)
      : Promise.resolve(off),
    on('linkedin')
      ? sendOnce('linkedin', key, () => sendLinkedInConversion({
          conversionId: process.env[names.linkedinEnv],
          email: contact.email,
          firstName: contact.firstName,
          lastName: contact.lastName,
          liFatId,
          occurredAt,
          eventId: key,
        }, { dryRun, fetchImpl }), { dryRun }).then((o) => o.result)
      : Promise.resolve(off),
    on('meta')
      ? sendOnce('meta', key, () => sendMetaConversion({
          eventName: names.meta,
          eventId: key,
          occurredAt,
          email: contact.email,
          phone: contact.phone,
          firstName: contact.firstName,
          lastName: contact.lastName,
          sourceUrl: url,
          fbclid,
          clientIp: attr.ip ?? attr.ipAddress ?? null,
          userAgent: attr.userAgent ?? attr.user_agent ?? null,
          customData: { content_name: input.formName ?? input.formId ?? input.type },
        }, { dryRun, fetchImpl }), { dryRun }).then((o) => o.result)
      : Promise.resolve(off),
  ]);

  const result: SiteConversionResult = { ...base, key, status: 'reported', identifiers, conversions: { ga4, linkedin, meta } };
  if (mode === 'shadow' && !opts.dryRun) {
    // The shadow ledger: one line per conversion the server WOULD have reported. Compare its count
    // with GTM's platform counts over the same window before flipping to live.
    console.log('[conversion-sync] shadow', JSON.stringify({ type: input.type, key, contactId: input.contactId, identifiers, ga4: ga4.status, linkedin: linkedin.status, meta: meta.status }));
  }
  return result;
}
