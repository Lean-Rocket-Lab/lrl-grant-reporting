// The form trigger must find the form even when a calendar booking has overwritten the contact's
// Latest Attribution (measured on every Intake submitter, 2026-11-25).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../ghl/contacts', () => ({ getContact: vi.fn() }));
vi.mock('../apply', () => ({ addContactToLists: vi.fn(async (_c: string, lists: string[]) => ({ status: 'dry-run', added: lists })) }));
vi.mock('../submissions', () => ({ recentSubmissionFormIds: vi.fn() }));
vi.mock('../eventMap', () => ({ loadEventRows: vi.fn(), findEventRow: vi.fn() }));
vi.mock('../../ghl/client', () => ({ ghl: () => ({}) }));

import { getContact } from '../../ghl/contacts';
import { addContactToLists } from '../apply';
import { recentSubmissionFormIds } from '../submissions';
import { runFormListTrigger } from '../triggers';
import { FORM_IDS, RULE_FIELDS } from '../rules';

const get = getContact as unknown as ReturnType<typeof vi.fn>;
const recent = recentSubmissionFormIds as unknown as ReturnType<typeof vi.fn>;
const add = addContactToLists as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => { get.mockReset(); recent.mockReset(); add.mockClear(); });

describe('runFormListTrigger', () => {
  it('finds the Intake survey from recent submissions when attribution says calendar', async () => {
    get.mockResolvedValue({ id: 'c1', lastAttribution: { medium: 'calendar', mediumId: 'cal1' }, customFields: [{ id: RULE_FIELDS.hobbyToGrow, value: 'Yes' }] });
    recent.mockResolvedValue([FORM_IDS.intakeSurvey]);
    const r = await runFormListTrigger({ contactId: 'c1' }, { dryRun: true });
    expect(r.rule).toBe('intake');
    expect(add).toHaveBeenCalledWith('c1', ['lean_startup'], expect.objectContaining({ source: 'form' }));
  });
  it('unions every recent form with a rule, and ignores forms without one', async () => {
    get.mockResolvedValue({ id: 'c1', lastAttribution: { medium: 'form', mediumId: 'nr9JGaC6pYXWMDjp55ly' }, customFields: [] });
    recent.mockResolvedValue([FORM_IDS.samaApplicationForm, 'nr9JGaC6pYXWMDjp55ly', FORM_IDS.localFellowsApplication]);
    const r = await runFormListTrigger({ contactId: 'c1' }, { dryRun: true });
    expect(r.rule).toBe('sama-application+local-application');
    expect(add.mock.calls[0][1]).toEqual(['sama', 'mainstreet_collective', 'local']);
  });
  it('a form with no rule is a skip, not an error', async () => {
    get.mockResolvedValue({ id: 'c1', lastAttribution: { medium: 'form', mediumId: 'nr9JGaC6pYXWMDjp55ly' }, customFields: [] });
    recent.mockResolvedValue([]);
    const r = await runFormListTrigger({ contactId: 'c1' });
    expect(r.skipped).toMatch(/no list rule/);
    expect(add).not.toHaveBeenCalled();
  });
  it('never throws', async () => {
    get.mockRejectedValueOnce(new Error('x'));
    recent.mockRejectedValue(new Error('down'));
    const r = await runFormListTrigger({ contactId: 'c1' });
    expect(r.error ?? r.skipped).toBeTruthy();
  });
});
