// lib/activities/sources/eventRegistration.ts — a GHL Events registration → a Workshop / Event
// activity, plus server-side conversions to GA4 and LinkedIn.
//
// WHY THIS EXISTS (2026-10-19). LRL moved ticketing and RSVPs from Wix Events to GHL Events. Nothing
// ingested GHL registrations, so they reached neither the Activities object (grant reporting: TC KPI
// 3 and KPI 8 count event attendance) nor any ad platform. GHL Events pages accept no tracking code —
// only a Meta Pixel ID — so the conversion cannot fire in the browser. It is reported from here.
//
// Wired from the GHL workflow "Event Conversion Tracking":
//   trigger  Event Registration Status = Succeeded (all events)
//   action   Webhook POST https://lrl-grant-reporting.vercel.app/api/event-registration-sync
//            header x-webhook-secret: <WIX_SYNC_WEBHOOK_SECRET>
//            Custom Data  eventId / eventName / eventStart  ← the trigger's event merge fields
// ⚠️ GHL sends its STANDARD payload, not a hand-written JSON body (PROJECT_STATE, 2026-09-02 gotcha):
// the contact arrives as `contact_id`, and Custom Data key/values arrive under `customData`. That is
// why `extractEventPayload` reads `customData.*` first. If the event id still doesn't arrive, the
// route logs the payload's event-ish keys to Vercel so the real shape can be read off one delivery.
//
// IDENTITY: `(GHL Event, <eventId>:<contactId>)` — one ticket per person per event. The SAME key is the
// conversion id on every channel, so a re-delivered webhook is a `noop` activity AND `already-sent`
// conversions. Choose once, never change: changing it re-sends every past registration.
//
// Follows the Wix phase-6 design (docs/sprints/wix-events-phase6.md): `registered = Yes` now,
// `attended` left BLANK (unknown ≠ No), `activity_date` = the EVENT date, protected by onlyIfAbsent so a
// later pass can't move it.

import { GhlClient, ghl } from '../../ghl/client';
import { getContact } from '../../ghl/contacts';
import { upsertActivity, type UpsertActivityResult } from '../upsert';
import type { CreateActivityOptions } from '../create';
import { sendGa4Event, gaClientIdFromLinker, type Ga4Result } from '../../conversions/ga4';
import { sendLinkedInConversion, liFatIdFromUrl, type LinkedInResult } from '../../conversions/linkedin';
import { sendOnce } from '../../conversions/ledger';

export const EVENT_SOURCE = 'GHL Event' as const;
export const GA4_EVENT_NAME = 'event_registration';

export interface EventRegistrationInput {
  contactId: string;
  eventId?: string;
  eventName?: string;
  /** Event start, any date-ish string. */
  eventStart?: string;
  /** When the person registered. Defaults to now. */
  registeredAt?: string;
  /** Ticket price for a paid event; 0 / absent for an RSVP. */
  amount?: number;
  currency?: string;
  /** Explicit event type label, if the workflow sends one. Wins over the title rule. */
  eventType?: string;
}

export type EventSkipReason = 'no-contact' | 'no-event';

export interface EventRegistrationResult {
  contactId: string;
  eventKey?: string;
  status: 'ingested' | 'skipped';
  reason?: EventSkipReason;
  detail?: string;
  activity?: UpsertActivityResult;
  eventType?: string | null;
  conversions?: {
    ga4: Ga4Result | { status: 'skipped'; reason: 'already-sent' };
    linkedin: LinkedInResult | { status: 'skipped'; reason: 'already-sent' };
  };
}

export interface EventRegistrationOptions extends CreateActivityOptions {
  dryRun?: boolean;
  /** Skip the conversion sends (a historical backfill: GA4 drops hits older than 72h anyway). */
  noConversions?: boolean;
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------------------------
// Payload extraction — tolerant on purpose; the trigger's payload shape is not documented.

const GHL_ID = /^[A-Za-z0-9]{15,30}$/;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);
const pick = (o: any, paths: string[]): string | undefined => {
  for (const p of paths) {
    const v = p.split('.').reduce((a: any, k) => (a == null ? undefined : a[k]), o);
    const s = str(v);
    if (s && !/^\{\{.*\}\}$/.test(s)) return s; // an unrendered merge tag is not a value
  }
  return undefined;
};

