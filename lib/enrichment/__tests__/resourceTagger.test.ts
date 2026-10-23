import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../ai/anthropic', () => ({ hasAnthropic: true, classifyJson: vi.fn(), CLASSIFIER_MODEL: 'claude-haiku-4-5' }));

import { classifyJson } from '../../ai/anthropic';
import { resourceTagger, buildResourceProposals, deriveResourceText } from '../enrichers/resourceTagger';
import type { RecordEnricherInput } from '../types';

const mockClassify = classifyJson as unknown as ReturnType<typeof vi.fn>;
// Resources moved onto Profiles 2026-10-23 (profile_type = resource).
const OBJ = 'custom_objects.profiles';

function makeInput(fields: Record<string, unknown>): RecordEnricherInput {
  return {
    objectKey: OBJ,
    recordId: 'r1',
    catalog: { fields: [], folders: [], byKey: {}, byId: {} },
    field: (k: string) => fields[k.replace(`${OBJ}.`, '')] ?? fields[k],
  };
}

beforeEach(() => mockClassify.mockReset());

describe('deriveResourceText', () => {
  it('assembles a labeled blob from the resource fields, skipping empties', () => {
    const text = deriveResourceText(makeInput({ display_name: 'Endurance Law Group', category: 'Business Services', sub_category: 'Legal', short_description: 'IP specialists', bio: '' }).field);
    expect(text).toContain('Name: Endurance Law Group');
    expect(text).toContain('Category: Business Services');
    expect(text).toContain('Sub-category: Legal');
    expect(text).not.toContain('\nDescription:'); // bio empty ("Short description:" is present)
  });
});

describe('resourceTagger.enrich', () => {
  it('classifies an org and writes resource-object field keys + derived stops', async () => {
    mockClassify.mockResolvedValue({ serviceTags: ['ip', 'legal', 'nope'], confidence: 'High', verify: false, rationale: 'IP law firm' });
    const out = await resourceTagger.enrich(makeInput({ display_name: 'Endurance Law Group', sub_category: 'Legal', short_description: 'Intellectual property specialists' }));
    const byKey = Object.fromEntries(out.map((p) => [p.fieldKey, p.value]));
    expect(byKey[`${OBJ}.service_areas`]).toBeDefined();
    expect(byKey[`${OBJ}.mrl_stops`]).toBeDefined();
    expect(byKey[`${OBJ}.crl_stops`]).toBeDefined();
    expect(out.every((p) => p.fieldKey.startsWith(`${OBJ}.`))).toBe(true);
    expect(out[0].provenance.source).toBe('anthropic');
  });

  // Stops AND service_areas are MULTIPLE_OPTIONS on Profiles: real ARRAYS of option keys, so the
  // modifier writer can diff them. service_areas keys come from profileServiceKey (2026-10-23).
  it('emits stops and service_areas as arrays of option keys', async () => {
    mockClassify.mockResolvedValue({ serviceTags: ['ip', 'legal'], confidence: 'High', verify: false, rationale: 'IP law firm' });
    const out = await resourceTagger.enrich(makeInput({ display_name: 'Endurance Law Group', short_description: 'IP specialists' }));
    const byKey = Object.fromEntries(out.map((p) => [p.fieldKey, p.value]));

    for (const line of ['mrl_stops', 'trl_stops', 'crl_stops', 'investor_readiness_stops']) {
      const v = byKey[`${OBJ}.${line}`];
      expect(Array.isArray(v), `${line} must be an array, got ${JSON.stringify(v)}`).toBe(true);
      expect((v as unknown[]).every((x) => typeof x === 'string')).toBe(true);
    }
    expect(byKey[`${OBJ}.service_areas`]).toEqual(['ip_patents', 'legal_contracts']);
  });

  it('no clear service → records confidence + rationale only (no placement fields)', async () => {
    mockClassify.mockResolvedValue({ serviceTags: [], confidence: 'Low', verify: true, rationale: 'bare listing' });
    const out = await resourceTagger.enrich(makeInput({ resources: 'Some Directory Listing', category: 'Professional Association' }));
    const keys = out.map((p) => p.fieldKey.replace(`${OBJ}.`, '')).sort();
    expect(keys).toEqual(['readiness_confidence', 'readiness_rationale']);
    expect(out.find((p) => p.fieldKey.endsWith('readiness_rationale'))!.value).toContain('VERIFY');
  });

  it('returns [] when there is nothing to classify from', async () => {
    const out = await resourceTagger.enrich(makeInput({}));
    expect(out).toEqual([]);
    expect(mockClassify).not.toHaveBeenCalled();
  });
});

describe('buildResourceProposals', () => {
  it('produces service_areas + 5 stop fields (incl. MSRL) + confidence + rationale for tags', () => {
    const out = buildResourceProposals(OBJ, ['gtm'], 'Medium', false, 'gtm', 'ai');
    const keys = out.map((p) => p.fieldKey);
    expect(keys).toContain(`${OBJ}.service_areas`);
    expect(keys).toContain(`${OBJ}.crl_stops`);
    expect(keys).toContain(`${OBJ}.msrl_stops`);
    expect(out.length).toBe(8);
  });
  it('empty tags → only confidence + rationale', () => {
    const out = buildResourceProposals(OBJ, [], 'Low', true, 'x', 'ai');
    expect(out.map((p) => p.fieldKey.replace(`${OBJ}.`, '')).sort()).toEqual(['readiness_confidence', 'readiness_rationale']);
  });
});
