// Server-side conversion senders: the shapes are the contract, and the "never invent" rules matter.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../activities/claims', () => ({
  claimSourceEvent: vi.fn(async () => ({ status: 'won' })),
  resolveClaim: vi.fn(async () => {}),
  releaseClaim: vi.fn(async () => {}),
}));

import { normalizeGaClientId, buildGa4Body, sendGa4Event } from '../ga4';
import { sha256Email, liFatIdFromUrl, buildLinkedInBody, sendLinkedInConversion } from '../linkedin';
import { sendOnce } from '../ledger';
import { claimSourceEvent, resolveClaim, releaseClaim } from '../../activities/claims';

const okFetch = (json: unknown = {}, status = 204) =>
  vi.fn(async () => ({ ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) })) as any;

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

describe('normalizeGaClientId', () => {
  it('strips the GA cookie prefix GHL stores', () => {
    expect(normalizeGaClientId('GA1.1.1664579354.1792433630')).toBe('1664579354.1792433630');
    expect(normalizeGaClientId('GA1.2.123.456')).toBe('123.456');
  });
  it('passes a bare id through and refuses junk', () => {
    expect(normalizeGaClientId('123.456')).toBe('123.456');
    expect(normalizeGaClientId('')).toBeNull();
    expect(normalizeGaClientId(null)).toBeNull();
    expect(normalizeGaClientId('not-a-client-id')).toBeNull();
  });
});

describe('GA4 Measurement Protocol', () => {
  beforeEach(() => { process.env.GA4_MEASUREMENT_ID = 'G-TEST'; process.env.GA4_API_SECRET = 's3cret'; });

  it('builds the MP body with engagement time, session id, and no blank params', () => {
    const body: any = buildGa4Body({ clientId: 'x', name: 'event_registration', sessionId: 99, params: { a: 'b', blank: '', none: undefined } }, '1.2');
    expect(body.client_id).toBe('1.2');
    expect(body.events[0]).toEqual({ name: 'event_registration', params: { a: 'b', engagement_time_msec: 1, session_id: '99' } });
  });

  it('skips when not configured, never throws', async () => {
    delete process.env.GA4_API_SECRET;
    expect((await sendGa4Event({ clientId: 'GA1.1.1.2', name: 'x' })).reason).toBe('not-configured');
  });

  it('skips with no client id rather than inventing a user', async () => {
    const f = okFetch();
    const r = await sendGa4Event({ clientId: null, name: 'x' }, { fetchImpl: f });
    expect(r).toMatchObject({ status: 'skipped', reason: 'no-client-id' });
    expect(f).not.toHaveBeenCalled();
  });

  it('skips hits older than 72h (GA4 drops them silently)', async () => {
    const r = await sendGa4Event({ clientId: 'GA1.1.1.2', name: 'x', occurredAt: new Date(Date.now() - 4 * 86400e3) }, { fetchImpl: okFetch() });
    expect(r.reason).toBe('too-old');
  });

  it('sends to /mp/collect with the normalized id', async () => {
    const f = okFetch();
    const r = await sendGa4Event({ clientId: 'GA1.1.111.222', name: 'event_registration' }, { fetchImpl: f });
    expect(r).toMatchObject({ status: 'sent', clientId: '111.222' });
    const [url, init] = f.mock.calls[0];
    expect(url).toContain('https://www.google-analytics.com/mp/collect?measurement_id=G-TEST&api_secret=s3cret');
    expect(JSON.parse(init.body).client_id).toBe('111.222');
  });

  it('a dry run hits the DEBUG endpoint and surfaces validation messages', async () => {
    const f = okFetch({ validationMessages: [{ description: 'bad param' }] }, 200);
    const r = await sendGa4Event({ clientId: '1.2', name: 'x' }, { dryRun: true, fetchImpl: f });
    expect(f.mock.calls[0][0]).toContain('/debug/mp/collect');
    expect(r).toMatchObject({ status: 'failed', reason: 'validation-error' });
    const clean = await sendGa4Event({ clientId: '1.2', name: 'x' }, { dryRun: true, fetchImpl: okFetch({ validationMessages: [] }, 200) });
    expect(clean.status).toBe('validated');
  });
});

