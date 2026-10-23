// scripts-ts/msrl-fields-setup.ts — create every GHL field the MSRL migration needs
// (docs/sprints/msrl-migration.md, phase 1). Churchill is NOT touched here; deletion is phase 5
// (scripts-ts/msrl-churchill-retire.ts) and only runs after MSRL baselines exist.
//
//   ~/tools/node_modules/.bin/tsx scripts-ts/msrl-fields-setup.ts            # DRY RUN
//   ~/tools/node_modules/.bin/tsx scripts-ts/msrl-fields-setup.ts --apply    # create what's missing
//
// Idempotent: every create is preceded by a catalog check. Picklist APPENDS use the read → append →
// write → read-back pattern from add-field-options.ts, because a GHL picklist update REPLACES the
// whole option list and a dropped option orphans every record holding it.
//
// ⚠️ CONTACT keys are derived by GHL from the field NAME (location-model fields). Names below are
// chosen so the derived key equals the business key; the script re-reads the catalog and prints the
// key GHL actually assigned. Build mapping rows from the printed keys, never from this file.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MSRL_LENSES, PLACE_FLAGS } from '../lib/stage/msrl';
import { SERVICES } from '../lib/enrichment/data/readiness';

for (const l of (() => { try { return readFileSync(join(process.cwd(), '.env.local'), 'utf8'); } catch { return ''; } })().split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
const APPLY = process.argv.includes('--apply');

type Spec = { key: string; name: string; type: string; options?: string[] };
const nums = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));
const FLAG_LABELS = PLACE_FLAGS.map((f) => `${f.id} ${f.name}`);

/** Client Stage Tracking record (custom_objects.business_stage): one MSRL snapshot per scoring event. */
const STAGE_FIELDS: Spec[] = [
  { key: 'msrl', name: 'MSRL', type: 'NUMERICAL' },
  { key: 'msrl_demand', name: 'MSRL Demand (D)', type: 'NUMERICAL' },
  { key: 'msrl_model', name: 'MSRL Model (M)', type: 'NUMERICAL' },
  { key: 'msrl_operations', name: 'MSRL Operations (O)', type: 'NUMERICAL' },
  { key: 'msrl_path', name: 'MSRL Path', type: 'SINGLE_OPTIONS', options: ['Sustain', 'Grow'] },
  { key: 'msrl_lens', name: 'MSRL Lens', type: 'SINGLE_OPTIONS', options: [...MSRL_LENSES] },
  { key: 'msrl_open_flags', name: 'MSRL Open Place Flags', type: 'TEXT' },
  { key: 'msrl_label', name: 'MSRL Label', type: 'TEXT' },
  { key: 'msrl_next_milestone', name: 'MSRL Next Milestone', type: 'LARGE_TEXT' },
];

/** The ONLY two new intake questions (Zach 2026-10-21). Owned by the FORM (contact → business, up only).
 *  Lens, site flags and rung evidence are inferred by the scorer from answers intake already collects. */
const INTAKE_FIELDS: Spec[] = [
  { key: 'msrl_owner_path', name: 'MSRL Owner Path', type: 'SINGLE_OPTIONS', options: [
    'Sustain: I want to stay the main provider', 'Grow: I want a team, more locations, or a business that runs without me'] },
  { key: 'msrl_owner_goals', name: 'MSRL Owner Goals', type: 'LARGE_TEXT' },
];

/** Company-only score fields (owned by the SCORER via the company-current-scoring connection). No
 *  *_initial / *_advancement: those were retired 2026-08 (portfolio.ts derives them from history). */
const COMPANY_SCORE_FIELDS: Spec[] = [
  { key: 'msrl_current', name: 'MSRL Current', type: 'NUMERICAL' },
  { key: 'msrl_demand_current', name: 'MSRL Demand Current', type: 'NUMERICAL' },
  { key: 'msrl_model_current', name: 'MSRL Model Current', type: 'NUMERICAL' },
  { key: 'msrl_operations_current', name: 'MSRL Operations Current', type: 'NUMERICAL' },
  { key: 'msrl_path_current', name: 'MSRL Path Current', type: 'SINGLE_OPTIONS', options: ['Sustain', 'Grow'] },
  { key: 'msrl_label_current', name: 'MSRL Label Current', type: 'TEXT' },
  { key: 'msrl_next_milestone_current', name: 'MSRL Next Milestone Current', type: 'LARGE_TEXT' },
];

