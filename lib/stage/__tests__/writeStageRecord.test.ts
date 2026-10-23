import { describe, it, expect, vi } from 'vitest';

// Mock the object writer so updateStageRecord makes no network call.
vi.mock('../../ghl/writeRecord', () => ({ writeRecordFields: vi.fn().mockResolvedValue({ written: [], skipped: [] }) }));

import { writeRecordFields } from '../../ghl/writeRecord';
import { buildStageProperties, joinRationale, updateStageRecord } from '../writeStageRecord';
import { STAGE_OBJECT } from '../priorAssessment';
import type { StageScore } from '../scoreCompany';
import type { CustomFieldCatalog, CustomFieldDef } from '../../ghl/types';

/** Minimal stage catalog carrying the two single-select option sets the writer resolves. */
function stageCatalog(): CustomFieldCatalog {
  const mk = (fieldKey: string, labels: string[]): CustomFieldDef => ({
    id: fieldKey, name: fieldKey, fieldKey, dataType: 'SINGLE_OPTIONS',
    options: labels.map((l) => ({ key: l, label: l })),
  });
  const byKey: Record<string, CustomFieldDef> = {
    [`${STAGE_OBJECT}.rescore_method`]: mk(`${STAGE_OBJECT}.rescore_method`, ['AI', 'Staff', 'AI+Override']),
    [`${STAGE_OBJECT}.snapshot_kind`]: mk(`${STAGE_OBJECT}.snapshot_kind`, ['Initial', 'Rescore', 'Current']),
    [`${STAGE_OBJECT}.msrl_path`]: mk(`${STAGE_OBJECT}.msrl_path`, ['Sustain', 'Grow']),
  };
  return { fields: Object.values(byKey), folders: [], byKey, byId: {} };
}

const techScore: StageScore = { path: 'tech', trl: 4, mrl: 3, crl: 5, techRationale: 'Stage Scoring — Tech Path\nTRL = 4', rescore: false, model: 'm' };
const bothRescore: StageScore = {
  path: 'both', trl: 6, mrl: 2, crl: 4, msrl: 3, msrlDemand: 3, msrlModel: 5, msrlOperations: 4, msrlPath: 'G',
  msrlLens: 'Projects and trades', msrlOpenFlags: ['P3'], msrlLabel: 'MSRL 3-G (D3 / M5 / O4)', msrlNextMilestone: 'Reach 90 in-season days',
  techRationale: 'tech note', serviceRationale: 'service note', rescore: true, model: 'm',
};

describe('joinRationale', () => {
  it('joins tech + service with the shared separator', () => {
    expect(joinRationale(bothRescore)).toBe('tech note\n\n---\n\nservice note');
  });
  it('emits just the present note when only one path scored', () => {
    expect(joinRationale(techScore)).toBe('Stage Scoring — Tech Path\nTRL = 4');
  });
});

describe('buildStageProperties', () => {
  const cat = stageCatalog();

  it('writes an Initial snapshot with AI method + scores, no msrl on tech path', () => {
    const p = buildStageProperties({ score: techScore, name: 'Acme', rescoreDate: '2026-07-31' }, cat);
    expect(p.snapshot_kind).toBe('Initial');
    expect(p.rescore_method).toBe('AI');
    expect(p.rescore_date).toBe('2026-07-31T00:00:00Z');
    expect(p.trl).toBe(4);
    expect(p.msrl).toBeUndefined();
    expect(p.msrl_open_flags).toBeUndefined();
    expect(p.source_contact_id).toBeUndefined(); // field removed 2026-07-31
    expect(p.name).toBe('Acme — Initial 2026-07-31');
    expect(p.total_business_stage_advancement).toBeUndefined(); // deferred
  });

  it('writes a Rescore snapshot with MSRL + dimensions + joined rationale on the both path', () => {
    const p = buildStageProperties({ score: bothRescore, name: 'Widgets', rescoreDate: '2026-07-31' }, cat);
    expect(p.snapshot_kind).toBe('Rescore');
    expect(p).toMatchObject({ msrl: 3, msrl_demand: 3, msrl_model: 5, msrl_operations: 4, msrl_path: 'Grow',
      msrl_lens: 'Projects and trades', msrl_open_flags: 'P3', msrl_label: 'MSRL 3-G (D3 / M5 / O4)' });
    expect(p.stage_rationale).toBe('tech note\n\n---\n\nservice note');
    expect(p.name).toBe('Widgets — Rescore 2026-07-31');
    expect(p.source_contact_id).toBeUndefined();
  });
});

describe('updateStageRecord (same-day overwrite)', () => {
  it('writes the built properties to the existing record without touching the association', async () => {
    const cat = stageCatalog();
    const res = await updateStageRecord('rec-today', { score: techScore, name: 'Acme', rescoreDate: '2026-07-31' }, { catalog: cat, client: {} as any });
    expect(res.recordId).toBe('rec-today');
    const call = (writeRecordFields as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(STAGE_OBJECT);
    expect(call[1]).toBe('rec-today');
    expect(call[2]).toMatchObject({ trl: 4, snapshot_kind: 'Initial', rescore_method: 'AI' });
  });
});