export function extractEventPayload(body: any, query: Record<string, unknown> = {}): Partial<EventRegistrationInput> & { via?: string } {
  const b = body ?? {};
  const q = Object.fromEntries(Object.entries(query).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  let contactId: string | undefined;
  let via: string | undefined;
  for (const k of ['contactId', 'contact_id', 'customData.contactId', 'contact.id', 'id']) {
    const v = pick(b, [k]);
    if (v && GHL_ID.test(v)) { contactId = v; via = `body.${k}`; break; }
  }
  if (!contactId && q.contactId) { contactId = q.contactId; via = 'query'; }

  const amountRaw = pick(b, ['customData.amount', 'customData.ticketPrice', 'amount', 'ticketPrice', 'ticket_price', 'event.price', 'ticket.price', 'payment.amount']);
  const amount = amountRaw != null ? Number(String(amountRaw).replace(/[^0-9.]/g, '')) : undefined;
  return {
    contactId,
    via,
    eventId: q.eventId || pick(b, ['customData.eventId', 'customData.event_id', 'eventId', 'event_id', 'event.id', 'event.eventId', 'registration.eventId']),
    eventName: q.eventName || pick(b, ['customData.eventName', 'customData.event_name', 'eventName', 'event_name', 'event.name', 'event.title', 'eventTitle', 'registration.eventName']),
    eventStart: pick(b, ['customData.eventStart', 'customData.event_start', 'customData.eventDate', 'eventStart', 'event_start', 'eventDate', 'event_date', 'event.startDate', 'event.start_date', 'event.startTime', 'event.date']),
    registeredAt: pick(b, ['registeredAt', 'registered_at', 'registration.createdAt', 'date_created', 'dateAdded']),
    amount: Number.isFinite(amount) ? amount : undefined,
    currency: pick(b, ['customData.currency', 'currency', 'event.currency', 'payment.currency']),
    eventType: q.eventType || pick(b, ['customData.eventType', 'eventType', 'event_type', 'event.type']),
  };
}

/**
 * The payload's SHAPE, for the logs: every top-level key, plus the full value of anything that looks
 * event-related. Contact PII (name, email, phone) is deliberately not echoed — only keys.
 */
export function describePayloadShape(body: any): { keys: string[]; eventish: Record<string, unknown> } {
  const b = body && typeof body === 'object' ? body : {};
  const eventish: Record<string, unknown> = {};
  const walk = (o: any, prefix: string, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 3) return;
    for (const [k, v] of Object.entries(o)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (/event|ticket|regist|rsvp|custom/i.test(k)) eventish[path] = v;
      else if (v && typeof v === 'object') walk(v, path, depth + 1);
    }
  };
  walk(b, '', 0);
  return { keys: Object.keys(b), eventish };
}

// ---------------------------------------------------------------------------------------------
// Rules

/**
 * Event type from an explicit label, else ONLY from a word that says it outright.
 * Anything else stays blank for a human: TC counts Workshops (KPI 8) and Tech/Innovation Events
 * (KPI 3) under different KPIs, so a guess here is a mis-filed funder number. ⬜ Zach to confirm a
 * fuller rule (docs/sprints/wix-events-phase6.md, blocker 3).
 */
