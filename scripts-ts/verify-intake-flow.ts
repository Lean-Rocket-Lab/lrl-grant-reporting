// scripts-ts/verify-intake-flow.ts — READ-ONLY. Walk one contact through the whole intake chain and
// say which step broke, in the order the steps depend on each other.
//
//   npx vite-node scripts-ts/verify-intake-flow.ts aiden
//   npx vite-node scripts-ts/verify-intake-flow.ts "test@example.com"
//
// Built for the 2026-09-09/10 re-test. Every check here corresponds to a failure we actually hit, so
// a PASS means something rather than "no error was thrown":
//
//   1  contact → company link      the scorer skips "no-company" SILENTLY (463 contacts have none)
//   2  business_model on company   the router; without it the company is "no-route" (864 are)
//   3  scoring inputs present      an empty blob means "no scoring inputs populated"
//   4  ONE scorer run today        four runs in 21s is what gave Aiden four different scores
//   5  ONE stage record for today  the (company, day) claim should make this exact
//   6  company *_current == record the divergence Zach caught; a mismatch here is the open question
//   7  enrichers ran once          county was written 3× by concurrent deliveries
//   8  the delivery count          distinct runIds = distinct webhook invocations
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
try {
  for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* CI */ }
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';

const WHO = process.argv[2];
const DAY = process.argv[3] ?? new Date().toISOString().slice(0, 10);
const ok = (s: string) => `  ✅ ${s}`;
const bad = (s: string) => `  ❌ ${s}`;
const warn = (s: string) => `  ⚠️  ${s}`;

