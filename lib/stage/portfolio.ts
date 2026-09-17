// lib/stage/portfolio.ts — the portfolio-wide read of client readiness: every company that has ever
// been scored, with the stage it holds now and the stage it held at intake.
//
// The data already exists. `lib/stage/writeStageRecord.ts` APPENDS a new `custom_objects.business_stage`
// record per scoring event and associates it to the company, which makes per-company scoring history a
// property of the object rather than something this module has to reconstruct. All this does is fold
// that history down to (initial, current) per scale.
//
// READ-ONLY. Nothing here writes to GHL, so none of the write-path rules in CLAUDE.md apply; the
// ~12-second search-index lag is also harmless here (a scoring event that landed seconds ago simply
// shows up on the next refresh).

import { GhlClient, ghl } from '../ghl/client';
import { STAGE_OBJECT } from './priorAssessment';

/** The four scales a stage record can carry. `churchill` is the service path, the rest are tech. */
export const SCALES = ['trl', 'mrl', 'crl', 'churchill'] as const;
export type Scale = (typeof SCALES)[number];

/** Highest value each scale can take, for axis construction. */
export const SCALE_MAX: Record<Scale, number> = { trl: 9, mrl: 10, crl: 9, churchill: 5 };

export interface ScorePair {
  /** Earliest non-null value for this scale, i.e. where the company came in. */
  initial: number | null;
  /** Latest non-null value for this scale. */
  current: number | null;
}

export interface PortfolioRow {
  companyId: string;
  name: string;
  /** Raw `business_model` option key off the company record, or null when never answered. */
  businessModel: string | null;
  /** How many stage records this company has. 1 means there is no movement to show yet. */
  snapshots: number;
  firstDate: string | null;
  lastDate: string | null;
  scores: Record<Scale, ScorePair>;
  /** Sum of (current - initial) across every scale where both ends exist. */
  advanced: number;
  /** How many scales contributed to `advanced`. Zero means the number is not meaningful. */
  scalesCompared: number;
}

export interface Portfolio {
  rows: PortfolioRow[];
  /** Total stage records read, for reconciling against GHL. */
  recordCount: number;
  generatedAt: string;
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const str = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s || null;
};

/**
 * Page size for the object search.
 *
 * ⚠️ **500 is above the documented 100 and was MEASURED, not assumed** (2026-09-17): one page of 500
 * companies returns in 4.1s, the same wall time as a page of 100, because the cost is per REQUEST and
 * not per record. At 100 the company sweep is 10 sequential round trips and the endpoint takes ~25s;
 * at 500 it is 2 and takes ~8s. That is the whole difference between a dashboard tile that paints and
 * one that looks broken. If GHL ever caps this back to 100 the loop below still terminates correctly
 * (a short page ends it), it just gets slow again — so a sudden slowdown here is the thing to check.
 */
const SEARCH_PAGE = 500;

/**
 * Page a whole custom object through `POST /objects/{key}/records/search`.
 *
 * Paging is by `searchAfter` echoed off the last record, NOT by incrementing `page` — the page
 * parameter is pinned at 1 and the cursor does the work. Getting this wrong returns the first
 * page forever, which looks like a small dataset rather than a bug.
 */
async function searchAllRecords(objectKey: string, client: GhlClient): Promise<any[]> {
  const out: any[] = [];
  let searchAfter: unknown[] | undefined;
  // Bounded so a cursor that stops advancing cannot spin forever.
  for (let i = 0; i < 100; i++) {
    const data = await client.request<any>({
      method: 'POST',
      path: `/objects/${objectKey}/records/search`,
      autoLocation: false,
      body: {
        locationId: client.locationId,
        page: 1,
        pageLimit: SEARCH_PAGE,
        ...(searchAfter ? { searchAfter } : {}),
      },
    });
    const batch: any[] = data.records ?? data.data ?? [];
    if (batch.length === 0) break;
    out.push(...batch);
    const next = batch[batch.length - 1]?.searchAfter;
    if (batch.length < SEARCH_PAGE || !next) break;
    searchAfter = next;
  }
  return out;
}

/** The company a stage record is associated to, via the `business` side of its relations. */
const companyIdOf = (record: any): string | null =>
  record?.relations?.find((r: any) => r?.objectKey === 'business')?.recordId ?? null;

/** Sort key for a stage record: the assessment date, falling back to creation time. */
const orderKey = (record: any): string =>
  `${str(record?.properties?.rescore_date) ?? ''}|${str(record?.createdAt) ?? ''}`;

/**
 * Fold a company's stage records into one row.
 *
 * `initial` and `current` are resolved PER SCALE rather than per record, because a single company can
 * have records that carry only the Churchill score and records that carry only TRL/MRL/CRL (the scorer
 * routes on business model). Taking scale values off the first and last records wholesale would read
 * a missing value as "no history" for exactly the companies that switched paths.
 */
export function foldCompanyRecords(companyId: string, name: string, businessModel: string | null, records: any[]): PortfolioRow {
  const sorted = records.slice().sort((a, b) => orderKey(a).localeCompare(orderKey(b)));
  const valueOf = (rec: any, scale: Scale) =>
    num(rec?.properties?.[scale === 'churchill' ? 'churchill_score' : scale]);

  const scores = {} as Record<Scale, ScorePair>;
  let advanced = 0;
  let scalesCompared = 0;
  for (const scale of SCALES) {
    let initial: number | null = null;
    let current: number | null = null;
    for (const rec of sorted) {
      const v = valueOf(rec, scale);
      if (v == null) continue;
      if (initial == null) initial = v;
      current = v;
    }
    scores[scale] = { initial, current };
    if (initial != null && current != null) {
      advanced += current - initial;
      scalesCompared++;
    }
  }

  return {
    companyId,
    name,
    businessModel,
    snapshots: sorted.length,
    firstDate: str(sorted[0]?.properties?.rescore_date),
    lastDate: str(sorted[sorted.length - 1]?.properties?.rescore_date),
    scores,
    advanced,
    scalesCompared,
  };
}

/**
 * Read every scored company and fold its history. Two paged searches, no per-company GETs: resolving
 * names one company at a time is ~80 sequential round trips and is what makes this feel broken.
 */
export async function loadPortfolio(client: GhlClient = ghl()): Promise<Portfolio> {
  const [stageRecords, companies] = await Promise.all([
    searchAllRecords(STAGE_OBJECT, client),
    searchAllRecords('business', client),
  ]);

  const meta = new Map<string, { name: string; businessModel: string | null }>();
  for (const c of companies) {
    meta.set(c.id, {
      name: str(c?.properties?.name) ?? c.id,
      businessModel: str(c?.properties?.business_model),
    });
  }

  const byCompany = new Map<string, any[]>();
  for (const rec of stageRecords) {
    const companyId = companyIdOf(rec);
    // A stage record with no company association cannot be placed on the map. It is not dropped
    // silently: recordCount below still counts it, so the totals reconcile against GHL.
    if (!companyId) continue;
    const list = byCompany.get(companyId);
    if (list) list.push(rec);
    else byCompany.set(companyId, [rec]);
  }

  const rows: PortfolioRow[] = [];
  byCompany.forEach((records, companyId) => {
    const m = meta.get(companyId);
    rows.push(foldCompanyRecords(companyId, m?.name ?? companyId, m?.businessModel ?? null, records));
  });
  rows.sort((a, b) => b.advanced - a.advanced || a.name.localeCompare(b.name));

  return { rows, recordCount: stageRecords.length, generatedAt: new Date().toISOString() };
}
