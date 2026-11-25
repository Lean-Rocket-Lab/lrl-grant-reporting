// The writer: add-only, noop on re-delivery, verified by read-back.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../ghl/contacts', () => ({ getContact: vi.fn(), setContactCustomFields: vi.fn() }));
vi.mock('../../audit/log', () => ({ logChange: vi.fn(async () => {}) }));
vi.mock('../../ghl/client', () => ({ ghl: () => ({}) }));

import { getContact, setContactCustomFields } from '../../ghl/contacts';
import { addContactToLists } from '../apply';
import { LIST_FIELDS } from '../fields';

const get = getContact as unknown as ReturnType<typeof vi.fn>;
const set = setContactCustomFields as unknown as ReturnType<typeof vi.fn>;
const on = (...keys: (keyof typeof LIST_FIELDS)[]) => keys.map((k) => ({ id: LIST_FIELDS[k].fieldId, value: ['Subscribed'] }));

beforeEach(() => { get.mockReset(); set.mockReset(); });

describe('addContactToLists', () => {
  it('writes only the missing lists, as [LABELS], and verifies', async () => {
    get.mockResolvedValueOnce({ id: 'c1', customFields: on('sama') }).mockResolvedValueOnce({ id: 'c1', customFields: on('sama', 'manutech') });
    const r = await addContactToLists('c1', ['sama', 'manutech'], { source: 'event' });
    expect(set).toHaveBeenCalledWith('c1', [{ id: LIST_FIELDS.manutech.fieldId, value: ['Subscribed'] }], expect.anything());
    expect(r).toMatchObject({ status: 'added', already: ['sama'], added: ['manutech'], unverified: [] });
  });
  it('re-delivery is a noop with zero writes', async () => {
    get.mockResolvedValue({ id: 'c1', customFields: on('sama') });
    const r = await addContactToLists('c1', ['sama'], { source: 'form' });
    expect(set).not.toHaveBeenCalled();
    expect(r.status).toBe('noop');
  });
  it('adds LOCAL with Mainstreet', async () => {
    get.mockResolvedValueOnce({ id: 'c1', customFields: [] }).mockResolvedValueOnce({ id: 'c1', customFields: on('local', 'mainstreet_collective') });
    const r = await addContactToLists('c1', ['local'], { source: 'form' });
    expect(r.added).toEqual(['mainstreet_collective', 'local']);
  });
  it('never removes: lists not asked for are untouched', async () => {
    get.mockResolvedValueOnce({ id: 'c1', customFields: on('coworking') }).mockResolvedValueOnce({ id: 'c1', customFields: on('coworking', 'sama') });
    await addContactToLists('c1', ['sama'], { source: 'form' });
    const written = set.mock.calls[0][1].map((f: any) => f.id);
    expect(written).toEqual([LIST_FIELDS.sama.fieldId]);
  });
  it('a write that does not persist is reported, not claimed', async () => {
    get.mockResolvedValue({ id: 'c1', customFields: [] });
    const r = await addContactToLists('c1', ['sama'], { source: 'form' });
    expect(r).toMatchObject({ status: 'error', added: [], unverified: ['sama'] });
  });
  it('dry run writes nothing', async () => {
    get.mockResolvedValue({ id: 'c1', customFields: [] });
    const r = await addContactToLists('c1', ['sama'], { source: 'form', dryRun: true });
    expect(set).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: 'dry-run', added: ['sama'] });
  });
  it('a GHL error is reported, never thrown', async () => {
    get.mockResolvedValue({ id: 'c1', customFields: [] });
    set.mockRejectedValue(Object.assign(new Error('boom'), { status: 422 }));
    const r = await addContactToLists('c1', ['sama'], { source: 'form' });
    expect(r.status).toBe('error');
    expect(r.error).toContain('422');
  });
});
