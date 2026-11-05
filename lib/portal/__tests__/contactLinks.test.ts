import { describe, it, expect, vi, beforeEach } from 'vitest';

const createRelation = vi.fn().mockResolvedValue({});
vi.mock('../../ghl/associations', () => ({
  BUSINESSES_CONTACTS_ASSOCIATION: 'BUSINESSES_CONTACTS_ASSOCIATION',
  createRelation: (...a: any[]) => createRelation(...a),
  getAllRelations: vi.fn(),
  resolveAssociationDef: vi.fn(async (key: string) => ({
    id: `id-${key}`, key,
    first: { objectKey: 'contact', label: 'Client' },
    second: { objectKey: `custom_objects.${key.startsWith('business') ? 'business_stage' : 'milestones'}`, label: 'x' },
  })),
}));

import { getAllRelations } from '../../ghl/associations';
import { otherSide, missingContactIds, linkRecordToCompanyContacts, specFor } from '../contactLinks';

const stage = specFor('custom_objects.business_stage')!;
const rel = (associationKey: string, a: [string, string], b: [string, string]) => ({
  associationKey, firstObjectKey: a[0], firstRecordId: a[1], secondObjectKey: b[0], secondRecordId: b[1],
});

describe('otherSide', () => {
  it('reads the id on the requested object side, whichever side it is stored on', () => {
    const rels = [
      rel('BUSINESSES_CONTACTS_ASSOCIATION', ['business', 'co1'], ['contact', 'c1']),
      rel('BUSINESSES_CONTACTS_ASSOCIATION', ['contact', 'c2'], ['business', 'co1']),
      rel('company_activity', ['business', 'co1'], ['custom_objects.activities', 'a1']),
    ];
    expect(otherSide(rels, 'BUSINESSES_CONTACTS_ASSOCIATION', 'contact')).toEqual(['c1', 'c2']);
  });
});

describe('missingContactIds', () => {
  it('returns company contacts the record is not linked to yet, deduped', () => {
    const recordRels = [
      rel('company_business_stage', ['business', 'co1'], ['custom_objects.business_stage', 'r1']),
      rel('business_stage_contact', ['contact', 'c1'], ['custom_objects.business_stage', 'r1']),
    ];
    expect(missingContactIds(recordRels, stage, ['c1', 'c2', 'c2', 'c3'])).toEqual(['c2', 'c3']);
  });
  it('returns nothing when the company has no contacts', () => {
    expect(missingContactIds([], stage, [])).toEqual([]);
  });
});

describe('linkRecordToCompanyContacts', () => {
  beforeEach(() => { createRelation.mockClear(); });
  const client: any = { locationId: 'loc' };

  it('creates one link per missing contact, contact on the side the definition says', async () => {
    const res = await linkRecordToCompanyContacts('custom_objects.business_stage', 'r1', 'co1', {
      client, contactIds: ['c1', 'c2'], recordRels: [],
    });
    expect(res).toEqual({ linked: ['c1', 'c2'], failed: [] });
    expect(createRelation).toHaveBeenCalledWith(
      { associationId: 'id-business_stage_contact', firstRecordId: 'c1', secondRecordId: 'r1' }, client,
    );
  });

  it('dry-run reports without writing', async () => {
    const res = await linkRecordToCompanyContacts('custom_objects.milestones', 'm1', 'co1', {
      client, contactIds: ['c1'], recordRels: [], apply: false,
    });
    expect(res.linked).toEqual(['c1']);
    expect(createRelation).not.toHaveBeenCalled();
  });

  it('reads company contacts and record links when not given, and records failures', async () => {
    (getAllRelations as any).mockImplementation(async (id: string) =>
      id === 'co1'
        ? [rel('BUSINESSES_CONTACTS_ASSOCIATION', ['business', 'co1'], ['contact', 'c1']),
           rel('BUSINESSES_CONTACTS_ASSOCIATION', ['business', 'co1'], ['contact', 'c2'])]
        : [rel('business_stage_contact', ['contact', 'c1'], ['custom_objects.business_stage', 'r1'])]);
    createRelation.mockRejectedValueOnce(new Error('422 nope'));
    const res = await linkRecordToCompanyContacts('custom_objects.business_stage', 'r1', 'co1', { client });
    expect(res.linked).toEqual([]);
    expect(res.failed).toEqual([{ contactId: 'c2', error: '422 nope' }]);
  });
});