(async () => {
  if (!WHO) { console.error('usage: verify-intake-flow.ts <name|email> [YYYY-MM-DD]'); process.exit(1); }
  const client = ghl();
  console.log(`verifying ${JSON.stringify(WHO)} for ${DAY}\n`);
  let failed = false;
  const fail = (s: string) => { failed = true; console.log(bad(s)); };

  // ── 1. the contact, and its company link ──────────────────────────────────────────────────────
  const { enumerateAllContacts } = await import('../lib/ghl/contacts');
  const all: any[] = await enumerateAllContacts(client);
  const hits = all.filter((c) => `${c.firstName ?? ''} ${c.lastName ?? ''} ${c.email ?? ''}`.toLowerCase().includes(WHO.toLowerCase()));
  console.log('1. CONTACT → COMPANY');
  if (!hits.length) { fail(`no contact matches ${JSON.stringify(WHO)}`); return; }
  if (hits.length > 1) console.log(warn(`${hits.length} contacts match — using the one with a company`));
  const contact = hits.find((c) => c.businessId) ?? hits[0];
  console.log(`     ${contact.firstName ?? ''} ${contact.lastName ?? ''} <${contact.email ?? ''}>  ${contact.id}`);
  if (!contact.businessId) { fail('contact has NO businessId — the scorer will skip it as "no-company"'); return; }
  const companyId = contact.businessId as string;
  const b: any = await client.request({ path: `/businesses/${companyId}` });
  const company = b.business ?? b;
  console.log(ok(`linked to ${JSON.stringify(company.name)} (${companyId})`));

  // ── 2/3. the router and the inputs ────────────────────────────────────────────────────────────
  const { readRecordFields } = await import('../lib/ghl/records');
  const { SCORING_INPUT_KEYS } = await import('../lib/stage/companyInputs');
  const cf = await readRecordFields('business', companyId, client);
  console.log('\n2. THE ROUTER');
  const model = cf.get('business_model');
  if (!model) fail('business_model is EMPTY → the company is "no-route" and never scores');
  else console.log(ok(`business_model = ${JSON.stringify(String(model).slice(0, 60))}`));

  console.log('\n3. SCORING INPUTS ON THE COMPANY');
  const bare = SCORING_INPUT_KEYS.map((k) => k.replace(/^business\./, ''));
  const present = bare.filter((k) => { const v = cf.get(k); return v != null && v !== ''; });
  if (!present.length) fail('no scoring inputs populated → "no scoring inputs populated"');
  else console.log(ok(`${present.length}/${bare.length} present`));
  const missing = bare.filter((k) => !present.includes(k));
  if (missing.length) console.log(warn(`absent: ${missing.join(', ')}`));

  // ── 5/6. the record, and whether the company agrees with it ──────────────────────────────────
  const { getRelatedRecordIds } = await import('../lib/ghl/associations');
  const recs: any[] = [];
  for (let page = 1; page <= 60; page += 1) {
    const d: any = await client.request({
      method: 'POST', path: '/objects/custom_objects.business_stage/records/search', autoLocation: false,
      body: { locationId: client.locationId, query: '', page, pageLimit: 100, searchAfter: [], sort: [{ field: 'updatedAt', direction: 'desc' }] },
    });
    const r = d.records ?? d.items ?? []; recs.push(...r); if (r.length < 100) break;
  }
  const mineRecs: any[] = [];
  for (const r of recs) {
    const ids = await getRelatedRecordIds(r.id, 'business', client).catch(() => [] as string[]);
    if (ids.includes(companyId)) mineRecs.push(r);
    await new Promise((x) => setTimeout(x, 45));
  }
  const todays = mineRecs.filter((r) => String((r.properties ?? {}).rescore_date ?? '').slice(0, 10) === DAY);

  // ── 4/8. how many times did anything run? ────────────────────────────────────────────────────
  const { queryChangeLog } = await import('../lib/audit/query');
  const { rows } = await queryChangeLog({ since: `${DAY}T00:00:00Z`, limit: 400 });
  // ⚠️ MATCH ON EVERY ID IN THE CASCADE, not just the company's. `client-stage-scorer` logs against
  // the STAGE RECORD it wrote, so filtering on companyId alone reported "the scorer never ran" for a
  // run that plainly had — a false failure on the check that matters most, which is worse than no
  // check. The stage records are fetched above for exactly this reason.
  const cascadeIds = new Set<string>([companyId, contact.id, ...mineRecs.map((r) => String(r.id))]);
  const mine = rows.filter((r: any) => cascadeIds.has(String(r.recordId)));
  const runIds = new Set(mine.map((r: any) => String(r.runId ?? '')).filter(Boolean));
  const scorerRuns = mine.filter((r: any) => String(r.actorName) === 'client-stage-scorer');
  const enricherRuns = mine.filter((r: any) => String(r.actorName) === 'company-enrichers');

  console.log('\n4. SCORER RUNS TODAY');
  if (scorerRuns.length === 0) fail('the scorer never ran');
  else if (scorerRuns.length === 1) console.log(ok('exactly ONE scoring run — this is the fix working'));
  else fail(`${scorerRuns.length} scoring runs — the storm is back; expect divergent scores`);
  for (const r of scorerRuns) {
    const ch = ((r.changes as any[]) ?? []).map((x: any) => `${String(x.field).replace(/.*\./, '')}=${JSON.stringify(x.to)}`).join(' ');
    console.log(`     ${String(r.ts).slice(4, 24)}  ${ch.slice(0, 96)}`);
  }

  console.log('\n8. WEBHOOK DELIVERIES (distinct runIds touching these records)');
  console.log(`     ${runIds.size} distinct run id(s), ${mine.length} change-log row(s)`);
  if (runIds.size > 2) console.log(warn(`${runIds.size} deliveries — each is a workflow enrollment in GHL`));
  else console.log(ok('delivery count is sane'));

  console.log('\n7. ENRICHERS');
  if (!enricherRuns.length) console.log(warn('company-enrichers did not run (fine if the address did not change)'));
  else if (enricherRuns.length === 1) console.log(ok('ran once'));
  else console.log(warn(`ran ${enricherRuns.length}× — concurrent deliveries re-reading before any wrote`));
  for (const k of ['county', 'geo_disadvantaged', 'naics_code']) {
    const v = cf.get(k);
    console.log(`     ${k.padEnd(20)} ${v == null || v === '' ? '(blank)' : JSON.stringify(v)}`);
  }

  console.log('\n5. STAGE RECORD FOR TODAY');
  if (!todays.length) fail(`no stage record dated ${DAY}`);
  else if (todays.length === 1) console.log(ok('exactly ONE record for today — the (company, day) claim held'));
  else fail(`${todays.length} records for today — the claim did not hold`);
  console.log(`     ${mineRecs.length} record(s) total for this company (multi-DAY history is correct)`);

  console.log('\n6. DOES THE COMPANY AGREE WITH THE RECORD?');
  if (todays.length !== 1) console.log(warn('skipped — needs exactly one record for today'));
  else {
    const p = todays[0].properties ?? {};
    const pairs: Array<[string, string]> = [['trl', 'trl_current'], ['mrl', 'mrl_current'], ['crl', 'crl_current'], ['churchill_score', 'churchill_current']];
    let diverged = 0;
    for (const [rk, ck] of pairs) {
      const rv = p[rk]; const cv = cf.get(ck);
      const same = String(rv ?? '') === String(cv ?? '');
      if (!same) diverged += 1;
      console.log(`     ${rk.padEnd(16)} record=${JSON.stringify(rv ?? null)}  company=${JSON.stringify(cv ?? null)}  ${same ? '✅' : '❌ DIVERGED'}`);
    }
    if (diverged) fail(`${diverged} score(s) differ between the record and the company — this is the OPEN question, not a known bug`);
    else console.log(ok('every score matches'));
  }

  console.log(`\n${failed ? '❌ SOMETHING FAILED — see above' : '✅ ALL CHECKS PASSED'}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
