// The trigger rules: what each form, pipeline and event puts a contact on. Values are the live
// option labels measured 2026-11-25 (see lib/lists/rules.ts).
import { describe, it, expect } from 'vitest';
import { formLists, intakeLists, opportunityLists, isNewOpportunity, eventTagLists, parseGhlDate, FORM_IDS, PIPELINES, RULE_FIELDS } from '../rules';
import { currentLists, withImplied, isSubscribedValue, LIST_FIELDS } from '../fields';

const reader = (v: Record<string, unknown>) => (id: string) => v[id];
const SERVICE = 'Delivering or operating a service based business. Most of my work is serving customers today…';
const PRODUCT = 'Developing a new product, technology, or invention to bring to market. Most of my work…';
const BOTH = "Both — I'm developing a new product AND running an ongoing service or location-based business";

describe('intake rule', () => {
  it('early stage -> Lean Startup', () => {
    expect(intakeLists(reader({ [RULE_FIELDS.whereAreYouToday]: "I'm researching or prototyping a new product or technology", [RULE_FIELDS.businessModel]: PRODUCT })).lists).toEqual(['lean_startup']);
  });
  it('pre-revenue (0) -> Lean Startup; blank revenue is not pre-revenue', () => {
    expect(intakeLists(reader({ [RULE_FIELDS.annualRevenue]: 0 })).lists).toEqual(['lean_startup']);
    expect(intakeLists(reader({ [RULE_FIELDS.annualRevenue]: '' })).lists).toEqual([]);
  });
  it('hobby yes -> Lean Startup', () => {
    expect(intakeLists(reader({ [RULE_FIELDS.hobbyToGrow]: 'Yes' })).lists).toEqual(['lean_startup']);
  });
  it('service or both -> Mainstreet', () => {
    expect(intakeLists(reader({ [RULE_FIELDS.businessModel]: SERVICE, [RULE_FIELDS.whereAreYouToday]: 'I have a stable, profitable business' })).lists).toEqual(['mainstreet_collective']);
    expect(intakeLists(reader({ [RULE_FIELDS.businessModel]: BOTH })).lists).toEqual(['mainstreet_collective']);
  });
  it('2025+ start is a Lean Startup signal, except when it is the only one and Mainstreet fits', () => {
    expect(intakeLists(reader({ [RULE_FIELDS.dateOfIncorporation]: '2025-03-01', [RULE_FIELDS.businessModel]: PRODUCT })).lists).toEqual(['lean_startup']);
    expect(intakeLists(reader({ [RULE_FIELDS.dateOfIncorporation]: '2025-03-01', [RULE_FIELDS.businessModel]: SERVICE })).lists).toEqual(['mainstreet_collective']);
    expect(intakeLists(reader({ [RULE_FIELDS.dateOfIncorporation]: '2019-03-01', [RULE_FIELDS.businessModel]: PRODUCT })).lists).toEqual([]);
  });
  it('a strong signal keeps Lean Startup even with Mainstreet fit', () => {
    expect(intakeLists(reader({ [RULE_FIELDS.hobbyToGrow]: 'Yes', [RULE_FIELDS.dateOfIncorporation]: '2026-01-01', [RULE_FIELDS.businessModel]: SERVICE })).lists).toEqual(['lean_startup', 'mainstreet_collective']);
  });
  it('ManuTech: physical manufacturing, build help, or i4.0 interest; software-only is not', () => {
    expect(intakeLists(reader({ [RULE_FIELDS.howManufactured]: 'Hand-built one-offs' })).lists).toEqual(['manutech']);
    expect(intakeLists(reader({ [RULE_FIELDS.howManufactured]: 'Not yet manufactured / Software Only' })).lists).toEqual([]);
    expect(intakeLists(reader({ [RULE_FIELDS.resourcesWanted]: ['Funding', 'Prototyping'] })).lists).toEqual(['manutech']);
    expect(intakeLists(reader({ [RULE_FIELDS.resourcesWanted]: ['Engineering / Manufacturing Resources'] })).lists).toEqual(['manutech']);
    expect(intakeLists(reader({ [RULE_FIELDS.programsWanted]: ['Industry 4.0 Accelerator'] })).lists).toEqual(['manutech']);
  });
});

