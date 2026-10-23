import { describe, it, expect, vi } from 'vitest';

vi.mock('../../ai/anthropic', () => ({ hasAnthropic: true, classifyJson: vi.fn(), CLASSIFIER_MODEL: 'test' }));
vi.mock('../../enrichment/configStore', () => ({ resolveEnricherConfig: vi.fn() }));
vi.mock('../../enrichment/recordEngine', () => ({ enrichRecord: vi.fn() }));
vi.mock('../../ghl/resourceRelations', () => ({ ensureResourceCompanyLink: vi.fn() }));
vi.mock('../../ghl/records', () => ({ readRecordFields: vi.fn() }));

import { profileKind, runProfilePipeline } from '../pipeline';
import { readRecordFields } from '../../ghl/records';
import { resolveEnricherConfig } from '../../enrichment/configStore';
import { enrichRecord } from '../../enrichment/recordEngine';
import { ensureResourceCompanyLink } from '../../ghl/resourceRelations';

const P = 'custom_objects.profiles';
const catalog = { fields: [], folders: [], byKey: {}, byId: {} } as any;
const fieldsOf = (o: Record<string, unknown>) => new Map(Object.entries(o).map(([k, v]) => [`${P}.${k}`, v]));
const openGate = { enricher: 'x', sourceObject: P, enabled: true, combine: 'AND', groups: [] };

describe('profileKind', () => {
  it('accepts the option key or label, any case, and nothing else', () => {
    expect(profileKind('resource')).toBe('resource');
    expect(profileKind('Person')).toBe('person');
    expect(profileKind(['resource'])).toBe('resource');
    expect(profileKind('')).toBeNull();
    expect(profileKind(undefined)).toBeNull();
    expect(profileKind('team')).toBeNull();
  });
});

describe('runProfilePipeline', () => {
  it('runs nothing when profile_type is missing — never guesses the classifier', async () => {
    (readRecordFields as any).mockResolvedValue(fieldsOf({ profile_status: 'published' }));
    const r = await runProfilePipeline('p1', catalog, { apply: true, ghlClient: {} as any });
    expect(r.kind).toBeNull();
    expect(r.enrich.ran).toBe(false);
    expect(enrichRecord).not.toHaveBeenCalled();
  });

  it('resource → resource-tagger + company link; person → profile-tagger, no company link', async () => {
    (resolveEnricherConfig as any).mockResolvedValue(openGate);
    (enrichRecord as any).mockResolvedValue({ applied: [], proposals: [] });
    (ensureResourceCompanyLink as any).mockResolvedValue({ status: 'already-linked', applied: false });

    (readRecordFields as any).mockResolvedValue(fieldsOf({ profile_type: 'resource', profile_status: 'published' }));
    const res = await runProfilePipeline('r1', catalog, { apply: true, ghlClient: {} as any });
    expect(res.enrich.enricher).toBe('resource-tagger');
    expect(res.companyLink?.status).toBe('already-linked');

    (ensureResourceCompanyLink as any).mockClear();
    (readRecordFields as any).mockResolvedValue(fieldsOf({ profile_type: 'person', profile_status: 'published' }));
    const per = await runProfilePipeline('p2', catalog, { apply: true, ghlClient: {} as any });
    expect(per.enrich.enricher).toBe('profile-tagger');
    expect(per.companyLink).toBeUndefined();
    expect(ensureResourceCompanyLink).not.toHaveBeenCalled();
  });
});
