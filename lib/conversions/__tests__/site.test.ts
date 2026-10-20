// Site conversions (form submitted / meeting booked) reported server-side: the identity rules, the
// shadow-vs-live gate, the GA4 session recovery and the Meta body are the contracts here.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../activities/claims', () => ({
  claimSourceEvent: vi.fn(async () => ({ status: 'won' })),
  resolveClaim: vi.fn(async () => {}),
  releaseClaim: vi.fn(async () => {}),
}));

const contactStore: Record<string, any> = {};
vi.mock('../../ghl/contacts', () => ({ getContact: vi.fn(async (id: string) => contactStore[id] ?? null) }));
vi.mock('../../ghl/client', () => ({ ghl: () => ({}) }));

import { gaClientIdFromLinker, gaSessionIdFromLinker } from '../ga4';
import { buildMetaBody, fbclidFromUrl, normalizePhone, sendMetaConversion, hashEmail } from '../meta';
import { siteConversionKey, reportSiteConversion, conversionChannels, conversionMode, extractConversionPayload } from '../site';

// The real landing URL GHL stored on the 2026-10-20 GTM cutover test submission.
const LIVE_URL = 'https://apply.leanrocketlab.org/collectives/join?_gl=1*qomsbu*_ga*MTg5MTUzODIyMi4xNzkyNTAyNzU1*_ga_4WMKNE5XEZ*czE3OTI1MDI3NTUkbzEkZzEkdDE3OTI1MDI3NTckajU4JGwwJGgxNjEzOTk1Mjg.&utm_source=gtm_test&utm_medium=test&utm_campaign=gtm_cutover';

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; for (const k of Object.keys(contactStore)) delete contactStore[k]; });

describe('GA4 linker recovery', () => {
  it('reads client id AND session id from the real _gl', () => {
    expect(gaClientIdFromLinker(LIVE_URL)).toBe('1891538222.1792502755');
    expect(gaSessionIdFromLinker(LIVE_URL)).toBe('1792502755');
  });
  it('is null without a linker or without the _ga_ part', () => {
    expect(gaSessionIdFromLinker('https://apply.leanrocketlab.org/x?utm_source=a')).toBeNull();
    expect(gaSessionIdFromLinker('https://x.org/?_gl=1*abc*_ga*MTg5MTUzODIyMi4xNzkyNTAyNzU1')).toBeNull();
    expect(gaSessionIdFromLinker(null)).toBeNull();
  });
});