describe('form rules', () => {
  const none = reader({});
  it('SAMA application form and survey -> SAMA', () => {
    expect(formLists(FORM_IDS.samaApplicationForm, none).lists).toEqual(['sama']);
    expect(formLists(FORM_IDS.samaApplicationSurvey, none).lists).toEqual(['sama']);
  });
  it('LOCAL application -> LOCAL + Mainstreet', () => {
    expect(formLists(FORM_IDS.localFellowsApplication, none).lists).toEqual(['mainstreet_collective', 'local']);
  });
  it('Join a Collective maps the picked options', () => {
    expect(formLists(FORM_IDS.joinACollective, reader({ [RULE_FIELDS.collectivesToJoin]: ['Lean Startup', 'Manufacturing Tech'] })).lists).toEqual(['lean_startup', 'manutech']);
    expect(formLists(FORM_IDS.joinACollective, reader({ [RULE_FIELDS.collectivesToJoin]: 'Mainstreet' })).lists).toEqual(['mainstreet_collective']);
  });
  it('unknown form -> no rule', () => {
    expect(formLists('nr9JGaC6pYXWMDjp55ly', none)).toEqual({ lists: [], rule: null, why: [] });
    expect(formLists(undefined, none).rule).toBeNull();
  });
});

describe('opportunity rules', () => {
  it('Client Journey maps by program affiliation; Gateway maps to nothing', () => {
    expect(opportunityLists(PIPELINES.clientJourney, ['LOCAL', 'Gateway']).lists).toEqual(['mainstreet_collective', 'local']);
    expect(opportunityLists(PIPELINES.clientJourney, ['Sales and Marketing Accelerator', 'ManuTech', 'Co-Working']).lists).toEqual(['sama', 'manutech']);
    expect(opportunityLists(PIPELINES.clientJourney, ['Gateway']).lists).toEqual([]);
  });
  it('program pipelines', () => {
    expect(opportunityLists(PIPELINES.localFellowsBootcamp, []).lists).toEqual(['mainstreet_collective', 'local']);
    expect(opportunityLists(PIPELINES.samaCohort, []).lists).toEqual(['sama']);
    expect(opportunityLists(PIPELINES.manutech, []).lists).toEqual(['manutech']);
    expect(opportunityLists(PIPELINES.coworkingSpace, []).rule).toBeNull(); // coworking off for now
    expect(opportunityLists('trGMRtrlkvUG1UtMbuMJ', []).rule).toBeNull(); // Direct Grants
  });
  it('only a new opportunity triggers (48h)', () => {
    const now = new Date('2026-11-25T20:00:00Z');
    expect(isNewOpportunity('2026-11-24T21:00:00Z', now)).toBe(true);
    expect(isNewOpportunity('2026-11-20T21:00:00Z', now)).toBe(false);
    expect(isNewOpportunity(undefined, now)).toBe(false);
  });
});

describe('event tags', () => {
  it('maps tags, i40 and manufacturing-tech to ManuTech, de-duped', () => {
    expect(eventTagLists('sama, manutech, i40, lean-startup, manufacturing-tech')).toEqual({ lists: ['lean_startup', 'sama', 'manutech'], unknownTags: [] });
  });
  it('local implies mainstreet; unknown tags reported', () => {
    expect(eventTagLists('local, foo')).toEqual({ lists: ['mainstreet_collective', 'local'], unknownTags: ['foo'] });
    expect(eventTagLists('coworking').lists).toEqual([]); // coworking off for now
    expect(eventTagLists('')).toEqual({ lists: [], unknownTags: [] });
  });
});

describe('fields helpers', () => {
  it('reads subscribed checkbox values in both shapes', () => {
    expect(isSubscribedValue(['Subscribed'])).toBe(true);
    expect(isSubscribedValue('Subscribed')).toBe(true);
    expect(isSubscribedValue([])).toBe(false);
    expect(isSubscribedValue(undefined)).toBe(false);
    expect(Array.from(currentLists([{ id: LIST_FIELDS.sama.fieldId, value: ['Subscribed'] }, { id: LIST_FIELDS.local.fieldId, value: [] }]))).toEqual(['sama']);
  });
  it('withImplied keeps a stable order', () => {
    expect(withImplied(['sama', 'local', 'sama'] as any)).toEqual(['mainstreet_collective', 'local', 'sama']);
  });
  it('parseGhlDate handles ISO, date-only and epoch ms', () => {
    expect(parseGhlDate('2025-01-02')?.getUTCFullYear()).toBe(2025);
    expect(parseGhlDate(1767225600000)?.getUTCFullYear()).toBe(2026);
    expect(parseGhlDate('')).toBeNull();
  });
});
