// scripts-ts/fix-lrl-aiden-collision.ts — undo the 2026-09-08 identity collision.
// Dry-run by default; --apply --yes to write.
//
// WHAT HAPPENED. Aiden Brunin was an LRL team member (aiden@leanrocketlab.org) whose contact was
// CORRECTLY associated to the Lean Rocket Lab company record. He then submitted the client intake
// form from a personal email. GHL's backup dedupe matched his submission to the existing contact by
// PHONE (+16167102155 — unique to him, so the match was right), overwrote that contact's email with
// the personal one, and wrote the form's business details straight onto the associated company:
//
//     19:13:55  company 6a4d574e… → "Aidens Consulting Company", 704 Maple St, Stryker OH
//     19:13:59  contact updated
//
// The company was written FOUR SECONDS BEFORE the contact, and there is no `contact-to-company` row
// in the change log for it, so this was GHL's own form processing — not our sync. (Our contact sync
// could not have done it: it has been dead since 2026-08-27, see below.)
//
// NET EFFECT: Lean Rocket Lab's own company record became Aiden's, and no LRL company record exists.
// Eight LRL staff contacts still point at it. Its `county`/`geo_disadvantaged` values are LRL's,
// correctly computed for Jackson MI, and are only wrong in that the record now claims an Ohio
// address — the geo enrichers never re-ran because real-time enrichment lives in the same handler as
// the dead contact webhook.
//
// THE FIX: give the record back its identity, and give Aiden's business its own record.
//
//   npx vite-node scripts-ts/fix-lrl-aiden-collision.ts
//   npx vite-node scripts-ts/fix-lrl-aiden-collision.ts --apply --yes
import { readFileSync, writeFileSync } from 'node:fs';
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

const LRL_COMPANY = '6a4d574e64db0a03eb278f62';
const AIDEN_CONTACT = 'DuQPmo91pc0Gqrrs6avU';

/**
 * Lean Rocket Lab's own values, RECOVERED rather than invented:
 *   name + website — from the change log (`contact-to-company`, 2026-08-11 09:17:58, the last time
 *     they were legitimately written: "No Name" → "Lean Rocket Lab", nowebsite.com → leanrocketlab.org)
 *   address — from the enricher state's `geocodedAddress`, "133 w michigan ave|jackson|mi|49201",
 *     which is the address the geo enrichers actually resolved and which produced the HUBZone +
 *     Opportunity Zone flags currently on the record.
 */
const LRL = { name: 'Lean Rocket Lab', website: 'https://leanrocketlab.org', address: '133 W Michigan Ave', city: 'Jackson', state: 'MI', postalCode: '49201', country: 'US' };

/** Aiden's business, exactly as his intake form supplied it — currently sitting on LRL's record. */
const AIDEN_CO = { name: 'Aidens Consulting Company', website: 'https://aidensconsulting.com', address: '704 Maple St', city: 'Stryker', state: 'Ohio', postalCode: '43557', country: 'US' };

