// scripts-ts/msrl-churchill-retire.ts — phase 5 of docs/sprints/msrl-migration.md: archive every
// Churchill value, then DELETE the Churchill fields from business_stage, business and contact.
// Zach's decision 2026-10-21: delete after migration, once MSRL baselines exist.
//
//   ~/tools/node_modules/.bin/tsx scripts-ts/msrl-churchill-retire.ts                # DRY RUN + archive
//   ~/tools/node_modules/.bin/tsx scripts-ts/msrl-churchill-retire.ts --apply --yes  # DELETE (irreversible)
//
// Two hard gates before any delete:
//   1. the archive file was written this run (docs/audits/<date>-churchill-archive/), because
//      submitted funder reports cite Churchill numbers and GHL keeps nothing once a field is deleted;
//   2. every company holding a Churchill score ALSO holds an MSRL score on some stage record
//      (no service-path client is left with no score at all). --force-gap overrides, by name only.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

for (const l of (() => { try { return readFileSync(join(process.cwd(), '.env.local'), 'utf8'); } catch { return ''; } })().split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
const APPLY = process.argv.includes('--apply') && process.argv.includes('--yes');
const FORCE_GAP = process.argv.includes('--force-gap');

const STAGE = 'custom_objects.business_stage';
const STAGE_KEYS = ['churchill_score', 'churchill_substage'];
/** Bare keys on BOTH business and contact. Missing ones are skipped (several were deleted 2026-08-04). */
const COMPANY_CONTACT_KEYS = [
  'churchill_current', 'churchill_substage_current', 'latest_churchill_stage_rationale',
  'churchill_initial', 'churchill_substage_initial', 'churchill_advancement',
];

async function searchAll(c: any, objectKey: string): Promise<any[]> {
  const out: any[] = [];
  let searchAfter: unknown[] | undefined;
  for (let i = 0; i < 100; i++) {
    const d = await c.request({ method: 'POST', path: `/objects/${objectKey}/records/search`, autoLocation: false,
      body: { locationId: c.locationId, page: 1, pageLimit: 500, ...(searchAfter ? { searchAfter } : {}) } });
    const batch: any[] = d.records ?? d.data ?? [];
    out.push(...batch);
    const next = batch[batch.length - 1]?.searchAfter;
    if (batch.length < 500 || !next) break;
    searchAfter = next;
  }
  return out;
}

async function main() {
  const { ghl } = await import('../lib/ghl/client');
  const { getBusinessFieldCatalog, getContactFieldCatalog, getObjectKeyFieldCatalog, deleteObjectField, deleteLocationField } =
    await import('../lib/ghl/customFields');
  const c = ghl();
  console.log(`${APPLY ? 'APPLY (DELETES)' : 'DRY RUN'} · target=${process.env.GHL_TARGET}\n`);

  // ── 1. Archive ──────────────────────────────────────────────────────────
  const [stageRecs, companies] = await Promise.all([searchAll(c, STAGE), searchAll(c, 'business')]);
  const companyOf = (r: any) => r?.relations?.find((x: any) => x?.objectKey === 'business')?.recordId ?? null;
  const archiveStage = stageRecs
    .filter((r) => r?.properties?.churchill_score != null || r?.properties?.churchill_substage)
    .map((r) => ({ stageRecordId: r.id, companyId: companyOf(r), rescoreDate: r.properties?.rescore_date ?? null,
      churchill_score: r.properties?.churchill_score ?? null, churchill_substage: r.properties?.churchill_substage ?? null,
      stage_rationale: r.properties?.stage_rationale ?? null }));
  const archiveCompanies = companies
    .filter((b) => COMPANY_CONTACT_KEYS.some((k) => b?.properties?.[k] != null && b.properties[k] !== ''))
    .map((b) => ({ companyId: b.id, name: b.properties?.name ?? null,
      ...Object.fromEntries(COMPANY_CONTACT_KEYS.map((k) => [k, b.properties?.[k] ?? null])) }));
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(process.cwd(), 'docs', 'audits', `${day}-churchill-archive`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stage-records.json'), JSON.stringify(archiveStage, null, 2));
  writeFileSync(join(dir, 'companies.json'), JSON.stringify(archiveCompanies, null, 2));
  console.log(`archived ${archiveStage.length} stage records + ${archiveCompanies.length} companies → ${dir}`);
  console.log('  (contact Churchill values are copies fanned down from the company; the company archive is authoritative)\n');

  // ── 2. Coverage gate ────────────────────────────────────────────────────
  const withChurchill = new Set(archiveStage.map((r) => r.companyId).filter(Boolean));
  const withMsrl = new Set(stageRecs.filter((r) => r?.properties?.msrl != null).map(companyOf).filter(Boolean));
  const nameOf = new Map(companies.map((b) => [b.id, b.properties?.name ?? b.id]));
  const gap = Array.from(withChurchill).filter((id) => !withMsrl.has(id));
  console.log(`coverage: ${withChurchill.size} companies scored on Churchill, ${withChurchill.size - gap.length} of them now hold MSRL`);
  if (gap.length) {
    console.log(`  ⚠️ ${gap.length} have Churchill and NO MSRL yet (run stage-score-run.ts --force on them):`);
    for (const id of gap) console.log(`     ${nameOf.get(id)}  (${id})`);
  }

  // ── 3. Targets ──────────────────────────────────────────────────────────
  const [stageCat, biz, con] = await Promise.all([getObjectKeyFieldCatalog(STAGE, c), getBusinessFieldCatalog(c), getContactFieldCatalog(c)]);
  const targets: Array<{ label: string; id: string; del: (id: string, c: any) => Promise<void> }> = [];
  for (const k of STAGE_KEYS) { const f = stageCat.byKey[`${STAGE}.${k}`]; if (f) targets.push({ label: `${STAGE}.${k}`, id: f.id, del: deleteObjectField }); }
  for (const k of COMPANY_CONTACT_KEYS) {
    const b = biz.byKey[`business.${k}`]; if (b) targets.push({ label: `business.${k}`, id: b.id, del: deleteObjectField });
    const ct = con.byKey[`contact.${k}`]; if (ct) targets.push({ label: `contact.${k}`, id: ct.id, del: deleteLocationField });
  }
  console.log(`\nfields to delete (${targets.length}):`);
  for (const t of targets) console.log(`  ${t.label}  ${t.id}`);
  console.log('\n⚠️ Before --apply: disable the mapping rows and Wix columns that reference these keys (spec phase 5),');
  console.log('   or the sync will log a missing-field error on every run.');

  if (!APPLY) { console.log('\nDRY RUN: nothing deleted. Re-run with --apply --yes.'); return; }
  if (gap.length && !FORCE_GAP) { console.error('\n❌ refusing: coverage gap above. Score them, or pass --force-gap.'); process.exit(2); }
  for (const t of targets) {
    try { await t.del(t.id, c); console.log(`  DELETED ${t.label}`); }
    catch (e: any) { console.log(`  FAILED  ${t.label}: ${e?.message ?? e} ${JSON.stringify(e?.body ?? '')}`); }
    await new Promise((r) => setTimeout(r, 350));
  }
}

main().catch((e) => { console.error(e?.message ?? e, JSON.stringify(e?.body ?? '')); process.exit(1); });
