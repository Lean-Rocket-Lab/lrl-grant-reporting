// READ-ONLY. Which CONTACT fields still need a real-time trigger now that the webhook only fires on
// form/survey submissions? A field qualifies when a MANUAL edit to it changes app behaviour and a
// nightly pickup would be visibly wrong (a gate that publishes something, or a link that unblocks a
// pipeline). Everything else can wait for the nightly.
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

(async () => {
  const client = ghl();

  console.log('══ 1. ENRICHER GATES — a gate flip should take effect now, not tomorrow ══');
  const { getEnricherConfigStore, resolveEnricherConfig } = await import('../lib/enrichment/configStore');
  const { defaultContactEnrichers, defaultEnrichers, defaultRecordEnrichers } = await import('../lib/enrichment');
  const all: Array<{ name: string; obj: string }> = [
    ...defaultContactEnrichers.map((e) => ({ name: e.name, obj: 'contact' })),
    ...defaultEnrichers.map((e) => ({ name: e.name, obj: 'business' })),
    ...defaultRecordEnrichers.map((e) => ({ name: e.enricher.name, obj: e.sourceObject })),
    { name: 'client-stage-scorer', obj: 'business' },
  ];
  for (const e of all) {
    const cfg = await resolveEnricherConfig(e.name, e.obj);
    const filters = cfg.groups.flatMap((g) => g.filters);
    if (!filters.length) { console.log(`   ${e.name.padEnd(22)} (${e.obj}) — no gate`); continue; }
    for (const f of filters) {
      const isContact = f.field.startsWith('contact.');
      console.log(`   ${e.name.padEnd(22)} (${e.obj}) gate on ${f.field}${isContact ? '   ← CONTACT FIELD, needs the trigger' : ''}`);
      console.log(`        values: {${f.anyOf.join(', ')}}`);
    }
  }

  console.log('\n══ 2. WIX PUSH GATES — a status flip is meant to publish or unpublish ══');
  const { getDb, hasDatabase } = await import('../lib/db');
  if (hasDatabase) {
    const { wixMappingSets } = await import('../lib/db/schema');
    const sets: any[] = await getDb().select().from(wixMappingSets);
    for (const s of sets) {
      const gate = s.gate ?? s.gateField ?? null;
      console.log(`   ${String(s.slug ?? s.name).padEnd(26)} enabled=${s.enabled !== false}  gate=${JSON.stringify(gate)}`);
    }
  } else console.log('   (no DATABASE_URL)');

  console.log('\n══ 3. THE LINK ITSELF — businessId ══');
  console.log('   Not a custom field, but it is what makes a contact scoreable at all: the scorer');
  console.log('   skips "no-company". A staffer linking a contact to its company by hand is exactly');
  console.log('   the manual edit that should take effect immediately.');
  const { enumerateAllContacts } = await import('../lib/ghl/contacts');
  const contacts: any[] = await enumerateAllContacts(client);
  console.log(`   contacts with no businessId today: ${contacts.filter((c) => !c.businessId).length} of ${contacts.length}`);

  console.log('\n══ 4. what the scorer itself watches (SCORE_TRIGGER_KEYS) ══');
  const { SCORE_TRIGGER_KEYS } = await import('../lib/stage/trigger');
  console.log(`   ${SCORE_TRIGGER_KEYS.size} key(s) — these are COMPANY-side, reached via the up-sync:`);
  console.log(`   ${Array.from(SCORE_TRIGGER_KEYS).slice(0, 6).join(', ')} …`);
})().catch((e) => { console.error(e); process.exit(1); });
