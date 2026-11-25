import { describe, it, expect, vi } from 'vitest';
vi.mock('../../sheets', () => ({ sheets: {} }));
import { parseEventSheet, findEventRow } from '../eventMap';

const values = [
  ['Embed Code', 'URL', 'Event Name', 'Tags'],
  ['<iframe src="https://go.leanrocketlab.org/events/event-details/6acfa6faabd90c1531f8afd3"', 'https://go.leanrocketlab.org/events/event-details/6acfa6faabd90c1531f8afd3', 'Coffee + Connect', 'lean-startup'],
  ['<iframe src="https://go.leanrocketlab.org/events/event-details/6abe9a286cd68ec6b867a922"', 'https://go.leanrocketlab.org/events/manutech', 'Manutech LIVE Innovation Experience 2026', 'sama, manutech'],
  ['', '', 'Old School Tactics', ''],
];

describe('Event_list_db', () => {
  const rows = parseEventSheet(values);
  it('parses the event id from the embed code even when the URL is a slug', () => {
    expect(rows[1]).toEqual({ eventId: '6abe9a286cd68ec6b867a922', name: 'Manutech LIVE Innovation Experience 2026', tags: 'sama, manutech' });
    expect(rows[2].eventId).toBeNull();
  });
  it('matches by id first, then by normalised name', () => {
    expect(findEventRow(rows, '6abe9a286cd68ec6b867a922', 'wrong name')?.matchedBy).toBe('id');
    expect(findEventRow(rows, 'unknownid0000000000', '  coffee  +  connect ')?.row.name).toBe('Coffee + Connect');
    expect(findEventRow(rows, undefined, 'nope')).toBeNull();
  });
  it('refuses a sheet without the needed columns', () => {
    expect(() => parseEventSheet([['A', 'B'], ['x', 'y']])).toThrow(/Event Name/);
  });
});
