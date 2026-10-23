// pages/api/rankings.ts — data + save for the Rankings page (pages/rankings.tsx).
//
//   GET  → every Profile (display fields, membership, every rank_*) in ONE search, plus the
//          placement table. Not cached: a stale list after a save would invite re-ranking from it.
//   POST { field, type, orderedIds, statuses?, baseline? } → plan, write, read back each record
//          directly, and return { updated, cleared, unchanged, skipped, ranks }.
//
// Behind the default-deny middleware (staff cookie). Do NOT add it to SELF_ENFORCING: it writes
// live GHL and has no secret of its own.

import type { NextApiRequest, NextApiResponse } from 'next';
import { DEFAULT_STATUSES, PLACEMENTS, STATUSES, placementFor } from '@/lib/rankings/placements';
import { RankPlanError } from '@/lib/rankings/plan';
import { loadRankingRows, saveRanking } from '@/lib/rankings/service';

// Worst case (a ~90-profile list fully renumbered) is ~2 paced calls per record ≈ 60 s.
export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      const profiles = await loadRankingRows();
      return res.status(200).json({ placements: PLACEMENTS, profiles });
    }
    if (req.method === 'POST') {
      const { field, type, orderedIds, statuses, baseline } = req.body ?? {};
      if (typeof field !== 'string' || !placementFor(field)) return res.status(400).json({ error: `unknown rank field: ${field}` });
      if (type !== 'person' && type !== 'resource') return res.status(400).json({ error: 'type must be person or resource' });
      if (!Array.isArray(orderedIds) || !orderedIds.every((x) => typeof x === 'string')) {
        return res.status(400).json({ error: 'orderedIds must be an array of record ids' });
      }
      const scope: string[] = Array.isArray(statuses) && statuses.length ? statuses : DEFAULT_STATUSES;
      if (!scope.every((s) => (STATUSES as readonly string[]).includes(s))) return res.status(400).json({ error: `bad statuses: ${scope}` });
      const result = await saveRanking({ field, type, orderedIds, statuses: scope, baseline: baseline && typeof baseline === 'object' ? baseline : undefined });
      return res.status(200).json(result);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    if (error instanceof RankPlanError) return res.status(400).json({ error: error.message });
    // Print the whole GHL body — a truncated error is how the modifier contract stayed hidden.
    console.error('[api/rankings] failed:', error?.body ?? error);
    return res.status(500).json({ error: error?.message ?? 'Rankings request failed' });
  }
}
