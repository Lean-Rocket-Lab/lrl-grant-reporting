// scripts-ts/scoring-form-setup.ts — make the GHL Scoring Form's answers reach the company.
//
// THE PLAN (Zach, 2026-09-08). A GHL-hosted form asks the scoring questions. GHL forms are
// contact-scoped, so the answers land on the CONTACT. `/api/sync/up` then carries them to the
// COMPANY, which is the authoritative scoring input, and the stage scorer fires off that change.
// Everything after the form already exists. What is missing is the plumbing this script builds:
//
//   1. the 12 contact fields that do not exist yet (7 of the 19 already do)
//   2. 19 mapping rows contact -> business  (UP only)
//   3.  5 mapping rows business -> contact  (DOWN only, so the results email can merge the scores)
//
// ⚠️ NO FIELD IS TWO-WAY. That is deliberate and it is the 2026-08-27 incident's lesson: a field
// synced both ways with no single owner is a loop waiting for a bulk import. Here the FORM owns the
// 19 inputs and the SCORER owns the 5 scores, and neither writes back.
//
// ⚠️ KEYS ARE READ BACK, NEVER GUESSED. GHL derives a location-model fieldKey from the NAME, so the
// key is whatever GHL decides. This project has lost data three times to a key that differed by one
// character (`expense_category_item3`). So: create, re-read the catalog, and build the mapping rows
// from the key GHL actually assigned.
//
//   npx vite-node scripts-ts/scoring-form-setup.ts            # dry run
//   npx vite-node scripts-ts/scoring-form-setup.ts --apply
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';
import { getBusinessFieldCatalog, getContactFieldCatalog, createLocationField } from '../lib/ghl/customFields';
import type { CustomFieldDef } from '../lib/ghl/types';

const APPLY = process.argv.includes('--apply');

/** The 19 scoring inputs, from lib/stage/companyInputs.ts + the router. Bare company keys. */
const INPUTS = [
  'description', 'where_are_you_today', 'tech_product_state', 'patents', 'independent_validation_company',
  'mfg_method', 'mfg_partner_status', 'paying_customers', 'selling_stage', 'product_market_fit',
  'annual_revenue', 'date_of_incorporation', 'fte_current', 'fte_hiring_next_12mo', 'owner_involvement',
  'cash_flow_today', 'locations_sites', 'management_team', 'business_model',
];

/** The scores the scorer propagates onto the company. These go DOWN so the email can merge them. */
const SCORES = ['trl_current', 'mrl_current', 'crl_current', 'churchill_current', 'churchill_substage_current'];

function env() {
  try {
    const t = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const l of t.split('\n')) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env.local (CI) */ }
}

const bare = (k: string) => k.replace(/^(business|contact)\./, '');
const optionLabels = (f?: CustomFieldDef) => (f?.options ?? []).map((o: any) => String(o.label ?? o.key ?? o));

async function main() {
  env();
  process.env.GHL_TARGET = 'live';
  const c = ghl();
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');

  const [bcat, ccat0] = await Promise.all([getBusinessFieldCatalog(c), getContactFieldCatalog(c)]);
  let ccat = ccat0;
  const bFor = (k: string) => bcat.byKey[`business.${k}`] ?? bcat.byKey[k];
  const cFor = (k: string, cat = ccat) => cat.byKey[`contact.${k}`] ?? cat.byKey[k];

  // ── Phase 1: the contact fields ───────────────────────────────────────────
  const missing = INPUTS.filter((k) => !cFor(k)).map((k) => ({ k, b: bFor(k)! })).filter((x) => x.b);
  console.log(`── contact fields ──  ${INPUTS.length - missing.length}/${INPUTS.length} already exist, ${missing.length} to create\n`);
  for (const { k, b } of missing) {
    const opts = optionLabels(b);
    console.log(`  ${APPLY ? 'creating' : 'would create'}  "${b.name}"  [${b.dataType}]${opts.length ? `  ${opts.length} options` : ''}`);
    if (!APPLY) continue;
    try {
      const created = await createLocationField(
        { model: 'contact', name: b.name, dataType: String(b.dataType), options: opts.length ? opts : undefined },
        c,
      );
      console.log(`      -> ${created?.fieldKey ?? '(key unknown until re-read)'}`);
    } catch (e: any) {
      console.log(`      !! FAILED: ${e?.message ?? e}`);
    }
    await new Promise((r) => setTimeout(r, 350)); // GHL 429s at ~0.12s spacing
  }

  // Re-read so every key below is the one GHL ACTUALLY assigned, not one we guessed.
  if (APPLY && missing.length) {
    await new Promise((r) => setTimeout(r, 1500));
    ccat = await getContactFieldCatalog(c);
  }

  // ── Phase 2: the mapping rows ─────────────────────────────────────────────
  console.log('\n── mapping rows ──\n');
  const up: Array<{ contact_key: string; business_key: string }> = [];
  const unresolved: string[] = [];
  for (const k of INPUTS) {
    const cf = cFor(k, ccat);
    if (!cf) { unresolved.push(k); continue; }
    up.push({ contact_key: bare(cf.fieldKey), business_key: k });
  }
  const down: Array<{ contact_key: string; business_key: string }> = [];
  const scoresMissing: string[] = [];
  for (const k of SCORES) {
    const cf = cFor(k, ccat);
    if (!cf) { scoresMissing.push(k); continue; }
    down.push({ contact_key: bare(cf.fieldKey), business_key: k });
  }

  console.log(`  UP   contact -> business  (the form owns these)   ${up.length}/${INPUTS.length}`);
  for (const r of up) {
    const flag = r.contact_key === r.business_key ? '' : '   <- KEYS DIFFER, mapping row handles it';
    console.log(`      contact.${r.contact_key.padEnd(40)} -> business.${r.business_key}${flag}`);
  }
  console.log(`\n  DOWN business -> contact  (the scorer owns these) ${down.length}/${SCORES.length}`);
  for (const r of down) console.log(`      business.${r.business_key.padEnd(40)} -> contact.${r.contact_key}`);

  if (unresolved.length) console.log(`\n  ⚠️ NO CONTACT FIELD, cannot map: ${unresolved.join(', ')}`);
  if (scoresMissing.length) console.log(`  ⚠️ score field missing on contact, email cannot merge it: ${scoresMissing.join(', ')}`);

  console.log('\n  (rows are printed, not written — phase 3 writes them once you have reviewed this list)');
}

main().catch((e) => { console.error(e); process.exit(1); });
