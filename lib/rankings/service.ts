// lib/rankings/service.ts — load Profiles for the Rankings page, and save one ranked list.
//
// Two live facts shape this file:
//   - THE OBJECT SEARCH LAGS WRITES BY ~12 s (CLAUDE.md). A search straight after a save shows the
//     OLD ranks. So a save is never verified through search (each write is read back with a direct
//     GET), and when the page's own baseline disagrees with the search we trust neither and GET the
//     record. Without that, "rank 2 → 3, then back to 2" within 12 s would plan as a no-op (search
//     still says 2) and leave 3 on the record.
//   - CLEARING A NUMBER: `null` clears it; an empty string `''` hangs the request (measured
//     2026-10-23). `writeRecordFields` refuses empty values by design, so clears are a direct PUT.
//
// Every GHL call goes through a client paced to ≥0.3 s apart (GHL_MAX_RPS=3 discipline).

import { GhlClient, ghl } from '../ghl/client';
import { getCatalog } from '../ghl/catalogCache';
import { fileUrls } from '../ghl/fileValue';
import { writeRecordFields } from '../ghl/writeRecord';
import { PROFILES_OBJECT, RANK_FIELDS, placementFor, type ProfileStatus, type ProfileType } from './placements';
import { planRanking, type RankProfile } from './plan';

const MIN_GAP_MS = 300;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wraps a client so its calls are serialized and spaced ≥ MIN_GAP_MS apart, including inside helpers. */
class PacedClient extends GhlClient {
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly inner: GhlClient) {
    super(inner.config);
  }
  override request<T = any>(opts: Parameters<GhlClient['request']>[0]): Promise<T> {
    const run = async () => {
      const wait = this.last + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await this.inner.request<T>(opts);
      } finally {
        this.last = Date.now();
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

export interface RankingRow extends RankProfile {
  subtitle: string | null;
  thumb: string | null;
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)]);
const str = (v: unknown): string | null => (v == null || String(v).trim() === '' ? null : String(v).trim());
const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function ranksOf(props: Record<string, any>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const f of RANK_FIELDS) out[f] = num(props[f]);
  return out;
}

/** Reduce a raw GHL record to display fields + membership + every rank_*, nothing else. */
export function toRankingRow(record: any): RankingRow {
  const p = record?.properties ?? {};
  const type = str(p.profile_type) as ProfileType | null;
  return {
    id: String(record.id),
    name: str(p.display_name) ?? '(unnamed)',
    profileType: type,
    profileStatus: str(p.profile_status) as ProfileStatus | null,
    roles: arr(p.roles),
    programs: arr(p.programs),
    collectives: arr(p.collectives),
    ranks: ranksOf(p),
    subtitle: type === 'resource' ? str(p.category) ?? str(p.short_description) : str(p.job_title) ?? str(p.company_name),
    thumb: fileUrls(p.headshot)[0] ?? str(p.headshot_url) ?? fileUrls(p.company_logo)[0] ?? null,
  };
}

/** Every Profile in ONE search (≈141 today; pageLimit 500). Never cached: a save must be visible. */
async function searchProfiles(client: GhlClient): Promise<RankingRow[]> {
  const data = await client.request<any>({
    method: 'POST',
    path: `/objects/${PROFILES_OBJECT}/records/search`,
    autoLocation: false,
    body: { locationId: client.locationId, page: 1, pageLimit: 500 },
  });
  const records: any[] = data.records ?? data.data ?? [];
  if (records.length >= 500) console.warn('[rankings] search returned 500 profiles — add paging before this truncates');
  return records.map(toRankingRow);
}

/**
 * Writes this lambda made in the last two minutes, laid over search results so a reload right after
 * a save does not show the pre-save order while the index catches up. Per-lambda only; the save path
 * does not depend on it (it reconciles against the page's baseline with direct GETs).
 */
const OVERLAY_MS = 2 * 60 * 1000;
const overlay = new Map<string, { at: number; value: number | null }>();
const overlayKey = (id: string, field: string) => `${id}:${field}`;

