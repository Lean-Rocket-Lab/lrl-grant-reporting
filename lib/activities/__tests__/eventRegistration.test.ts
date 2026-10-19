// GHL Events registration adapter: identity, the attended-is-blank rule, the event date, and the
// conversions riding along.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../ghl/contacts', async (orig) => ({ ...(await orig<any>()), getContact: vi.fn() }));
vi.mock('../upsert', async (orig) => ({
  ...(await orig<any>()),
  upsertActivity: vi.fn(async () => ({ recordId: 'act1', outcome: 'created', written: ['activity_date'], skipped: [] })),
}));
vi.mock('../claims', () => ({
  claimSourceEvent: vi.fn(async () => ({ status: 'won' })),
  resolveClaim: vi.fn(async () => {}),
  releaseClaim: vi.fn(async () => {}),
  lookupClaim: vi.fn(async () => null),
}));

import { getContact } from '../../ghl/contacts';
import { upsertActivity } from '../upsert';
import {
  ingestEventRegistration, extractEventPayload, eventTypeFor, eventKeyFor, dateOnly, EVENT_SOURCE,
} from '../sources/eventRegistration';

const mockContact = getContact as any;
const mockUpsert = upsertActivity as any;
const env = { ...process.env };
const fakeClient: any = { locationId: 'loc' };

const CONTACT = {
  id: 'tps7vxu0eR5duffFaDXS', firstName: 'Zach', lastName: 'Kraabel', email: 'zach@leanrocketlab.org',
  businessId: 'biz1',
  lastAttribution: { gaClientId: 'GA1.1.1664579354.1792433630', url: 'https://go.leanrocketlab.org/events/x?li_fat_id=fat-1' },
};

beforeEach(() => {
  mockContact.mockReset(); mockUpsert.mockClear();
  mockContact.mockResolvedValue(CONTACT);
});
afterEach(() => { process.env = { ...env }; });

describe('extractEventPayload', () => {
  it('reads flat custom-webhook bodies and nested ones, and ignores unrendered merge tags', () => {
    expect(extractEventPayload({ contactId: 'tps7vxu0eR5duffFaDXS', eventId: 'ev1', eventName: 'AMTC Lunch', eventStart: '2026-11-09T17:00:00Z' }))
      .toMatchObject({ contactId: 'tps7vxu0eR5duffFaDXS', eventId: 'ev1', eventName: 'AMTC Lunch', via: 'body.contactId' });
    expect(extractEventPayload({ contact: { id: 'tps7vxu0eR5duffFaDXS' }, event: { id: 'ev2', name: 'X', startDate: '2026-11-09' } }))
      .toMatchObject({ contactId: 'tps7vxu0eR5duffFaDXS', eventId: 'ev2', eventName: 'X', eventStart: '2026-11-09' });
    expect(extractEventPayload({ contactId: 'tps7vxu0eR5duffFaDXS', eventId: '{{event.id}}' }).eventId).toBeUndefined();
  });
  it('accepts a contact id on the query string', () => {
    expect(extractEventPayload({}, { contactId: 'abc' }).contactId).toBe('abc');
  });
});

describe('rules', () => {
  it('event type only from an explicit label or an unambiguous word', () => {
    expect(eventTypeFor(undefined, 'Video Marketing Workshop: Turn Content into Customers')).toBe('Workshop');
    expect(eventTypeFor(undefined, 'Founder Roundtable')).toBe('Roundtable');
    expect(eventTypeFor('tech/innovation event', 'Anything')).toBe('Tech/Innovation Event');
    expect(eventTypeFor(undefined, 'Three Quotes, Three Different Prices')).toBeNull();
  });
  it('identity is event + contact, with a name fallback', () => {
    expect(eventKeyFor({ contactId: 'c1', eventId: 'ev1' })).toBe('ev1:c1');
    expect(eventKeyFor({ contactId: 'c1', eventName: 'Coffee Connect!' })).toBe('name:coffee-connect:c1');
    expect(eventKeyFor({ contactId: 'c1' })).toBeNull();
  });
  it('dates are LRL-local, and a bare date is not shifted', () => {
    expect(dateOnly('2026-11-09')).toBe('2026-11-09');
    // 7pm Eastern on Nov 9 is Nov 10 in UTC — the report must still say Nov 9.
    expect(dateOnly('2026-11-10T00:00:00Z')).toBe('2026-11-09');
    expect(dateOnly('garbage')).toBeNull();
  });
});