describe('Meta CAPI', () => {
  it('normalises phones the way Meta hashes them', () => {
    expect(normalizePhone('(517) 555-0100')).toBe('15175550100');
    expect(normalizePhone('+1 517-555-0100')).toBe('15175550100');
    expect(normalizePhone('555-0100')).toBeNull();
  });
  it('builds hashed user_data, fbc from fbclid, and no empty custom_data', () => {
    const when = new Date('2026-10-20T15:00:00Z');
    const { body, matchKeys } = buildMetaBody({
      eventName: 'Lead', eventId: 'form:c1:join:2026-10-20T15', occurredAt: when,
      email: ' Zach@Example.com ', phone: '517-555-0100', fbclid: 'IwAR1abc', clientIp: '1.2.3.4', userAgent: 'UA',
      sourceUrl: 'https://apply.leanrocketlab.org/collectives/join',
    });
    const ev: any = (body.data as any[])[0];
    expect(ev.event_name).toBe('Lead');
    expect(ev.event_time).toBe(Math.floor(when.getTime() / 1000));
    expect(ev.event_id).toBe('form:c1:join:2026-10-20T15');
    expect(ev.action_source).toBe('website');
    expect(ev.user_data.em).toEqual([hashEmail('zach@example.com')]);
    expect(ev.user_data.ph[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(ev.user_data.fbc).toBe(`fb.1.${when.getTime()}.IwAR1abc`);
    expect(ev.user_data.client_ip_address).toBe('1.2.3.4');
    expect(ev.custom_data).toBeUndefined();
    expect(matchKeys).toEqual(['em', 'ph', 'fbc', 'ip', 'ua']);
    expect(JSON.stringify(body)).not.toMatch(/Zach@Example|5550100/);
  });
  it('skips when not configured, and when only IP/UA are available', async () => {
    expect((await sendMetaConversion({ eventName: 'Lead', eventId: 'k', email: 'a@b.c' })).reason).toBe('not-configured');
    process.env.META_PIXEL_ID = 'p'; process.env.META_CAPI_TOKEN = 't';
    expect((await sendMetaConversion({ eventName: 'Lead', eventId: 'k', clientIp: '1.1.1.1', userAgent: 'x' })).reason).toBe('no-identifier');
  });
  it('plans on a dry run, sends live, and surfaces a bad token (code 190) as unauthorized', async () => {
    process.env.META_PIXEL_ID = 'p'; process.env.META_CAPI_TOKEN = 't';
    const planned = await sendMetaConversion({ eventName: 'Lead', eventId: 'k', email: 'a@b.c' }, { dryRun: true });
    expect(planned.status).toBe('planned');
    const calls: any[] = [];
    const f = vi.fn(async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => '{}' }; }) as any;
    const sent = await sendMetaConversion({ eventName: 'Schedule', eventId: 'appt:1', email: 'a@b.c' }, { fetchImpl: f });
    expect(sent.status).toBe('sent');
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/p/events');
    expect(calls[0].body.access_token).toBe('t');
    expect(calls[0].body.test_event_code).toBeUndefined();
    const bad = vi.fn(async () => ({ ok: false, status: 400, text: async () => '{"error":{"code":190,"message":"expired"}}' })) as any;
    expect((await sendMetaConversion({ eventName: 'Lead', eventId: 'k', email: 'a@b.c' }, { fetchImpl: bad })).reason).toBe('unauthorized');
  });
  it('a dry run with META_TEST_EVENT_CODE really delivers, tagged as a test event', async () => {
    process.env.META_PIXEL_ID = 'p'; process.env.META_CAPI_TOKEN = 't'; process.env.META_TEST_EVENT_CODE = 'TEST123';
    let body: any;
    const f = vi.fn(async (_u: string, init: any) => { body = JSON.parse(init.body); return { ok: true, status: 200, text: async () => '{}' }; }) as any;
    const r = await sendMetaConversion({ eventName: 'Lead', eventId: 'k', email: 'a@b.c' }, { dryRun: true, fetchImpl: f });
    expect(r.status).toBe('planned'); expect(r.testEventCode).toBe('TEST123'); expect(body.test_event_code).toBe('TEST123');
  });
  it('reads fbclid from the landing URL', () => {
    expect(fbclidFromUrl('https://apply.leanrocketlab.org/x?fbclid=IwAR1&utm_source=facebook')).toBe('IwAR1');
    expect(fbclidFromUrl(LIVE_URL)).toBeNull();
  });
});

describe('conversion identity', () => {
  const now = new Date('2026-10-20T19:42:00Z');
  it('meeting_booked keys on the appointment id and refuses to guess', () => {
    expect(siteConversionKey({ type: 'meeting_booked', contactId: 'c1', appointmentId: 'A1' }, now)).toBe('appt:A1');
    expect(siteConversionKey({ type: 'meeting_booked', contactId: 'c1' }, now)).toBeNull();
  });
  it('form_submitted keys on contact + form + UTC hour so a re-delivery converges', () => {
    expect(siteConversionKey({ type: 'form_submitted', contactId: 'c1', formName: 'Join a Collective' }, now)).toBe('form:c1:Join-a-Collective:2026-10-20T19');
    expect(siteConversionKey({ type: 'form_submitted', contactId: 'c1' }, now)).toBe('form:c1:form:2026-10-20T19');
    expect(siteConversionKey({ type: 'form_submitted', contactId: 'c1' }, new Date('2026-10-20T20:01:00Z'))).not.toBe(siteConversionKey({ type: 'form_submitted', contactId: 'c1' }, now));
  });
  it('an explicit conversionKey always wins', () => {
    expect(siteConversionKey({ type: 'form_submitted', contactId: 'c1', conversionKey: 'sub_123' }, now)).toBe('sub_123');
  });
});