function applyOverlay(rows: RankingRow[]): RankingRow[] {
  const now = Date.now();
  for (const [k, v] of Array.from(overlay.entries())) if (now - v.at > OVERLAY_MS) overlay.delete(k);
  if (!overlay.size) return rows;
  for (const r of rows) {
    for (const f of RANK_FIELDS) {
      const hit = overlay.get(overlayKey(r.id, f));
      if (hit) r.ranks[f] = hit.value;
    }
  }
  return rows;
}

export async function loadRankingRows(client: GhlClient = ghl()): Promise<RankingRow[]> {
  return applyOverlay(await searchProfiles(client));
}

async function readProps(id: string, client: GhlClient): Promise<Record<string, any>> {
  const data = await client.request<any>({ path: `/objects/${PROFILES_OBJECT}/records/${id}` });
  return (data.record ?? data)?.properties ?? {};
}

export interface SaveRequest {
  field: string;
  type: ProfileType;
  orderedIds: string[];
  statuses: string[];
  /** What the page believes each in-scope profile's rank is right now (id → rank | null). */
  baseline?: Record<string, number | null>;
}

export interface SaveResult {
  updated: Array<{ id: string; from: number | null; to: number }>;
  cleared: Array<{ id: string; from: number }>;
  unchanged: string[];
  skipped: Array<{ id: string; reason: string }>;
  /** The verified stored rank of every profile this save wrote or tried to write. */
  ranks: Record<string, number | null>;
}

export async function saveRanking(req: SaveRequest, base: GhlClient = ghl()): Promise<SaveResult> {
  const placement = placementFor(req.field);
  if (!placement) throw new Error(`unknown rank field: ${req.field}`);
  const client = new PacedClient(base);
  const field = placement.field;

  const rows = applyOverlay(await searchProfiles(client));
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Where the page and the (possibly lagging) search disagree, a direct GET decides.
  for (const [id, believed] of Object.entries(req.baseline ?? {})) {
    const row = byId.get(id);
    if (!row || (row.ranks[field] ?? null) === (believed ?? null)) continue;
    row.ranks = ranksOf(await readProps(id, client));
  }

  const plan = planRanking({ profiles: rows, placement, type: req.type, orderedIds: req.orderedIds, statuses: req.statuses });
  const result: SaveResult = { updated: [], cleared: [], unchanged: plan.unchanged, skipped: [], ranks: {} };
  const remember = (id: string, value: number | null) => {
    result.ranks[id] = value;
    overlay.set(overlayKey(id, field), { at: Date.now(), value });
  };

  if (plan.set.length) {
    const catalog = await getCatalog(PROFILES_OBJECT, { client });
    for (const s of plan.set) {
      try {
        // writeRecordFields → applyObjectWrite: PUT, then a direct GET read-back; `written` holds
        // only what GHL actually stored.
        const w = await writeRecordFields(PROFILES_OBJECT, s.id, { [field]: s.to }, catalog, client);
        if (w.written.includes(field)) {
          result.updated.push(s);
          remember(s.id, s.to);
        } else {
          result.skipped.push({ id: s.id, reason: w.skipped.map((x) => x.reason).join('; ') || 'not written' });
          result.ranks[s.id] = s.from;
        }
      } catch (e: any) {
        console.error(`[rankings] set ${field}=${s.to} on ${s.id} failed:`, e?.body ?? e);
        result.skipped.push({ id: s.id, reason: e?.message ?? String(e) });
        result.ranks[s.id] = s.from;
      }
    }
  }

  for (const c of plan.clear) {
    try {
      // `null` clears a NUMERICAL. NEVER '' — that hangs the request.
      await client.request({ method: 'PUT', path: `/objects/${PROFILES_OBJECT}/records/${c.id}`, body: { properties: { [field]: null } } });
      const stored = num((await readProps(c.id, client))[field]);
      if (stored == null) {
        result.cleared.push(c);
        remember(c.id, null);
      } else {
        result.skipped.push({ id: c.id, reason: `clear did not persist (GHL returned 200; stored ${stored})` });
        result.ranks[c.id] = stored;
      }
    } catch (e: any) {
      console.error(`[rankings] clear ${field} on ${c.id} failed:`, e?.body ?? e);
      result.skipped.push({ id: c.id, reason: e?.message ?? String(e) });
      result.ranks[c.id] = c.from;
    }
  }

  return result;
}
