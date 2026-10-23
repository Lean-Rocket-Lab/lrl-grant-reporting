import { describe, it, expect } from 'vitest';
import {
  SERVICES,
  STOP_SERVICES,
  SERVICE_KEYS,
  deriveStops,
  stopsForLine,
  normalizeTags,
  tagsToLabels,
  labelsToTags,
} from '../data/readiness';

describe('readiness taxonomy', () => {
  it('has the 29 providers-db services plus the 6 Main Street additions', () => {
    expect(Object.keys(SERVICES)).toHaveLength(35);
  });

  it('STOP_SERVICES lines have the right lengths and only reference valid tags', () => {
    expect(Object.keys(STOP_SERVICES.MRL)).toHaveLength(10);
    expect(Object.keys(STOP_SERVICES.TRL)).toHaveLength(9);
    expect(Object.keys(STOP_SERVICES.CRL)).toHaveLength(9);
    expect(Object.keys(STOP_SERVICES.IRL)).toHaveLength(9);
    for (const line of Object.values(STOP_SERVICES)) {
      for (const needs of Object.values(line)) {
        for (const tag of needs) expect(SERVICE_KEYS.has(tag)).toBe(true);
      }
    }
  });
});

describe('normalizeTags', () => {
  it('keeps valid ids, drops junk, de-dupes, lowercases', () => {
    expect(normalizeTags(['gtm', 'GTM', 'nope', 'market'])).toEqual(['gtm', 'market']);
  });
  it('returns [] for non-arrays', () => {
    expect(normalizeTags('gtm' as unknown)).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
  });
});

describe('labels ↔ tags round-trip', () => {
  it('tagsToLabels maps ids to display labels', () => {
    expect(tagsToLabels(['gtm', 'market'])).toEqual(['Go-to-Market Strategy', 'Market Research']);
  });
  it('labelsToTags is the inverse and skips unknown labels', () => {
    expect(labelsToTags(['Go-to-Market Strategy', 'Market Research', 'Not A Service'])).toEqual(['gtm', 'market']);
  });
});

describe('stopsForLine / deriveStops', () => {
  it('places gtm on the expected CRL + IRL stops only', () => {
    expect(stopsForLine('CRL', ['gtm'])).toEqual([2, 3, 7, 9]);
    expect(stopsForLine('IRL', ['gtm'])).toEqual([5]);
    expect(stopsForLine('MRL', ['gtm'])).toEqual([]);
    expect(stopsForLine('TRL', ['gtm'])).toEqual([]);
  });

  it('cm places on MRL 5 & 6 and TRL none', () => {
    expect(stopsForLine('MRL', ['cm'])).toEqual([5, 6]);
    expect(stopsForLine('TRL', ['cm'])).toEqual([]);
  });

  it('deriveStops unions across tags and stays sorted', () => {
    const stops = deriveStops(['gtm', 'cm', 'garbage']);
    expect(stops.MRL).toEqual([5, 6]);
    expect(stops.CRL).toEqual([2, 3, 7, 9]);
    expect(stops.IRL).toEqual([5]);
  });

  it('empty tags → empty stops on every line', () => {
    expect(deriveStops([])).toEqual({ MRL: [], TRL: [], CRL: [], IRL: [], MSRL: [] });
  });
  it('places Main Street services on the MSRL line (bookkeeping clears 3, 4 and 7)', () => {
    expect(deriveStops(['bookkeeping']).MSRL).toEqual([3, 4, 7]);
    expect(deriveStops(['realestate']).MSRL).toEqual([2, 3, 8, 9]);
    expect(deriveStops(['ip']).MSRL).toEqual([]);
  });
});
