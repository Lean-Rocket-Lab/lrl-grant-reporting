import { describe, it, expect } from 'vitest';
import { fingerprint, normalizeCompanyAddress, addressNeedsGeocode, isGeocodableAddress } from '../stateStore';

describe('fingerprint', () => {
  it('is stable for the same input and differs when the input changes', () => {
    const a = fingerprint('Company: Acme\nAnnual revenue: $0');
    expect(a).toBe(fingerprint('Company: Acme\nAnnual revenue: $0'));
    expect(a).not.toBe(fingerprint('Company: Acme\nAnnual revenue: $100000'));
    expect(a).toMatch(/^[0-9a-f]{40}$/); // sha1 hex
  });
});

describe('normalizeCompanyAddress', () => {
  const of = (m: Record<string, unknown>) => (k: string) => m[k];
  it('joins address fields lowercased, empty when none present', () => {
    expect(normalizeCompanyAddress(of({ 'business.address': '305 Moorman Drive', 'business.city': 'Jackson', 'business.state': 'Michigan', 'business.postalcode': '49202' })))
      .toBe('305 moorman drive|jackson|michigan|49202');
    expect(normalizeCompanyAddress(of({}))).toBe('');
  });
});

describe('addressNeedsGeocode', () => {
  it('runs on create (no stored address) and on a real change, skips when unchanged or no address', () => {
    expect(addressNeedsGeocode('a|b|c|d', null)).toBe(true);       // never geocoded → run
    expect(addressNeedsGeocode('a|b|c|d', 'x|y|z|w')).toBe(true);  // changed → run
    expect(addressNeedsGeocode('a|b|c|d', 'a|b|c|d')).toBe(false); // unchanged → skip
    expect(addressNeedsGeocode('', null)).toBe(false);            // no address → nothing to do
  });
});

// ── the geocode state, and the poison it used to create ───────────────────────────────────────────
// `/api/sync/up` stamped enricher_state.geocodedAddress whenever geo was ATTEMPTED, so one failed
// geocode marked the address "done" and the company never geocoded again. Found on "Wayne"
// (2026-09-09): a full Grosse Pointe Woods address, stamped, with county and geo_disadvantaged both
// blank. 24 companies were in that state. county gates SBSH eligibility, so a silent blank is a
// wrong answer, not a missing one.


/** A field reader over business.* keys, as the caller supplies. */
const reader = (o: Record<string, unknown>) => (k: string) => o[k.replace(/^business\./, '')];

describe('normalizeCompanyAddress placeholders', () => {
  it('treats GHL’s literal "(No value)" as absent', () => {
    // 12 of the 24 poisoned companies read `(No value), (No value), MI` — not an address, but not
    // empty either, so the old code saw "has an address" and attempted a geocode forever.
    expect(normalizeCompanyAddress(reader({ address: '(No value)', city: '(No value)', state: 'MI' })))
      .toBe('||mi|');
  });

  it('treats undefined/null/n-a strings as absent too', () => {
    for (const junk of ['undefined', 'null', 'N/A', 'none', '--']) {
      expect(normalizeCompanyAddress(reader({ address: junk, city: junk, state: 'MI' }))).toBe('||mi|');
    }
  });

  it('keeps a real address intact', () => {
    expect(normalizeCompanyAddress(reader({ address: '1722 Littlestone Rd', city: 'Grosse Pointe Woods', state: 'Michigan', postalcode: '48236' })))
      .toBe('1722 littlestone rd|grosse pointe woods|michigan|48236');
  });

  it('is empty when there is nothing at all', () => {
    expect(normalizeCompanyAddress(reader({}))).toBe('');
  });
});

describe('isGeocodableAddress', () => {
  it('accepts a postal code alone', () => {
    expect(isGeocodableAddress(reader({ postalcode: '48236' }))).toBe(true);
  });

  it('accepts a city with a state', () => {
    expect(isGeocodableAddress(reader({ city: 'Rochester', state: 'MI' }))).toBe(true);
  });

  it('REJECTS a bare state — the case that would retry forever', () => {
    expect(isGeocodableAddress(reader({ state: 'MI' }))).toBe(false);
  });

  it('rejects placeholder city/state with no zip', () => {
    expect(isGeocodableAddress(reader({ address: '(No value)', city: '(No value)', state: 'MI' }))).toBe(false);
  });

  it('rejects a street with no city, state or zip', () => {
    // A street alone cannot resolve a county.
    expect(isGeocodableAddress(reader({ address: '1722 Littlestone Rd' }))).toBe(false);
  });

  it('accepts Wayne’s real address', () => {
    expect(isGeocodableAddress(reader({ address: '1722 Littlestone Rd', city: 'Grosse Pointe Woods', state: 'Michigan', postalcode: '48236' }))).toBe(true);
  });
});

describe('addressNeedsGeocode', () => {
  it('runs when nothing has been geocoded yet', () => {
    expect(addressNeedsGeocode('a|b|mi|48236', null)).toBe(true);
  });

  it('skips when the address is unchanged since the last successful geocode', () => {
    expect(addressNeedsGeocode('a|b|mi|48236', 'a|b|mi|48236')).toBe(false);
  });

  it('runs again when the address changes', () => {
    expect(addressNeedsGeocode('new|b|mi|48236', 'a|b|mi|48236')).toBe(true);
  });
});
