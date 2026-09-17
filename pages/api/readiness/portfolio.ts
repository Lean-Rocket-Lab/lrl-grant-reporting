// pages/api/readiness/portfolio.ts — the readiness map's data source.
//
// GET only, read-only, and behind the default-deny middleware like everything else that is not a
// webhook receiver. There is deliberately NO public variant: the map is embedded in a GHL dashboard,
// where the viewer is a signed-in staff member whose `lrl_staff` cookie rides along because
// `staffSession.ts` sets SameSite=None (see middleware.ts on why the app has zero public routes).
//
// Cached in module scope for CACHE_MS, matching the app's other 10-minute per-lambda caches. Two
// paged GHL searches is ~11 round trips; without this, every dashboard load pays for them, and a
// dashboard is a page people leave open and refresh. `?fresh=1` bypasses it.

import type { NextApiRequest, NextApiResponse } from 'next';
import { loadPortfolio, Portfolio, SCALE_MAX } from '@/lib/stage/portfolio';

const CACHE_MS = 10 * 60 * 1000;

let cached: { at: number; data: Portfolio } | null = null;
/** In-flight promise, so N concurrent cold loads make ONE pair of searches rather than N. */
let inFlight: Promise<Portfolio> | null = null;

async function getPortfolio(fresh: boolean): Promise<{ data: Portfolio; cacheAge: number }> {
  const now = Date.now();
  if (!fresh && cached && now - cached.at < CACHE_MS) {
    return { data: cached.data, cacheAge: Math.round((now - cached.at) / 1000) };
  }
  if (!inFlight) {
    inFlight = loadPortfolio()
      .then((data) => {
        cached = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return { data: await inFlight, cacheAge: 0 };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { data, cacheAge } = await getPortfolio(req.query.fresh === '1');
    res.status(200).json({ ...data, scaleMax: SCALE_MAX, cacheAge });
  } catch (error: any) {
    // Print the whole body: a truncated GHL error is how the modifier contract stayed hidden for six
    // weeks (CLAUDE.md). This route only reads, but the habit is the point.
    console.error('[readiness/portfolio] load failed:', error?.body ?? error);
    res.status(500).json({ error: error?.message ?? 'Failed to load the readiness portfolio' });
  }
}