async function main() {
  env(); process.env.GHL_TARGET = 'live';
  if (APPLY && !YES) { console.error('--apply also needs --yes (this rewrites a live company record).'); process.exit(1); }
  const c = ghl();
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply --yes to write)\n');

  const { createBusiness } = await import('../lib/ghl/businesses');
  // `renameBusiness` covers only the name and `setBusinessFields` covers only CUSTOM fields, so the
  // standard scalars go through a plain PUT — the same call renameBusiness makes, with more keys.
  const putBusiness = (id: string, body: Record<string, unknown>) =>
    c.request({ method: 'PUT', path: `/businesses/${id}`, autoLocation: false, body });
  const { logChange } = await import('../lib/audit/log');

  const d: any = await c.request({ path: `/businesses/${LRL_COMPANY}` });
  const cur = d.business ?? d;
  console.log('CURRENT state of the record 8 LRL staff contacts point at:');
  for (const k of ['name', 'website', 'address', 'city', 'state', 'postalCode'] as const) {
    console.log(`   ${k.padEnd(11)} ${JSON.stringify(cur[k] ?? null)}`);
  }
  // Refuse to act on a record that is not in the state we diagnosed — if someone already fixed it by
  // hand, re-running this must not clobber their work.
  if (String(cur.name ?? '') !== AIDEN_CO.name) {
    console.log(`\n⚠️  the record is no longer named ${JSON.stringify(AIDEN_CO.name)} — it reads ${JSON.stringify(cur.name)}.`);
    console.log('   Nothing done. Someone has already changed it; re-diagnose before running this.');
    return;
  }

  console.log('\nSTEP 1 — restore Lean Rocket Lab on the existing record (keeps its 5 stage records,');
  console.log('         its 8 staff contacts, its scoring inputs, and its correct Jackson geo):');
  for (const [k, v] of Object.entries(LRL)) {
    const before = (cur as any)[k];
    if (String(before ?? '') !== String(v)) console.log(`   ${k.padEnd(11)} ${JSON.stringify(before ?? null)} → ${JSON.stringify(v)}`);
  }
  console.log('\nSTEP 2 — create a NEW company for Aiden\'s business:');
  for (const [k, v] of Object.entries(AIDEN_CO)) console.log(`   ${k.padEnd(11)} ${JSON.stringify(v)}`);
  console.log('\nSTEP 3 — repoint Aiden\'s contact to it:');
  console.log(`   contact ${AIDEN_CONTACT}  businessId ${LRL_COMPANY} → <the new company>`);
  console.log('\nNOT TOUCHED, deliberately:');
  console.log('   • the 5 stage records — they are Lean Rocket Lab\'s scoring history, including today\'s');
  console.log('   • county / geo_disadvantaged — correct for Jackson, and restoring the address makes them consistent again');
  console.log('   • the company\'s 18 scoring inputs — LRL\'s own answers; the dead contact sync means');
  console.log('     Aiden\'s intake never reached them, so nothing of his is mixed in');
  console.log('   • Aiden\'s contact fields — his intake answers are his, and they are on the contact');

  if (!APPLY) { console.log('\nnothing written.'); return; }

  await putBusiness(LRL_COMPANY, LRL);
  console.log('\n✅ restored Lean Rocket Lab');
  await logChange({
    objectType: 'business', recordId: LRL_COMPANY, recordLabel: LRL.name,
    actorKind: 'sync', actorName: 'fix-lrl-aiden-collision', action: 'update',
    changes: Object.entries(LRL).map(([k, v]) => ({ field: `business.${k}`, from: (cur as any)[k], to: v, source: 'Manual' as const })),
    rationale: 'GHL phone-dedupe matched an intake submission to a former team member\'s contact and wrote the form\'s business details onto the associated Lean Rocket Lab company record',
    applied: true,
  }).catch(() => {});

  const newId = await createBusiness(AIDEN_CO.name, { website: AIDEN_CO.website, address: AIDEN_CO.address, city: AIDEN_CO.city, state: AIDEN_CO.state, postalCode: AIDEN_CO.postalCode, country: AIDEN_CO.country }, c);
  console.log(`✅ created ${AIDEN_CO.name} → ${newId}`);

  await c.request({ method: 'PUT', path: `/contacts/${AIDEN_CONTACT}`, autoLocation: false, body: { businessId: newId } });
  console.log(`✅ repointed Aiden's contact to ${newId}`);

  const after: any = await c.request({ path: `/contacts/${AIDEN_CONTACT}` });
  console.log(`   verify: contact.businessId = ${(after.contact ?? after).businessId}`);
  const lrlAfter: any = await c.request({ path: `/businesses/${LRL_COMPANY}` });
  console.log(`   verify: company ${LRL_COMPANY} name = ${JSON.stringify((lrlAfter.business ?? lrlAfter).name)}`);

  writeFileSync(join(process.cwd(), 'reports/fix-lrl-aiden-collision.json'),
    JSON.stringify({ appliedAt: new Date().toISOString(), restored: LRL, created: { id: newId, ...AIDEN_CO }, contact: AIDEN_CONTACT }, null, 1));
  console.log('\n→ reports/fix-lrl-aiden-collision.json');
}
main().catch((e) => { console.error(e); process.exit(1); });