describe('LinkedIn Conversions API', () => {
  beforeEach(() => { process.env.LINKEDIN_CAPI_TOKEN = 'tok'; process.env.LINKEDIN_EVENT_CONVERSION_ID = '123'; });

  it('hashes the trimmed, lowercased email', () => {
    expect(sha256Email('  Zach@LeanRocketLab.org ')).toBe(sha256Email('zach@leanrocketlab.org'));
    expect(sha256Email('a@b.c')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reads li_fat_id off a landing URL', () => {
    expect(liFatIdFromUrl('https://go.leanrocketlab.org/x?utm_source=linkedin&li_fat_id=abc-123')).toBe('abc-123');
    expect(liFatIdFromUrl('https://go.leanrocketlab.org/x')).toBeNull();
    expect(liFatIdFromUrl(null)).toBeNull();
  });

  it('builds the conversionEvents body', () => {
    const b: any = buildLinkedInBody({ email: 'a@b.c', firstName: 'A', lastName: 'B', liFatId: 'f', eventId: 'e1', occurredAt: new Date(1000), value: { amount: 25, currencyCode: 'USD' } }, '123');
    expect(b.conversion).toBe('urn:lla:llaPartnerConversion:123');
    expect(b.conversionHappenedAt).toBe(1000);
    expect(b.eventId).toBe('e1');
    expect(b.user.userIds.map((u: any) => u.idType)).toEqual(['SHA256_EMAIL', 'LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID']);
    expect(b.user.userInfo).toEqual({ firstName: 'A', lastName: 'B' });
    expect(b.conversionValue).toEqual({ currencyCode: 'USD', amount: '25' });
  });

  it('dry run plans without calling LinkedIn; 401 reports unauthorized', async () => {
    const f = okFetch();
    expect((await sendLinkedInConversion({ email: 'a@b.c', eventId: 'e' }, { dryRun: true, fetchImpl: f })).status).toBe('planned');
    expect(f).not.toHaveBeenCalled();
    const r = await sendLinkedInConversion({ email: 'a@b.c', eventId: 'e' }, { fetchImpl: okFetch({}, 401) });
    expect(r).toMatchObject({ status: 'failed', reason: 'unauthorized' });
  });

  it('skips when not configured or nothing to match on', async () => {
    expect((await sendLinkedInConversion({ eventId: 'e' }, { fetchImpl: okFetch() })).reason).toBe('no-identifier');
    delete process.env.LINKEDIN_CAPI_TOKEN;
    expect((await sendLinkedInConversion({ email: 'a@b.c', eventId: 'e' })).reason).toBe('not-configured');
  });
});

describe('sendOnce ledger', () => {
  const claim = claimSourceEvent as any, resolve = resolveClaim as any, release = releaseClaim as any;
  beforeEach(() => { claim.mockClear(); resolve.mockClear(); release.mockClear(); });

  it('resolves the claim on sent', async () => {
    const out = await sendOnce('ga4', 'k1', async () => ({ status: 'sent' }));
    expect(claim).toHaveBeenCalledWith('conversion:ga4', 'k1');
    expect(resolve).toHaveBeenCalled();
    expect(out.result.status).toBe('sent');
  });

  it('a re-delivery is already-sent and never calls the platform', async () => {
    claim.mockResolvedValueOnce({ status: 'existing', activityRecordId: 'sent:…' });
    const send = vi.fn(async () => ({ status: 'sent' }));
    const out = await sendOnce('linkedin', 'k1', send);
    expect(out.result).toEqual({ status: 'skipped', reason: 'already-sent' });
    expect(send).not.toHaveBeenCalled();
  });

  it('releases the claim when nothing went out, so a fixed config can retry', async () => {
    await sendOnce('ga4', 'k2', async () => ({ status: 'skipped' }));
    expect(release).toHaveBeenCalledWith('conversion:ga4', 'k2');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('a dry run never claims', async () => {
    await sendOnce('ga4', 'k3', async () => ({ status: 'validated' }), { dryRun: true });
    expect(claim).not.toHaveBeenCalled();
  });
});