describe('ingestEventRegistration', () => {
  it('upserts one Workshop / Event ticket: registered Yes, attended untouched, event date protected', async () => {
    const r = await ingestEventRegistration(
      { contactId: CONTACT.id, eventId: 'ev1', eventName: 'CRM Foundations Workshop', eventStart: '2026-11-09T16:00:00Z' },
      { client: fakeClient, noConversions: true },
    );
    expect(r.status).toBe('ingested');
    const [key, input, opts] = mockUpsert.mock.calls[0];
    expect(key).toEqual({ source: EVENT_SOURCE, sourceRecordId: `ev1:${CONTACT.id}` });
    expect(input.type).toBe('workshop_event');
    expect(input.companyId).toBe('biz1');
    expect(input.values).toMatchObject({
      activity_date: '2026-11-09', event_id: 'ev1', event_name: 'CRM Foundations Workshop',
      registered: 'Yes', event_type: 'Workshop', activity_name: 'CRM Foundations Workshop – Zach Kraabel',
    });
    expect(input.values).not.toHaveProperty('attended');
    expect(opts).toMatchObject({ mode: 'ingest', onlyIfAbsent: ['activity_date'] });
  });

  it('a registrant with no company is attached to the contact and flagged, not dropped', async () => {
    mockContact.mockResolvedValue({ ...CONTACT, businessId: undefined });
    await ingestEventRegistration({ contactId: CONTACT.id, eventId: 'ev1', eventName: 'Mystery Night' }, { client: fakeClient, noConversions: true });
    const input = mockUpsert.mock.calls[0][1];
    expect(input.companyId).toBeUndefined();
    expect(input.contactIds).toEqual([CONTACT.id]);
    expect(input.values.activity_notes).toMatch(/no linked company/);
    expect(input.values.activity_notes).toMatch(/Event type not determinable/);
  });

  it('skips without an event identity or a contact', async () => {
    expect((await ingestEventRegistration({ contactId: CONTACT.id }, { client: fakeClient })).reason).toBe('no-event');
    mockContact.mockResolvedValue(null);
    expect((await ingestEventRegistration({ contactId: 'x', eventId: 'e' }, { client: fakeClient })).reason).toBe('no-contact');
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('sends GA4 (no PII) and LinkedIn (hashed email + li_fat_id) under the same key', async () => {
    process.env.GA4_MEASUREMENT_ID = 'G-TEST'; process.env.GA4_API_SECRET = 's';
    process.env.LINKEDIN_CAPI_TOKEN = 't'; process.env.LINKEDIN_EVENT_CONVERSION_ID = '999';
    const f = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({}), text: async () => '' })) as any;
    const r = await ingestEventRegistration(
      { contactId: CONTACT.id, eventId: 'ev1', eventName: 'AMTC Lunch & Learn', amount: 25 },
      { client: fakeClient, fetchImpl: f },
    );
    expect(r.conversions?.ga4.status).toBe('sent');
    expect(r.conversions?.linkedin.status).toBe('sent');
    const ga = f.mock.calls.find((c: any) => String(c[0]).includes('google-analytics'));
    const gaBody = JSON.parse(ga[1].body);
    expect(gaBody.client_id).toBe('1664579354.1792433630');
    expect(gaBody.events[0].name).toBe('event_registration');
    expect(gaBody.events[0].params).toMatchObject({ lrl_event_id: 'ev1', value: 25, currency: 'USD' });
    expect(JSON.stringify(gaBody)).not.toContain('zach@');
    const li = f.mock.calls.find((c: any) => String(c[0]).includes('linkedin'));
    const liBody = JSON.parse(li[1].body);
    expect(liBody.eventId).toBe(`ev1:${CONTACT.id}`);
    expect(liBody.user.userIds).toEqual(expect.arrayContaining([expect.objectContaining({ idType: 'LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID', idValue: 'fat-1' })]));
    expect(JSON.stringify(liBody)).not.toContain('zach@leanrocketlab.org');
  });

  it('with nothing configured, conversions skip and the activity still lands', async () => {
    delete process.env.GA4_API_SECRET; delete process.env.LINKEDIN_CAPI_TOKEN;
    const r = await ingestEventRegistration({ contactId: CONTACT.id, eventId: 'ev1', eventName: 'X' }, { client: fakeClient });
    expect(r.status).toBe('ingested');
    expect(r.conversions?.ga4).toMatchObject({ status: 'skipped', reason: 'not-configured' });
    expect(r.conversions?.linkedin).toMatchObject({ status: 'skipped', reason: 'not-configured' });
  });
});

describe('GHL standard payload', () => {
  it('reads Custom Data from customData and the contact from contact_id', async () => {
    const { extractEventPayload: x } = await import('../sources/eventRegistration');
    expect(x({ contact_id: 'tps7vxu0eR5duffFaDXS', first_name: 'Z', customData: { eventId: 'ev9', eventName: 'Coffee Connect', eventStart: '2026-11-06' } }))
      .toMatchObject({ contactId: 'tps7vxu0eR5duffFaDXS', via: 'body.contact_id', eventId: 'ev9', eventName: 'Coffee Connect', eventStart: '2026-11-06' });
  });
  it('describes the payload shape without echoing contact PII', async () => {
    const { describePayloadShape } = await import('../sources/eventRegistration');
    const shape = describePayloadShape({ contact_id: 'c', email: 'a@b.c', customData: { eventId: 'e' }, triggerData: { event: { id: 'e2' } } });
    expect(shape.keys).toEqual(['contact_id', 'email', 'customData', 'triggerData']);
    expect(shape.eventish).toHaveProperty('customData');
    expect(shape.eventish).toHaveProperty('triggerData.event');
    expect(JSON.stringify(shape.eventish)).not.toContain('a@b.c');
  });
});

describe('live payload regressions (2026-10-19)', () => {
  it("parses GHL's 'Nov 9th 2026, 12:00pm' start date", () => {
    expect(dateOnly('Nov 9th 2026, 12:00pm')).toBe('2026-11-09');
    expect(dateOnly('Dec 14th 2026, 3:30pm')).toBe('2026-12-14');
    expect(dateOnly('November 1st 2026, 7:30am')).toBe('2026-11-01');
    expect(dateOnly('Oct 22nd 2026, 11:59pm')).toBe('2026-10-22');
  });
  it("never treats the contact's date_created as the registration time", () => {
    const p = extractEventPayload({ contact_id: 'tps7vxu0eR5duffFaDXS', date_created: '2026-07-27T13:23:27.219Z', customData: { eventId: 'e' } });
    expect(p.registeredAt).toBeUndefined();
  });
});