/** Readiness-map stop field on the two directory objects (and the contact, while the tagger writes there). */
const STOPS: Spec = { key: 'msrl_stops', name: '[AI] MSRL Stops', type: 'MULTIPLE_OPTIONS', options: nums(9) };
const NEW_SERVICE_LABELS = ['bookkeeping', 'licensing', 'realestate', 'lending', 'hr', 'ops'].map((k) => (SERVICES as any)[k] as string);
const serviceKey = (label: string) => label.toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** One folder per object so MSRL fields sit together instead of scattered through the catalog. */
const MSRL_FOLDER = 'Main Street Readiness (MSRL)';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { ghl } = await import('../lib/ghl/client');
  const { createObjectField, getContactFieldCatalog } = await import('../lib/ghl/customFields');
  const c = ghl();
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} · target=${process.env.GHL_TARGET} · location ${c.locationId}\n`);

  /** Raw object catalog: fields by bare key + a folder id to hang new fields on. */
  async function objectCatalog(objectKey: string, anchorBareKey: string, folderName?: string) {
    const cat = await c.request<any>({ path: `/custom-fields/object-key/${objectKey}` });
    const fields: any[] = cat.fields ?? [];
    const byBare = new Map<string, any>(fields.map((f): [string, any] => [String(String(f.fieldKey).split('.').pop()), f]));
    const anchor = byBare.get(anchorBareKey);
    let parentId = anchor?.parentId ?? (cat.folders ?? [])[0]?.id;
    if (folderName) {
      const existing = (cat.folders ?? []).find((f: any) => f.name === folderName);
      if (existing) parentId = existing.id;
      else if (!APPLY) { console.log(`  CREATE   folder "${folderName}" on ${objectKey}`); parentId = parentId ?? 'pending'; }
      else {
        const r = await c.request<any>({ method: 'POST', path: '/custom-fields/folder/', autoLocation: false,
          body: { locationId: c.locationId, objectKey, name: folderName } });
        parentId = (r.folder ?? r).id;
        console.log(`  CREATED  folder "${folderName}" on ${objectKey} ${parentId}`);
      }
    }
    return { byBare, parentId };
  }

  async function ensureObjectFields(objectKey: string, anchor: string, specs: Spec[], folderName?: string) {
    const { byBare, parentId } = await objectCatalog(objectKey, anchor, folderName);
    console.log(`── ${objectKey} (folder ${parentId ?? 'NONE'}) ──`);
    for (const f of specs) {
      const ex = byBare.get(f.key);
      if (ex) {
        console.log(`  exists   ${f.key}${ex.dataType !== f.type ? `  !! is ${ex.dataType}, spec ${f.type}` : ''}`);
        continue;
      }
      if (!APPLY) { console.log(`  CREATE   ${f.key} ${f.type}${f.options ? ` (${f.options.length} opts)` : ''}`); continue; }
      if (!parentId) { console.log(`  !! no folder to place ${f.key} in`); continue; }
      try {
        const id = await createObjectField({ objectKey, parentId, bareKey: f.key, name: f.name, dataType: f.type, options: f.options, showInForms: true }, c);
        console.log(`  CREATED  ${f.key} ${id}`);
      } catch (e: any) {
        console.log(`  FAILED   ${f.key}: ${e?.message ?? e} ${JSON.stringify(e?.body ?? '')}`);
      }
      await sleep(350);
    }
    console.log('');
  }

  /** Object picklist append with read-back proof (no option may be lost). */
  async function appendObjectOptions(objectKey: string, bareKey: string, labels: string[]) {
    const { byBare } = await objectCatalog(objectKey, bareKey);
    const def = byBare.get(bareKey);
    if (!def) { console.log(`  ⚠️ ${objectKey}.${bareKey} not found\n`); return; }
    if (!/OPTIONS|CHECKBOX/.test(String(def.dataType))) { console.log(`  ${objectKey}.${bareKey} is ${def.dataType}: no option list to extend\n`); return; }
    const existing: Array<{ key: string; label: string }> = def.options ?? [];
    const have = new Set(existing.map((o) => o.label.trim().toLowerCase()));
    const missing = labels.filter((l) => !have.has(l.toLowerCase()));
    console.log(`  ${objectKey}.${bareKey}: ${existing.length} options, adding ${missing.length}: ${missing.join(' | ') || '(none)'}`);
    if (!missing.length || !APPLY) return;
    await c.request({ method: 'PUT', path: `/custom-fields/${def.id}`, autoLocation: false, body: {
      locationId: c.locationId, name: def.name,
      options: [...existing.map((o) => ({ key: o.key, label: o.label })), ...missing.map((l) => ({ key: serviceKey(l), label: l }))],
    } });
    const after = (await objectCatalog(objectKey, bareKey)).byBare.get(bareKey);
    const nowKeys = new Set((after?.options ?? []).map((o: any) => o.key));
    const dropped = existing.filter((o) => !nowKeys.has(o.key));
    if (dropped.length) { console.error(`  ❌ LOST OPTIONS ${dropped.map((o) => o.key).join(', ')}`); process.exit(2); }
    console.log(`  ✅ kept all ${existing.length}, now ${after?.options?.length}`);
  }

  // 1. Client Stage Tracking record
  await ensureObjectFields('custom_objects.business_stage', 'churchill_score', STAGE_FIELDS, MSRL_FOLDER);
  // 2. Company: intake inputs + current scores
  await ensureObjectFields('business', 'churchill_current', [...INTAKE_FIELDS, ...COMPANY_SCORE_FIELDS], MSRL_FOLDER);
  // 3. Profiles + Resources: MSRL stop line, and the 6 Main Street service options
  await ensureObjectFields('custom_objects.profiles', 'mrl_stops', [STOPS]);
  await ensureObjectFields('custom_objects.resources', 'mrl_stops', [STOPS]);
  console.log('── service_areas option lists ──');
  await appendObjectOptions('custom_objects.profiles', 'service_areas', NEW_SERVICE_LABELS);
  await appendObjectOptions('custom_objects.resources', 'service_areas', NEW_SERVICE_LABELS);

  // 4. Contact: the form's fields (GHL forms are contact-scoped) + the tagger's msrl_stops
  console.log('\n── contact (location-model; GHL derives the key from the name) ──');
  let ccat = await getContactFieldCatalog(c);
  const cFor = (k: string) => ccat.byKey[`contact.${k}`] ?? ccat.byKey[k];
  // Contact folders can't be created by API (v2 rejects objectKey contact), but v1 fields carry a
  // parentId: place each new field in the folder its sibling already lives in, then read it back.
  const rawContact: any[] = ((await c.request<any>({ path: `/locations/${c.locationId}/customFields`, autoLocation: false, params: { model: 'contact' } })).customFields ?? []);
  const folderOf = (bare: string) => rawContact.find((f) => f.fieldKey === `contact.${bare}`)?.parentId as string | undefined;
  const contactSpecs: Array<Spec & { sibling: string }> = [
    ...INTAKE_FIELDS.map((f) => ({ ...f, sibling: 'owner_involvement' })),   // intake questions
  ];
  for (const f of contactSpecs) {
    const parentId = folderOf(f.sibling);
    if (cFor(f.key)) { console.log(`  exists   contact.${f.key}`); continue; }
    if (!APPLY) { console.log(`  CREATE   "${f.name}" ${f.type} in folder of contact.${f.sibling} (${parentId ?? 'none'})`); continue; }
    try {
      const r = await c.request<any>({ method: 'POST', path: `/locations/${c.locationId}/customFields`, autoLocation: false, body: {
        name: f.name, dataType: f.type, model: 'contact', ...(f.options ? { options: f.options } : {}), ...(parentId ? { parentId } : {}) } });
      const nf = r.customField ?? r;
      console.log(`  CREATED  "${f.name}" -> ${nf?.fieldKey} folder=${nf?.parentId ?? '(none)'}${parentId && nf?.parentId !== parentId ? '  !! folder not applied' : ''}`);
    } catch (e: any) { console.log(`  FAILED   ${f.name}: ${e?.message ?? e} ${JSON.stringify(e?.body ?? '')}`); }
    await sleep(350);
  }
  // No contact msrl_stops / service_areas changes: those contact fields live in the "WIX Team CMS
  // Profile" folder that is being retired (profiles moved to custom_objects.profiles, 2026-10-20).
  // 5. What the mapping rows must reference: keys as GHL actually holds them.
  if (APPLY) { await sleep(1500); ccat = await getContactFieldCatalog(c); }
  console.log('\n── mapping rows to add (printed, not written; see spec phase 2) ──');
  for (const f of INTAKE_FIELDS) {
    const cf = cFor(f.key);
    console.log(`  UP    contact.${cf ? String(cf.fieldKey).replace(/^contact\./, '') : `?? (${f.name})`}  ->  business.${f.key}`);
  }
  for (const [from, to] of [['msrl', 'msrl_current'], ['msrl_demand', 'msrl_demand_current'], ['msrl_model', 'msrl_model_current'],
    ['msrl_operations', 'msrl_operations_current'], ['msrl_path', 'msrl_path_current'], ['msrl_label', 'msrl_label_current'],
    ['msrl_next_milestone', 'msrl_next_milestone_current']]) {
    console.log(`  CURR  business_stage.${from}  ->  business.${to}   (company-current-scoring)`);
  }
  console.log('  WIX   profiles.msrl_stops -> Team.msrlStops · resources.msrl_stops -> Resources.msrlStops (create the CMS columns first)');
}

main().catch((e) => { console.error(e?.message ?? e, JSON.stringify(e?.body ?? '')); process.exit(1); });
