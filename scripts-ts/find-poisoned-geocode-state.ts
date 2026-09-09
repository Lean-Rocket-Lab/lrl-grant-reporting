// scripts-ts/find-poisoned-geocode-state.ts — find companies whose geo enrichment is permanently
// disabled, and clear the state so it retries. Dry-run by default.
//
//   npx vite-node scripts-ts/find-poisoned-geocode-state.ts
//   npx vite-node scripts-ts/find-poisoned-geocode-state.ts --apply
//
// THE POISON. `/api/sync/up` used to stamp `enricher_state.geocodedAddress` whenever geo enrichment
// was ATTEMPTED, not when it succeeded. `addressNeedsGeocode` then compares the company's current
// address to that stamp and returns false — so a company whose geocode failed once is marked "already
// done" and never geocoded again. Found on "Wayne" (6aa1b1bf860f0045961d1bca): a Grosse Pointe Woods
// address, stamped as geocoded, with county and geo_disadvantaged both blank.
//
// Both fields are grant-eligibility dimensions — SBSH gates on county — so a silent blank is a wrong
// answer rather than a missing one.
//
// THE SIGNATURE: a stamped geocodedAddress, an address to geocode, and BOTH county and
// geo_disadvantaged empty. Clearing the stamp is all that is needed; the next delivery (or the
// nightly enrich) then re-runs geo normally.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';

const APPLY = process.argv.includes('--apply');
try {
  for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* CI */ }
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';

(async () => {
  const client = ghl();
  console.log(APPLY ? 'MODE: APPLY (clears the stamp)\n' : 'MODE: DRY RUN (pass --apply)\n');
  const { getDb, hasDatabase } = await import('../lib/db');
  if (!hasDatabase) { console.error('no DATABASE_URL'); process.exit(1); }
  const { enricherState } = await import('../lib/db/schema');
  const { readRecordFields } = await import('../lib/ghl/records');
  const { sql } = await import('drizzle-orm');

  const states: any[] = await getDb().select().from(enricherState);
  const stamped = states.filter((s) => s.geocodedAddress);
  console.log(`enricher_state rows: ${states.length}, with a geocodedAddress stamp: ${stamped.length}`);

  const poisoned: Array<{ id: string; name: string; address: string; stamp: string }> = [];
  let checked = 0;
  for (const st of stamped) {
    const id = String(st.companyId);
    let name = id; let address = '';
    try {
      const d: any = await client.request({ path: `/businesses/${id}` });
      const b = d.business ?? d;
      name = String(b.name ?? id);
      address = [b.address, b.city, b.state, b.postalCode].filter(Boolean).join(', ');
    } catch { continue; } // company gone; the stamp is harmless
    const f = await readRecordFields('business', id, client).catch(() => null);
    if (!f) continue;
    checked += 1;
    const blank = (k: string) => { const v = f.get(k); return v == null || v === ''; };
    if (address && blank('county') && blank('geo_disadvantaged')) {
      poisoned.push({ id, name, address, stamp: String(st.geocodedAddress) });
    }
    await new Promise((r) => setTimeout(r, 90));
  }

  console.log(`checked ${checked} company(ies)\n`);
  console.log(`POISONED — stamped as geocoded, but county AND geo_disadvantaged are both blank: ${poisoned.length}`);
  for (const p of poisoned) {
    console.log(`   ${p.id}  ${p.name.slice(0, 34).padEnd(34)} ${p.address.slice(0, 46)}`);
  }
  if (!poisoned.length) { console.log('   (none)'); return; }
  if (!APPLY) { console.log('\nnothing cleared. --apply clears the stamp so geo re-runs.'); return; }

  for (const p of poisoned) {
    await getDb().update(enricherState)
      .set({ geocodedAddress: null })
      .where(sql`company_id = ${p.id}`);
    console.log(`   cleared ${p.id} (${p.name})`);
  }
  console.log(`\ncleared ${poisoned.length} stamp(s). The next contact change or nightly enrich re-runs geo.`);
})().catch((e) => { console.error(e); process.exit(1); });
