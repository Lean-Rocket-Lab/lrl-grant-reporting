// scripts-ts/metrics-period-remap.ts — move every metrics snapshot onto the CORRECT reporting window.
//
// THE CORRECTION. Zach, 2026-09-10: *"The Metric reporting cycles are April 1 – September 30 and
// October 1 – March 31. We send out surveys for the April–September window in September and October.
// We send out surveys for the October–March in March and April. We submit reports on the 15th of
// April and October for the previous periods."*
//
// `reportingPeriodFor()` was built from an earlier reading — "September for an October 15th date" —
// which got the COLLECTION months right and the WINDOW a month short (Feb-end/Aug-end instead of
// Mar-end/Sep-end). Every snapshot written under it is filed one month early. Measured: **189
// records** across eight boundaries, plus **189 Postgres claim rows** whose key embeds the period.
//
// WHY THE KEY MATTERS. Identity is `(source, source_record_id)` and the id is `<contactId>:<periodEnd>`.
// Repairing the FIELD without repairing the KEY leaves the claim pointing at a record whose period no
// longer matches it — so the next Client Reporting submission for that window computes the new key,
// finds no claim, and creates a SECOND snapshot for a half-year that already has one. A
// follow-on-funding figure counted twice still looks plausible on review, which is exactly why this
// script moves both halves or neither.
//
// ORDER IS DELIBERATE: the CLAIM is remapped first, then the record. If the run dies in between, the
// claim already resolves the new key to the existing record, so the next submission UPDATES it (and
// writes the corrected period as a side effect). The reverse order would leave the duplicate door open.
//
// THE NEW PERIOD IS RECOMPUTED, NOT SHIFTED. Every record's own submission date is re-run through the
// corrected `reportingPeriodFor()`: the imported ones carry it in `activity_notes` ("...submitted
// 2023-04-15..."), the live ones use the record's createdAt. A blind "+1 month" would agree for all
// 189 of these, but only because every submission fell in a collection month — it would silently
// mis-file an August or February submission, and this script should not be the thing that hides that.
//
//   npx vite-node scripts-ts/metrics-period-remap.ts                    # dry run
//   npx vite-node scripts-ts/metrics-period-remap.ts --apply --yes
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
import { reportingPeriodFor, reportingPeriodFromEnd, metricsActivityName } from '../lib/activities/reportingPeriod';

const APPLY = process.argv.includes('--apply');
const YES = process.argv.includes('--yes');
const OBJ = 'custom_objects.activities';

function env() {
  try {
    const t = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const l of t.split('\n')) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env.local (CI) — env is already populated */ }
}

interface Row {
  activityId: string;
  companyId: string | null;
  companyName: string;
  oldEnd: string;
  newEnd: string;
  oldKey: string;
  newKey: string;
  oldName: string;
  newName: string;
  submittedAt: string;
  submittedFrom: 'notes' | 'createdAt';
  claimId: string | null;
}

