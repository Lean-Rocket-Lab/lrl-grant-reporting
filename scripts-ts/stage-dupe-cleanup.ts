// scripts-ts/stage-dupe-cleanup.ts — delete the REDUNDANT same-day stage records.
// Dry-run by default; --apply --yes to delete (house rule, and this is destructive).
//
//   npx vite-node scripts-ts/stage-dupe-cleanup.ts
//   npx vite-node scripts-ts/stage-dupe-cleanup.ts --apply --yes
//
// WHAT COUNTS AS REDUNDANT, and what deliberately does NOT.
//
// `writeStageRecord.ts` appends a record per scoring EVENT on purpose — a company's scoring HISTORY.
// Measured 2026-09-04: 31 companies hold several records on DIFFERENT days and every one of them is
// correct. Lean Rocket Lab has five, four of which are genuine rescores (07-31, 08-04, 08-05, 08-11).
// **Those are never touched.**
//
// A bug is only ever two records for one company on ONE day, which the (company, day) claim added in
// `lib/stage/stageDayClaim.ts` now prevents. This cleans up the ones created before that existed:
// keep the NEWEST per (company, day) and delete the rest, because the newest is the one a same-day
// re-score was trying to produce.
//
// ⚠️ Ids are printed in FULL. An earlier audit truncated them to 8 characters and two distinct
// records created in the same second looked like one id repeated — which was misread as a record
// associated to its company twice. `getRelatedRecordIds` de-duplicates, so that could not happen.
// Truncated ids in a destructive script are how the wrong row gets deleted.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';

const APPLY = process.argv.includes('--apply');
const YES = process.argv.includes('--yes');
// Local dev reads .env.local; in CI the secrets are real env vars and the file does not exist.
function env() {
  try {
    const t = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const l of t.split('\n')) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env.local (CI) — env is already populated */ }
}

async function main() {
  env(); process.env.GHL_TARGET = 'live';
  if (APPLY && !YES) {
    console.error('Refusing to DELETE without --yes. This permanently removes stage records. Re-run with --apply --yes.');
    process.exit(1);
  }
  const c = ghl();
  console.log(APPLY ? 'MODE: APPLY (deletes)\n' : 'MODE: DRY RUN (pass --apply --yes to delete)\n');

  const { STAGE_OBJECT } = await import('../lib/stage/priorAssessment');
  const { getRelatedRecordIds } = await import('../lib/ghl/associations');
  const { deleteObjectRecord } = await import('../lib/ghl/createRecord');
  const { logChange } = await import('../lib/audit/log');

  const recs: any[] = [];
  for (let page = 1; page <= 60; page += 1) {
    const d: any = await c.request({
      method: 'POST', path: `/objects/${STAGE_OBJECT}/records/search`, autoLocation: false,
      body: { locationId: c.locationId, query: '', page, pageLimit: 100, searchAfter: [], sort: [{ field: 'updatedAt', direction: 'desc' }] },
    });
    const r = d.records ?? d.items ?? []; recs.push(...r); if (r.length < 100) break;
  }
  console.log(`${STAGE_OBJECT}: ${recs.length} record(s)`);

  const byCompany = new Map<string, any[]>();
  for (const r of recs) {
    const ids = await getRelatedRecordIds(r.id, 'business', c).catch(() => [] as string[]);
    for (const id of ids) { const a = byCompany.get(id) ?? []; a.push(r); byCompany.set(id, a); }
    await new Promise((x) => setTimeout(x, 105));
  }

  const doomed: Array<{ companyId: string; name: string; day: string; keep: string; keepCreated: string; drop: Array<{ id: string; created: string }> }> = [];
  for (const [companyId, v] of Array.from(byCompany.entries())) {
    const byDay = new Map<string, any[]>();
    for (const r of v) {
      const p = r.properties ?? {};
      const day = String(p.rescore_date ?? '').slice(0, 10) || String(r.createdAt ?? '').slice(0, 10);
      const a = byDay.get(day) ?? []; a.push(r); byDay.set(day, a);
    }
    for (const [day, rs] of Array.from(byDay.entries())) {
      if (rs.length < 2) continue;
      // Newest wins. `createdAt` is the truth here; the search sort is by updatedAt.
      const sorted = [...rs].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
      const keep = sorted[0];
      doomed.push({
        companyId,
        name: String((keep.properties ?? {}).name ?? '').split('—')[0].trim(),
        day,
        keep: keep.id,
        keepCreated: String(keep.createdAt ?? ''),
        drop: sorted.slice(1).map((r) => ({ id: r.id, created: String(r.createdAt ?? '') })),
      });
    }
  }

  const total = doomed.reduce((n, d) => n + d.drop.length, 0);
  console.log(`\n${doomed.length} company+day pair(s) with duplicates · ${total} record(s) to delete\n`);
  for (const d of doomed.sort((a, b) => b.drop.length - a.drop.length)) {
    console.log(`${d.day}  ${d.name}`);
    console.log(`   KEEP   ${d.keep}  created ${d.keepCreated}`);
    for (const x of d.drop) console.log(`   DELETE ${x.id}  created ${x.created}`);
  }
  // Sanity: every id must be distinct, or the plan is confused about what it is deleting.
  const allIds = doomed.flatMap((d) => [d.keep, ...d.drop.map((x) => x.id)]);
  const dupIds = allIds.filter((x, i) => allIds.indexOf(x) !== i);
  console.log(`\nid sanity — every id distinct: ${dupIds.length === 0}${dupIds.length ? ` (repeated: ${dupIds.join(', ')})` : ''}`);

  writeFileSync(join(process.cwd(), 'reports/stage-dupe-cleanup.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), mode: APPLY ? 'apply' : 'dry-run', pairs: doomed.length, toDelete: total, doomed }, null, 1));
  console.log('→ reports/stage-dupe-cleanup.json');
  if (!APPLY) { console.log('\nnothing deleted.'); return; }
  if (dupIds.length) { console.error('\nrefusing to delete: the plan repeats an id'); process.exit(1); }

  let gone = 0;
  for (const d of doomed) {
    for (const x of d.drop) {
      await deleteObjectRecord(STAGE_OBJECT, x.id, c);
      gone += 1;
      await logChange({
        objectType: STAGE_OBJECT, recordId: x.id, recordLabel: `${d.name} — ${d.day}`,
        actorKind: 'sync', actorName: 'stage-dupe-cleanup', action: 'update',
        changes: [{ field: 'record', from: 'exists', to: 'deleted', source: 'Manual' }],
        rationale: `redundant same-day stage record; kept ${d.keep} (newest for ${d.name} on ${d.day})`,
        applied: true,
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 320));
    }
  }
  console.log(`\ndeleted ${gone}/${total} record(s)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