describe('mode and channel switches', () => {
  it('defaults to shadow and all channels; parses overrides', () => {
    delete process.env.CONVERSION_SYNC_MODE; delete process.env.CONVERSION_SYNC_CHANNELS;
    expect(conversionMode()).toBe('shadow');
    expect(conversionChannels()).toEqual(['ga4', 'linkedin', 'meta']);
    process.env.CONVERSION_SYNC_MODE = 'live';
    expect(conversionMode()).toBe('live');
    expect(conversionChannels('meta, linkedin,bogus').sort()).toEqual(['linkedin', 'meta']);
    expect(conversionChannels('bogus')).toEqual(['ga4', 'linkedin', 'meta']);
  });
});

describe('extractConversionPayload', () => {
  it('reads GHL standard payload + customData + query', () => {
    const p = extractConversionPayload(
      { contact_id: 'AbCdEfGhIjKlMnOpQrSt', first_name: 'Z', customData: { appointmentId: 'ZyXwVuTsRqPoNmLkJiHg', formName: 'Join' } },
      { type: 'meeting_booked' },
    );
    expect(p).toMatchObject({ type: 'meeting_booked', contactId: 'AbCdEfGhIjKlMnOpQrSt', appointmentId: 'ZyXwVuTsRqPoNmLkJiHg', formName: 'Join', via: 'contact_id' });
  });
  it('takes surveyName when formName is blank (one workflow, two triggers)', () => {
    const p = extractConversionPayload({ contact_id: 'AbCdEfGhIjKlMnOpQrSt', customData: { formName: '', surveyName: 'Intake Survey' } }, { type: 'form_submitted' });
    expect(p.formName).toBe('Intake Survey');
    expect(extractConversionPayload({ contact_id: 'AbCdEfGhIjKlMnOpQrSt', customData: { formName: 'Join', surveyName: '' } }, { type: 'form_submitted' }).formName).toBe('Join');
  });
  it('rejects an unknown type and never treats contact date fields as ids', () => {
    const p = extractConversionPayload({ contact_id: 'AbCdEfGhIjKlMnOpQrSt', date_created: '2026-07-27' }, { type: 'purchase' });
    expect(p.type).toBeUndefined();
    expect(p.appointmentId).toBeUndefined();
  });
});