async function main() {
  env(); process.env.GHL_TARGET = 'live';
  if (APPLY && !YES) {
    console.error('--apply also requires --yes (this rewrites identity keys on live records).');
    process.exit(1);
  }
  const c = ghl();
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply --yes to write)\n');

  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const { writeRecordFields } = await import('../lib/ghl/writeRecord');
  const { logChange } = await import('../lib/audit/log');
  const { getDb } = await import('../lib/db/index');
  const { activitySourceClaims } = await import('../lib/db/schema');
  const { and, eq } = await import('drizzle-orm');
  const { getRelatedRecordIds } = await import('../lib/ghl/associations');
  const { getBusinessRecord } = await import('../lib/ghl/businesses');
  const catalog: any = await getCatalog(OBJ, { client: c });
  const db = getDb();

  const acts: any[] = [];
  for (let page = 1; page <= 40; page += 1) {
    const d: any = await c.request({
      method: 'POST', path: `/objects/${OBJ}/records/search`, autoLocation: false,
      body: { locationId: c.locationId, query: '', page, pageLimit: 100, searchAfter: [], sort: [{ field: 'updatedAt', direction: 'desc' }] },
    });
    const r = d.records ?? d.items ?? []; acts.push(...r); if (r.length < 100) break;
  }
  const metrics = acts.filter((a: any) => String(a.properties?.activity_type) === 'metrics');
  console.log(`activities ${acts.length}   metrics ${metrics.length}`);

  const claims = await db.select().from(activitySourceClaims);
  const claimByKey = new Map(claims.map((r: any) => [`${r.source} ${r.sourceRecordId}`, r]));
  // Every key already in use, so a remap can never be planned onto an occupied one.
  const takenKeys = new Set(claims.map((r: any) => `${r.source} ${r.sourceRecordId}`));
  const companyNameCache = new Map<string, string>();

  const plan: Row[] = [];
  const tally: Record<string, number> = {};
  const bump = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };

  for (const a of metrics) {
    const props = a.properties ?? {};
    const oldEnd = String(props.reporting_period ?? '').slice(0, 10);
    const oldKey = String(props.source_record_id ?? '');
    const source = 'Form';

    // The submission date, from the record itself. The imported snapshots carry it verbatim in their
    // provenance note; a live one has no note, and its createdAt IS the submission moment.
    const noted = String(props.activity_notes ?? '').match(/submitted (\d{4}-\d{2}-\d{2})/);
    const submittedAt = noted ? noted[1] : String(a.createdAt ?? a.dateAdded ?? '').slice(0, 10);
    if (!submittedAt) { bump('skip:no-submission-date'); continue; }
    const submittedFrom: Row['submittedFrom'] = noted ? 'notes' : 'createdAt';

    const p = reportingPeriodFor(submittedAt);
    if (p.end === oldEnd) { bump('noop:already-on-the-corrected-window'); continue; }

    // The company, for the name. Resolved from the association, not from the note.
    let companyId: string | null = null;
    try {
      const companies = await getRelatedRecordIds(a.id, 'business', c);
      companyId = companies[0] ?? null;
    } catch { companyId = null; }
    let companyName = '';
    if (companyId) {
      if (companyNameCache.has(companyId)) companyName = companyNameCache.get(companyId)!;
      else {
        const b = await getBusinessRecord(companyId, c).catch(() => null);
        companyName = String(b?.properties?.name ?? '');
        companyNameCache.set(companyId, companyName);
      }
    }
    if (!companyName) bump('note:company-name-unresolved (name keeps two segments)');

    const newKey = oldKey && oldKey.includes(':')
      ? `${oldKey.slice(0, oldKey.lastIndexOf(':'))}:${p.end}`
      : '';
    if (!newKey) { bump('skip:source_record_id is not `<id>:<period>`'); continue; }
    const claim = claimByKey.get(`${source} ${oldKey}`) ?? null;
    if (!claim) bump('warn:no claim row for the old key');
    if (claim && claim.activityRecordId && claim.activityRecordId !== a.id) {
      // The claim points somewhere else: remapping its key would attach this period to the wrong
      // record. Refuse the row rather than guess which of the two is real.
      bump('skip:claim points at a DIFFERENT activity'); continue;
    }
    if (takenKeys.has(`${source} ${newKey}`)) { bump('skip:the corrected key is already claimed'); continue; }

    plan.push({
      activityId: a.id, companyId, companyName,
      oldEnd, newEnd: p.end, oldKey, newKey,
      oldName: String(props.activity_name ?? ''),
      newName: metricsActivityName(companyName, p.label),
      submittedAt, submittedFrom,
      claimId: claim?.id ?? null,
    });
    bump(`move:${oldEnd} -> ${p.end}`);
    await new Promise((r) => setTimeout(r, 90));
  }

  console.log('\nOUTCOMES:', JSON.stringify(tally, null, 1));
  console.log(`\n${plan.length} snapshot(s) to remap. Window moves:`);
  const moves = new Map<string, number>();
  for (const r of plan) moves.set(`${r.oldEnd} -> ${r.newEnd}`, (moves.get(`${r.oldEnd} -> ${r.newEnd}`) ?? 0) + 1);
  for (const [m, n] of Array.from(moves.entries()).sort()) {
    const [from, to] = m.split(' -> ');
    console.log(`   ${m}   ${String(n).padStart(3)}   "${reportingPeriodFromEnd(from).label}" -> "${reportingPeriodFromEnd(to).label}"`);
  }
  console.log(`\nsubmission date read from: notes ${plan.filter((r) => r.submittedFrom === 'notes').length}   createdAt ${plan.filter((r) => r.submittedFrom === 'createdAt').length}`);
  console.log(`names gaining a company: ${plan.filter((r) => r.companyName && !r.oldName.includes(r.companyName)).length}/${plan.length}`);
  console.log(`claim rows to rekey: ${plan.filter((r) => r.claimId).length}/${plan.length}`);
  console.log('\nsample:');
  for (const r of plan.slice(0, 8)) {
    console.log(`   ${r.oldEnd} -> ${r.newEnd}  ${r.oldKey} -> ${r.newKey}`);
    console.log(`      "${r.oldName}"  ->  "${r.newName}"   (submitted ${r.submittedAt} via ${r.submittedFrom})`);
  }

  writeFileSync(join(process.cwd(), 'reports/metrics-period-remap.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), mode: APPLY ? 'apply' : 'dry-run', count: plan.length, plan }, null, 1));
  console.log('\n-> reports/metrics-period-remap.json');
  if (!APPLY) { console.log('nothing written.'); return; }

  let rekeyed = 0; let wrote = 0; const failed: any[] = [];
  for (const r of plan) {
    // 1. The claim FIRST — see the header. A half-done row must fail SAFE (no duplicate possible).
    if (r.claimId) {
      await db.update(activitySourceClaims).set({ sourceRecordId: r.newKey })
        .where(and(eq(activitySourceClaims.source, 'Form'), eq(activitySourceClaims.id, r.claimId)));
      rekeyed += 1;
    }
    // 2. Then the record: the window, the date it is filed under, its name, and its identity field.
    const fields: Record<string, unknown> = {
      reporting_period: r.newEnd,
      activity_date: r.newEnd,
      activity_name: r.newName,
      source_record_id: r.newKey,
    };
    const wasBefore: Record<string, unknown> = {
      reporting_period: r.oldEnd,
      activity_date: r.oldEnd,
      activity_name: r.oldName,
      source_record_id: r.oldKey,
    };
    try {
      const res = await writeRecordFields(OBJ, r.activityId, fields, catalog, c);
      if (res.skipped.length) failed.push({ activityId: r.activityId, skipped: res.skipped });
      if (res.written.length) {
        wrote += 1;
        await logChange({
          objectType: OBJ, recordId: r.activityId, recordLabel: r.newName,
          actorKind: 'sync', actorName: 'activity:metrics-period-remap', action: 'update',
          changes: res.written.map((k) => ({ field: `${OBJ}.${k}`, from: wasBefore[k], to: fields[k], source: 'Form' })),
          rationale: `reporting cycle corrected to Apr-Sep / Oct-Mar (Zach, 2026-09-10); submission ${r.submittedAt} re-derived`,
        });
      }
    } catch (e: any) {
      failed.push({ activityId: r.activityId, error: String(e?.message ?? e) });
    }
    await new Promise((res) => setTimeout(res, 320));
  }
  console.log(`\nclaims rekeyed: ${rekeyed}   records written: ${wrote}   failures: ${failed.length}`);
  if (failed.length) console.log(JSON.stringify(failed.slice(0, 10), null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
