// READ-ONLY preflight for the intake → scoring → reporting → rescore funnel.
//
// Checks the things that would make Zach's two-day test fail for configuration reasons rather than
// engine ones, each against LIVE state rather than the shipped seed.
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

const SCORING = ['company_description', 'where_are_you_today', 'current_state_of_your_technology_product',
  'patents', 'independent_validation', 'how_is_your_product_manufactured_today', 'manufacturing_partner_status',
  'number_of_paying_customers_today', 'where_you_are_with_selling', 'have_you_found_product_market_fit',
  'annual_revenue', 'date_of_incorporation', 'number_of_full_time_equivalents_fte',
  'number_of_fte_you_anticipate_hiring_in_the_next_12_months', 'owner_involvement', 'cash_flow_today',
  'locations_sites_of_operation', 'management_team', 'radio_183j1'];

(async () => {
  const client = ghl();

  console.log('── 1. do the scoring answers actually REACH the company? ──');
  console.log('   A form writes the CONTACT. Only an "up" or "both" mapping carries it to the');
  console.log('   company, which is what the scorer reads. A "down" row overwrites the answer.\n');
  const { getDb, hasDatabase } = await import('../lib/db');
  if (!hasDatabase) { console.log('   no DATABASE_URL — cannot read live mappings'); }
  else {
    const { fieldMappings } = await import('../lib/db/schema');
    const rows: any[] = await getDb().select().from(fieldMappings);
    const by = new Map<string, any>();
    for (const r of rows) by.set(String(r.contactKey ?? '').replace(/^contact\./, ''), r);
    console.log(`   live field_mappings rows: ${rows.length}`);
    let bad = 0;
    for (const k of SCORING) {
      const r = by.get(k);
      if (!r) { console.log(`   MISSING  ${k}`); bad += 1; continue; }
      const dir = String(r.direction ?? '');
      const enabled = r.enabled !== false;
      const ok = (dir === 'up' || dir === 'both') && enabled;
      if (!ok) { bad += 1; console.log(`   ⚠️  ${k.padEnd(58)} direction=${dir} enabled=${enabled}`); }
    }
    console.log(bad ? `\n   ${bad} field(s) would NOT reach the company.` : '\n   ✅ all 19 reach the company.');
  }

  console.log('\n── 2. a BRAND-NEW intake contact: does it get a company? ──');
  console.log('   The scorer is company-scoped and skips "no-company". Day 1 fails silently if a');
  console.log('   fresh intake contact has no businessId.');
  const { enumerateAllContacts } = await import('../lib/ghl/contacts');
  const contacts: any[] = await enumerateAllContacts(client);
  const recent = contacts
    .filter((c) => c.dateAdded && String(c.dateAdded) >= '2026-08-01')
    .sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded)));
  const linked = recent.filter((c) => c.businessId).length;
  console.log(`   contacts added since 2026-08-01: ${recent.length}, of which ${linked} have a company (${recent.length ? Math.round(linked / recent.length * 100) : 0}%)`);
  for (const c of recent.slice(0, 8)) {
    console.log(`      ${String(c.dateAdded).slice(0, 10)}  ${String(`${c.firstName ?? ''} ${c.lastName ?? ''}`).slice(0, 26).padEnd(26)} businessId=${c.businessId ? 'yes' : 'NO'}  source=${JSON.stringify(c.source ?? null)}`);
  }

  console.log('\n── 3. which forms are ROUTED, and to what? ──');
  const { listRoutes } = await import('../lib/activities/routes');
  const routes = await listRoutes();
  const forms = routes.filter((r: any) => r.matchKind === 'form');
  console.log(`   ${forms.length} form route(s):`);
  for (const f of forms) console.log(`      ${String(f.matchId).padEnd(26)} ${String(f.matchLabel ?? '')} → ${f.activityType}  enabled=${f.enabled}`);
  console.log('   (a form with NO route produces no activity — scoring still happens via the');
  console.log('    contact webhook, but no metrics/intake ACTIVITY is recorded for it)');

  console.log('\n── 4. the scorer gate: will a re-submission actually re-score? ──');
  const { resolveEnricherConfig } = await import('../lib/enrichment/configStore');
  const cfg = await resolveEnricherConfig('client-stage-scorer', 'business');
  console.log(`   enabled=${cfg.enabled}  filters=${cfg.groups.flatMap((g: any) => g.filters).length} (0 = runs for every company with a business_model)`);
  console.log('   ⚠️  The scorer is gated on a HASH of the 18 inputs. Re-submitting the SAME answers');
  console.log('       is a no-op — no rescore, no new scores, no email. Day 2 must CHANGE at least');
  console.log('       one answer to demonstrate a rescore.');
})().catch((e) => { console.error(e); process.exit(1); });
