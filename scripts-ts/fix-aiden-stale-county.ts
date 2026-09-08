// scripts-ts/fix-aiden-stale-county.ts — clear the Michigan county stranded on an Ohio business.
// Dry-run by default; --apply --yes to write.
//
// HOW IT GOT THERE. Aiden was an LRL team member, so his CONTACT carries
// `county_mi__full = "Jackson County (MI)"` from LRL's own address. When the contact→company sync
// came back online it pushed that value onto the brand-new "Aidens Consulting Company" record —
// correctly, by its own rules: the contact is the source of truth for that field.
//
// The county ENRICHER could not then correct it, and this is the part worth recording:
// `business.county` is a SINGLE_OPTIONS field with **84 options, every one of them Michigan**. The
// geocoder resolves 704 Maple St, Stryker OH to "Williams County" — which has no option to land in,
// so the enricher proposes nothing and the stale Michigan value simply stays.
//
// WHY IT MATTERS ENOUGH TO FIX BY HAND. `county` is a grant-eligibility dimension: SBSH serves
// Jackson, Lenawee and Hillsdale counties. An Ohio consultancy reading "Jackson County (MI)" would
// qualify for a grant it cannot receive — and it would look completely ordinary in a report.
//
// BOTH SIDES get cleared. Clearing only the company leaves the contact holding the stale value, and
// the next contact change pushes it straight back.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';

const APPLY = process.argv.includes('--apply');
const YES = process.argv.includes('--yes');
function env() {
  try {
    const t = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const l of t.split('\n')) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* CI */ }
}

const AIDEN_CONTACT = 'DuQPmo91pc0Gqrrs6avU';
const AIDEN_COMPANY = '6aa075b5db25fcd6e1730c68';

async function main() {
  env(); process.env.GHL_TARGET = 'live';
  if (APPLY && !YES) { console.error('--apply also needs --yes.'); process.exit(1); }
  const c = ghl();
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply --yes to write)\n');

  const { readRecordFields } = await import('../lib/ghl/records');
  const { getCatalog } = await import('../lib/ghl/catalogCache');
  const { setContactCustomFields } = await import('../lib/ghl/contacts');
  const { setBusinessFields } = await import('../lib/ghl/businesses');
  const { logChange } = await import('../lib/audit/log');

  const bizCat: any = await getCatalog('business', { client: c });
  const conCat: any = await getCatalog('contact', { client: c });

  const bf = await readRecordFields('business', AIDEN_COMPANY, c);
  const cf = await readRecordFields('contact', AIDEN_CONTACT, c);
  const bizCounty = bf.get('county');
  const conCounty = cf.get('county_mi__full');

  console.log('Aidens Consulting Company (704 Maple St, Stryker, OHIO 43557):');
  console.log(`   business.county          ${JSON.stringify(bizCounty ?? null)}  → clear`);
  console.log(`   contact.county_mi__full  ${JSON.stringify(conCounty ?? null)}  → clear (or the sync re-pushes it)`);
  if (!bizCounty && !conCounty) { console.log('\nboth already clear — nothing to do.'); return; }
  if (!APPLY) { console.log('\nnothing written.'); return; }

  if (bizCounty) {
    const r = await setBusinessFields(AIDEN_COMPANY, { county: '' }, bizCat.byKey, c);
    const after = await readRecordFields('business', AIDEN_COMPANY, c);
    const now = after.get('county');
    console.log(`   business.county now ${JSON.stringify(now ?? null)}  ${now ? '⚠️ NOT CLEARED' : '✅'}`);
    if (r.skipped?.length) console.log(`      skipped: ${JSON.stringify(r.skipped)}`);
    await logChange({
      objectType: 'business', recordId: AIDEN_COMPANY, recordLabel: 'Aidens Consulting Company',
      actorKind: 'sync', actorName: 'fix-aiden-stale-county', action: 'update',
      changes: [{ field: 'business.county', from: bizCounty, to: '', source: 'Manual' }],
      rationale: 'Michigan county pushed from a former LRL team member\'s contact onto an Ohio business; business.county has only Michigan options so the enricher cannot correct it',
      applied: true,
    }).catch(() => {});
  }
  if (conCounty) {
    // setContactCustomFields takes [{id, value}] — resolve the field's id from the catalog.
    const def: any = conCat.byKey['contact.county_mi__full'] ?? conCat.byKey['county_mi__full'];
    if (!def?.id) { console.log('   ⚠️ could not resolve contact.county_mi__full id — contact left untouched'); }
    else await setContactCustomFields(AIDEN_CONTACT, [{ id: def.id, value: '' }], c);
    const after = await readRecordFields('contact', AIDEN_CONTACT, c);
    const now = after.get('county_mi__full');
    console.log(`   contact.county_mi__full now ${JSON.stringify(now ?? null)}  ${now ? '⚠️ NOT CLEARED' : '✅'}`);
    await logChange({
      objectType: 'contact', recordId: AIDEN_CONTACT, recordLabel: 'Aiden Brunin',
      actorKind: 'sync', actorName: 'fix-aiden-stale-county', action: 'update',
      changes: [{ field: 'contact.county_mi__full', from: conCounty, to: '', source: 'Manual' }],
      rationale: 'stale Jackson County (MI) from his time as an LRL team member; his business is in Ohio',
      applied: true,
    }).catch(() => {});
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