describe('reportSiteConversion', () => {
  const contact = { id: 'AbCdEfGhIjKlMnOpQrSt', email: 'z@example.com', phone: '+15175550100', firstName: 'Z', lastName: 'K',
    lastAttribution: { url: LIVE_URL, utmSource: 'gtm_test', campaign: 'gtm_cutover', ip: '107.4.24.220', userAgent: 'UA', gaClientId: null } };

  it('in shadow mode validates GA4 (debug endpoint), plans LinkedIn and Meta, and never claims', async () => {
    contactStore[contact.id] = contact;
    process.env.GA4_MEASUREMENT_ID = 'G-X'; process.env.GA4_API_SECRET = 's';
    process.env.LINKEDIN_CAPI_TOKEN = 't'; process.env.LINKEDIN_FORM_CONVERSION_ID = '111';
    process.env.META_PIXEL_ID = 'p'; process.env.META_CAPI_TOKEN = 't';
    const urls: string[] = []; const bodies: any[] = [];
    const f = vi.fn(async (url: string, init: any) => { urls.push(url); bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ validationMessages: [] }), text: async () => '{}' }; }) as any;
    const { claimSourceEvent } = await import('../../activities/claims');
    (claimSourceEvent as any).mockClear();
    const r = await reportSiteConversion({ type: 'form_submitted', contactId: contact.id, formName: 'Join a Collective' }, { mode: 'shadow', fetchImpl: f });
    expect(r.status).toBe('reported');
    expect(r.identifiers).toMatchObject({ gaClientId: true, gaSessionId: true, email: true, phone: true, fbclid: false, utmSource: 'gtm_test' });
    expect(r.conversions?.ga4?.status).toBe('validated');
    expect(r.conversions?.linkedin?.status).toBe('planned');
    expect(r.conversions?.meta?.status).toBe('planned');
    expect(urls).toHaveLength(1); expect(urls[0]).toContain('/debug/mp/collect');
    expect(bodies[0].client_id).toBe('1891538222.1792502755');
    expect(bodies[0].events[0]).toMatchObject({ name: 'form_submitted', params: { session_id: '1792502755', lrl_conversion: 'form_submitted', lrl_reporter: 'server' } });
    expect(claimSourceEvent).not.toHaveBeenCalled();
  });

  it('in live mode sends all three under one key and claims each channel', async () => {
    contactStore[contact.id] = contact;
    process.env.GA4_MEASUREMENT_ID = 'G-X'; process.env.GA4_API_SECRET = 's';
    process.env.LINKEDIN_CAPI_TOKEN = 't'; process.env.LINKEDIN_BOOKING_CONVERSION_ID = '222';
    process.env.META_PIXEL_ID = 'p'; process.env.META_CAPI_TOKEN = 't';
    const calls: { url: string; body: any }[] = [];
    const f = vi.fn(async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }; }) as any;
    const { claimSourceEvent } = await import('../../activities/claims');
    (claimSourceEvent as any).mockClear();
    const r = await reportSiteConversion({ type: 'meeting_booked', contactId: contact.id, appointmentId: 'ZyXwVuTsRqPoNmLkJiHg' }, { mode: 'live', fetchImpl: f });
    expect(r.key).toBe('appt:ZyXwVuTsRqPoNmLkJiHg');
    expect(r.conversions?.ga4?.status).toBe('sent');
    expect(r.conversions?.linkedin?.status).toBe('sent');
    expect(r.conversions?.meta?.status).toBe('sent');
    const li = calls.find((c) => c.url.includes('linkedin'))!.body;
    expect(li.conversion).toBe('urn:lla:llaPartnerConversion:222');
    expect(li.eventId).toBe('appt:ZyXwVuTsRqPoNmLkJiHg');
    const meta = calls.find((c) => c.url.includes('facebook'))!.body.data[0];
    expect(meta.event_name).toBe('Schedule'); expect(meta.event_id).toBe('appt:ZyXwVuTsRqPoNmLkJiHg');
    expect(meta.user_data.client_ip_address).toBe('107.4.24.220');
    expect((claimSourceEvent as any).mock.calls.map((c: any[]) => c[0]).sort()).toEqual(['conversion:ga4', 'conversion:linkedin', 'conversion:meta']);
  });

  it('honours the channel switch and explains a missing appointment id / contact', async () => {
    contactStore[contact.id] = contact;
    process.env.GA4_MEASUREMENT_ID = 'G-X'; process.env.GA4_API_SECRET = 's';
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' })) as any;
    const r = await reportSiteConversion({ type: 'form_submitted', contactId: contact.id }, { mode: 'live', channels: ['ga4'], fetchImpl: f });
    expect(r.conversions?.linkedin).toEqual({ status: 'skipped', reason: 'channel-off' });
    expect(r.conversions?.ga4?.status).toBe('sent');
    expect((await reportSiteConversion({ type: 'meeting_booked', contactId: contact.id }, { mode: 'live' })).reason).toBe('no-key');
    expect((await reportSiteConversion({ type: 'form_submitted', contactId: 'NoSuchContactIdHere1' }, { mode: 'live' })).reason).toBe('no-contact');
  });
});
