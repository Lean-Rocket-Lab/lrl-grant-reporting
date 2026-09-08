// scripts-ts/add-out-of-state-county.ts — add an "Out of State" option to the county picklists.
//
// WHY. `business.county` has 84 options and every one is a Michigan county. An out-of-state company
// therefore cannot be represented truthfully: the geocoder resolved Aiden Brunin's Stryker OH
// address to "Williams County" and the enricher had nowhere to put it, so a stale
// "Jackson County (MI)" pushed up from his contact simply stayed. County is an SBSH eligibility
// dimension (Jackson, Lenawee, Hillsdale), so an Ohio business reading a Michigan county would
// qualify for a grant it cannot receive — and the row would look completely ordinary.
//
// An explicit "Out of State" is better than blank for the same reason `geo_disadvantaged` has a
// "None": it distinguishes "we looked and it is outside Michigan" from "nobody has checked".
//
// ⚠️ GHL HAS NO "APPEND AN OPTION" CALL — the update REPLACES the whole list. Dropping an option
// from a live picklist silently orphans every record holding it, so the only safe shape is
// read → append → write → read back and prove nothing was lost. That is what this does, and it
// exits non-zero if a single option goes missing.
//
//   npx vite-node scripts-ts/add-out-of-state-county.ts            # dry run
//   npx vite-node scripts-ts/add-out-of-state-county.ts --apply
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghl } from '../lib/ghl/client';

const APPLY = process.argv.includes('--apply');
// Local dev reads .env.local; in CI the secrets are real env vars and the file does not exist.
try {
  for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env.local (CI) — env is already populated */ }
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';

const LABEL = 'Out of State';

/**
 * The mapped pair, from config/field-mappings.json:
 *   contact.county_mi__full ↔ business.county   ("both" direction, mirrored)
 *
 * `contact.county` is deliberately NOT touched: it is a separate, unmapped 4-option list (the three
 * SBSH counties) and changing it would alter a field whose whole purpose is "is this one of ours".
 *
 * `model` picks the endpoint — an object field and a location field are updated differently.
 */
const TARGETS: Array<{ object: string; bareKey: string; model: 'object' | 'location' }> = [
  { object: 'business', bareKey: 'county', model: 'object' },
  { object: 'contact', bareKey: 'county_mi__full', model: 'location' },
];

(async () => {
  const client = ghl();
  const { getFieldCatalog } = await import('../lib/ghl/customFields');
  console.log(`target=${process.env.GHL_TARGET}`);
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');

  let failed = false;
  for (const t of TARGETS) {
    const catalog = await getFieldCatalog(t.object, client);
    const def = catalog.byKey[`${t.object}.${t.bareKey}`];
    if (!def) { console.log(`⚠️  ${t.object}.${t.bareKey}: not found\n`); failed = true; continue; }

    const existing = def.options ?? [];
    const have = existing.some((o) => String(o.label).trim().toLowerCase() === LABEL.toLowerCase());
    console.log(`▸ ${t.object}.${t.bareKey}  "${def.name}"  (${def.dataType}, ${existing.length} option(s))`);
    if (have) { console.log(`    ✅ already has "${LABEL}"\n`); continue; }
    console.log(`    would append "${LABEL}" → ${existing.length + 1} option(s), keeping all ${existing.length}`);
    if (!APPLY) { console.log('    (dry run)\n'); continue; }

    // Existing options are re-sent with their STORED key so GHL keeps them byte-identical — a
    // changed key would orphan every record holding that value.
    //
    // ⚠️ THE TWO ENDPOINTS DISAGREE ON THE SHAPE, and the error is unhelpful. The object endpoint
    // takes `options: [{key,label}]`. The LOCATION endpoint takes plain STRINGS and answers a
    // {key,label} array with `400 "v.trim is not a function"` — which reads like a bug in our
    // payload's values rather than in its shape. Location-field options are strings all the way
    // down (their catalog shows key === label for exactly this reason).
    const path = t.model === 'object'
      ? `/custom-fields/${def.id}`
      : `/locations/${client.locationId}/customFields/${def.id}`;
    const body = t.model === 'object'
      ? {
          locationId: client.locationId,
          name: def.name,
          options: [
            ...existing.map((o) => ({ key: o.key, label: o.label })),
            { key: LABEL.toLowerCase().replace(/\s+/g, '_'), label: LABEL },
          ],
        }
      : {
          // ⚠️ The location endpoint names the field `picklistOptions`, not `options`, and it is an
          // array of plain STRINGS. Sending `options` is accepted with a 200 and silently ignored —
          // the read-back is the only reason we found out. Sending [{key,label}] instead answers
          // `400 "v.trim is not a function"`, which reads like a value problem rather than a
          // shape one. `dataType` and `model` are echoed back because the update is a full replace.
          locationId: client.locationId,
          name: def.name,
          model: 'contact',
          dataType: def.dataType,
          picklistOptions: [...existing.map((o) => String(o.label)), LABEL],
        };
    await client.request({ method: 'PUT', path, autoLocation: false, body });

    // Prove it.
    const after = await getFieldCatalog(t.object, client);
    const now = after.byKey[`${t.object}.${t.bareKey}`]?.options ?? [];
    const nowKeys = new Set(now.map((o) => o.key));
    const dropped = existing.filter((o) => !nowKeys.has(o.key));
    const added = now.some((o) => String(o.label).trim().toLowerCase() === LABEL.toLowerCase());
    console.log(`    now ${now.length} option(s); added "${LABEL}": ${added}; dropped: ${dropped.length}`);
    if (dropped.length) {
      console.error(`    ❌ LOST: ${dropped.map((o) => o.key).join(', ')} — records holding them are orphaned`);
      failed = true;
    } else if (!added) {
      console.error(`    ❌ "${LABEL}" did not persist`);
      failed = true;
    } else {
      console.log(`    ✅ kept all ${existing.length}, added 1\n`);
    }
  }
  process.exit(failed ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
