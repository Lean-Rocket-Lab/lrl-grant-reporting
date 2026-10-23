// saveRanking against a fake location: clears send null (never ''), every write is read back with a
// direct GET, and a lagging search is overruled by the page's baseline.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../ghl/catalogCache', () => ({
  getCatalog: vi.fn(async () => ({
    byKey: {
      'custom_objects.profiles.rank_local': { id: 'rl', name: 'Rank LOCAL', fieldKey: 'custom_objects.profiles.rank_local', dataType: 'NUMERICAL' },
    },
    byId: {},
  })),
}));

import { saveRanking } from '../service';
import type { GhlClient } from '../../ghl/client';

const OBJ = 'custom_objects.profiles';

function fakeClient(stored: Record<string, Record<string, unknown>>, searchView?: Record<string, Record<string, unknown>>) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const client = {
    config: { apiKey: 'x', apiVersion: 'v', baseUrl: 'http://fake', locationId: 'loc', userAgent: 'test', target: 'sandbox' },
    locationId: 'loc',
    async request(opts: { method?: string; path: string; body?: any }) {
      const method = opts.method ?? 'GET';
      calls.push({ method, path: opts.path, body: opts.body });
      if (method === 'POST' && opts.path === `/objects/${OBJ}/records/search`) {
        const view = searchView ?? stored;
        return { records: Object.entries(view).map(([id, properties]) => ({ id, properties: { ...properties } })) };
      }
      const m = opts.path.match(/records\/([^/]+)$/);
      if (m && method === 'GET') return { record: { id: m[1], properties: { ...stored[m[1]] } } };
      if (m && method === 'PUT') {
        for (const [k, v] of Object.entries(opts.body.properties)) {
          if (v === '') throw new Error('empty string would hang the live API');
          stored[m[1]][k] = v;
        }
        return {};
      }
      throw new Error(`unexpected ${method} ${opts.path}`);
    },
  };
  return { client: client as unknown as GhlClient, calls };
}

const person = (rank: number | null) => ({ profile_type: 'person', profile_status: 'published', programs: ['local'], display_name: 'x', rank_local: rank });

// Ids are unique per test: the service keeps a per-lambda overlay of its own recent writes.
describe('saveRanking', () => {
  it('sets, clears with null, reads each record back directly, and reports noop', async () => {
    const stored = { a: person(1), b: person(2), c: person(3) };
    const { client, calls } = fakeClient(stored);
    const r = await saveRanking({ field: 'rank_local', type: 'person', orderedIds: ['a', 'c'], statuses: ['published'] }, client);
    expect(r.unchanged).toEqual(['a']);
    expect(r.updated).toEqual([{ id: 'c', from: 3, to: 2 }]);
    expect(r.cleared).toEqual([{ id: 'b', from: 2 }]);
    expect(r.skipped).toEqual([]);
    expect(stored.b.rank_local).toBeNull();
    expect(stored.c.rank_local).toBe(2);
    const clearPut = calls.find((c) => c.method === 'PUT' && c.path.endsWith('/b'));
    expect(clearPut?.body).toEqual({ properties: { rank_local: null } });
    // Read-back is a direct GET of each written record, never a search.
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.path.split('/').pop()).sort()).toEqual(['b', 'c']);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('an untouched list makes zero writes', async () => {
    const { client, calls } = fakeClient({ d: person(1), e: person(2) });
    const r = await saveRanking({ field: 'rank_local', type: 'person', orderedIds: ['d', 'e'], statuses: ['published'] }, client);
    expect(r.updated).toEqual([]);
    expect(r.cleared).toEqual([]);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('when the search lags the page baseline, a direct GET decides', async () => {
    // Stored is 3, the lagging search still says 2, the page knows 3. Moving it back to 2 must write.
    const stored = { f: person(1), g: person(3) };
    const { client, calls } = fakeClient(stored, { f: person(1), g: person(2) });
    const r = await saveRanking(
      { field: 'rank_local', type: 'person', orderedIds: ['f', 'g'], statuses: ['published'], baseline: { f: 1, g: 3 } },
      client,
    );
    expect(r.updated).toEqual([{ id: 'g', from: 3, to: 2 }]);
    expect(stored.g.rank_local).toBe(2);
    expect(calls.some((c) => c.method === 'PUT' && c.path.endsWith('/g'))).toBe(true);
  });
});