const TYPE_LABELS = ['Tech/Innovation Event', 'Webinar', 'Roundtable', 'Workshop', 'Other'];
export function eventTypeFor(explicit: string | undefined, title: string | undefined): string | null {
  if (explicit) {
    const hit = TYPE_LABELS.find((l) => l.toLowerCase() === explicit.trim().toLowerCase());
    if (hit) return hit;
  }
  const t = (title ?? '').toLowerCase();
  if (/\bworkshop\b/.test(t)) return 'Workshop';
  if (/\bwebinar\b/.test(t)) return 'Webinar';
  if (/\broundtable\b/.test(t)) return 'Roundtable';
  return null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** The stable registration key. Exported because it is the contract with the ledgers. */
export function eventKeyFor(input: Pick<EventRegistrationInput, 'contactId' | 'eventId' | 'eventName'>): string | null {
  const ev = input.eventId ? input.eventId : input.eventName ? `name:${slug(input.eventName)}` : null;
  return ev ? `${ev}:${input.contactId}` : null;
}

/** A Date from an ISO-ish string or epoch ms, else null. */
export function toDate(v: string | undefined): Date | null {
  if (!v) return null;
  const d = /^\d{11,}$/.test(v) ? new Date(Number(v)) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const DETROIT_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Detroit', year: 'numeric', month: '2-digit', day: '2-digit' });

/**
 * YYYY-MM-DD in LRL's time zone, from an ISO-ish string or epoch ms, else null.
 * Not toISOString(): a 7pm Eastern event is already "tomorrow" in UTC, and the date is the report key.
 * A bare date passes through untouched (parsing it would make it UTC midnight = the day before here).
 */
export function dateOnly(v: string | undefined): string | null {
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim();
  const d = toDate(v);
  return d ? DETROIT_DAY.format(d) : null;
}

// ---------------------------------------------------------------------------------------------

export async function ingestEventRegistration(
  input: EventRegistrationInput,
  opts: EventRegistrationOptions = {},
): Promise<EventRegistrationResult> {
  const client: GhlClient = opts.client ?? ghl();
  const base = { contactId: input.contactId };

  const eventKey = eventKeyFor(input);
  if (!eventKey) {
    return { ...base, status: 'skipped', reason: 'no-event', detail: 'payload carried no event id or name — check the workflow body with ?echo=1' };
  }
  const contact: any = await getContact(input.contactId, client).catch(() => null);
  if (!contact) return { ...base, eventKey, status: 'skipped', reason: 'no-contact' };

  const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || contact.email || input.contactId;
  const eventName = input.eventName ?? `Event ${input.eventId}`;
  const registeredAt = toDate(input.registeredAt) ?? new Date();
  const eventDate = dateOnly(input.eventStart);
  const eventType = eventTypeFor(input.eventType, input.eventName);
  const companyId: string | undefined = contact.businessId || undefined;

  const notes: string[] = [];
  if (!eventDate) notes.push('Event date not supplied by the webhook; activity date is the registration date.');
  if (!eventType) notes.push('Event type not determinable from the title — set Workshop vs Tech/Innovation Event by hand.');
  if (!companyId) notes.push('Registrant has no linked company; attached to the contact only.');

  const values: Record<string, unknown> = {
    activity_name: `${eventName} – ${fullName}`,
    activity_date: eventDate ?? DETROIT_DAY.format(registeredAt),
    event_name: eventName,
    event_id: input.eventId,
    registered: 'Yes',
    ...(eventType ? { event_type: eventType } : {}),
    ...(notes.length ? { activity_notes: notes.join(' ') } : {}),
  };
  for (const k of Object.keys(values)) if (values[k] === undefined) delete values[k];

  const activity = await upsertActivity(
    { source: EVENT_SOURCE, sourceRecordId: eventKey },
    { type: 'workshop_event', companyId, contactIds: [input.contactId], values },
    // activity_date describes WHEN the event is; a re-delivery or the attendance pass must not move it.
    { ...opts, mode: 'ingest', actorKind: 'sync', plan: opts.dryRun, onlyIfAbsent: ['activity_date'] },
  );

  if (opts.noConversions) return { ...base, eventKey, status: 'ingested', activity, eventType };

  const attr = contact.lastAttribution ?? contact.firstAttribution ?? {};
  const value = input.amount && input.amount > 0 ? { amount: input.amount, currencyCode: (input.currency || 'USD').toUpperCase() } : null;
  const fetchImpl = opts.fetchImpl;

  const [ga4, linkedin] = await Promise.all([
    sendOnce('ga4', eventKey, () => sendGa4Event({
      // GHL stores null here for event registrations (no GA tag on Events pages); the id survives in
      // the landing URL's `_gl` linker param, so fall back to that before giving up.
      clientId: attr.gaClientId || gaClientIdFromLinker(attr.url) || gaClientIdFromLinker(contact.firstAttribution?.url),
      sessionId: attr.gaSessionId,
      name: GA4_EVENT_NAME,
      occurredAt: registeredAt,
      // No personal data — ids and names of the EVENT only.
      params: {
        lrl_event_id: input.eventId,
        lrl_event_name: eventName.slice(0, 100),
        lrl_event_type: eventType ?? undefined,
        ...(value ? { value: value.amount, currency: value.currencyCode } : {}),
      },
    }, { dryRun: opts.dryRun, fetchImpl }), { dryRun: opts.dryRun }),
    sendOnce('linkedin', eventKey, () => sendLinkedInConversion({
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
      liFatId: liFatIdFromUrl(attr.url),
      occurredAt: registeredAt,
      eventId: eventKey,
      value,
    }, { dryRun: opts.dryRun, fetchImpl }), { dryRun: opts.dryRun }),
  ]);

  return { ...base, eventKey, status: 'ingested', activity, eventType, conversions: { ga4: ga4.result, linkedin: linkedin.result } };
}
