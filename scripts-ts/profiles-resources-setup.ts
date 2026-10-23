// scripts-ts/profiles-resources-setup.ts — reorganize the Profiles object so it can hold Resources
// (docs/sprints/profiles-resources-merge.md, decided with Zach 2026-10-23).
// Existing fields cannot be moved between folders via the API; the run prints them for a UI move.
//
//   tsx scripts-ts/profiles-resources-setup.ts           # AUDIT: print every change, write nothing
//   tsx scripts-ts/profiles-resources-setup.ts --apply   # create folders/fields/associations, move fields
//
// Idempotent. Field MOVES are a PUT on the field; a picklist PUT replaces the whole option list, so
// option fields are sent with their FULL current option list (stored keys) and read back afterwards —
// any option count change aborts the run. Association keys are permanent (no delete) and GHL may SWAP
// the sides of a definition, so every association is read back and its stored sides printed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
const APPLY = process.argv.includes('--apply');

export const PROFILES_OBJECT = 'custom_objects.profiles';

/** Folder layout. `Profile Info` already exists and stays the shared core. */
export const FOLDERS = {
  core: 'Profile Info',
  person: 'Person Details',
  resource: 'Resource Details',
  ai: '[AI] Readiness Tags',
  rank: 'Page Ranking',
  sync: '[SYNC] System',
} as const;
type FolderId = keyof typeof FOLDERS;

/** Where every field lives. Fields not listed stay where they are. */
export const PLACEMENT: Record<string, FolderId> = {
  display_name: 'core', profile_type: 'core', profile_status: 'core', programs: 'core', collectives: 'core',
  website: 'core', company_logo: 'core', bio: 'core',
  roles: 'person', job_title: 'person', company_name: 'person', linkedin: 'person', headshot: 'person',
  headshot_url: 'person',
  category: 'resource', sub_category: 'resource', short_description: 'resource', public_email: 'resource',
  service_areas: 'ai', mrl_stops: 'ai', trl_stops: 'ai', crl_stops: 'ai', investor_readiness_stops: 'ai',
  msrl_stops: 'ai', readiness_confidence: 'ai', readiness_rationale: 'ai',
  source_contact_id: 'sync', wix_team_row_id: 'sync', source_resource_id: 'sync', wix_resource_row_id: 'sync',
};

/** Label changes (key never changes). */
export const RENAMES: Record<string, string> = {
  bio: 'Bio / Description',
  company_logo: 'Logo',
};

type NewField = { key: string; name: string; type: string; options?: Array<{ key: string; label: string }> };
export const NEW_FIELDS: NewField[] = [
  { key: 'profile_type', name: 'Profile Type', type: 'SINGLE_OPTIONS',
    options: [{ key: 'person', label: 'Person' }, { key: 'resource', label: 'Resource' }] },
  { key: 'category', name: 'Category', type: 'TEXT' },
  { key: 'sub_category', name: 'Sub Category', type: 'TEXT' },
  { key: 'short_description', name: 'Short Description', type: 'TEXT' },
  { key: 'public_email', name: 'Public Email', type: 'TEXT' },
  { key: 'source_resource_id', name: '[SYNC] Source Resource ID', type: 'TEXT' },
  { key: 'wix_resource_row_id', name: '[SYNC] Wix Resource Row ID', type: 'TEXT' },
];

/** New association definitions. first/second are what we POST; GHL may store them swapped. */
export const NEW_ASSOCS = [
  { key: 'profile_company', first: ['business', 'Company'], second: [PROFILES_OBJECT, 'Profile'] },
  { key: 'referral_referred_to_profile', first: ['custom_objects.activities', 'Referral Received'], second: [PROFILES_OBJECT, 'Referred To'] },
  { key: 'milestone_profile', first: ['custom_objects.milestones', 'Milestone'], second: [PROFILES_OBJECT, 'Profile'] },
] as const;

const OPTION_TYPES = new Set(['SINGLE_OPTIONS', 'MULTIPLE_OPTIONS', 'CHECKBOX', 'RADIO']);

async function catalog(c: any) {
  const cat = await c.request({ path: `/custom-fields/object-key/${PROFILES_OBJECT}` });
  const folders: Record<string, string> = {};
  for (const f of cat.folders ?? []) folders[f.name] = f.id;
  const fields = new Map<string, any>((cat.fields ?? []).map((f: any) => [String(f.fieldKey).split('.').pop(), f]));
  return { folders, fields };
}

async function main() {
  const { ghl } = await import('../lib/ghl/client');
  const c = ghl();
  const loc = c.locationId;
  console.log(`${APPLY ? 'APPLY' : 'AUDIT'} on ${loc}`);

  let { folders, fields } = await catalog(c);

  // 1. Folders
  for (const name of Object.values(FOLDERS)) {
    if (folders[name]) continue;
    if (!APPLY) { console.log(`WOULD CREATE folder "${name}"`); continue; }
    const r = await c.request<any>({ method: 'POST', path: '/custom-fields/folder/', autoLocation: false,
      body: { locationId: loc, objectKey: PROFILES_OBJECT, name } });
    folders[name] = (r.folder ?? r).id;
    console.log(`CREATED folder "${name}" ${folders[name]}`);
  }

  // 2. New fields (created straight into their folder)
  for (const f of NEW_FIELDS) {
    if (fields.has(f.key)) continue;
    const folder = FOLDERS[PLACEMENT[f.key]];
    if (!APPLY) { console.log(`WOULD CREATE ${f.key} ${f.type} in "${folder}"`); continue; }
    const body: Record<string, unknown> = {
      locationId: loc, name: f.name, dataType: f.type, objectKey: PROFILES_OBJECT,
      fieldKey: `${PROFILES_OBJECT}.${f.key}`, parentId: folders[folder], showInForms: true,
    };
    if (f.options) body.options = f.options;
    const r = await c.request<any>({ method: 'POST', path: '/custom-fields/', autoLocation: false, body });
    console.log(`CREATED ${f.key} ${(r.field ?? r.customField ?? r).id}`);
  }
  if (APPLY) ({ folders, fields } = await catalog(c));

  // 3. Renames via the API; MOVES are manual. Measured 2026-10-23: PUT /custom-fields/{id} rejects
  //    `parentId` ("property parentId should not exist"), so an existing field cannot change folder
  //    through the public API. New fields are created in the right folder; existing ones are listed
  //    here for a drag-and-drop in Settings → Objects → Profiles.
  const manualMoves: string[] = [];
  for (const [key, def] of Array.from(fields)) {
    const target = PLACEMENT[key] ? folders[FOLDERS[PLACEMENT[key]]] : undefined;
    if (target && def.parentId !== target) manualMoves.push(`${def.name} (${key}) → "${FOLDERS[PLACEMENT[key]]}"`);
    const name = RENAMES[key] ?? def.name;
    if (name === def.name) continue;
    const what = `${key}: rename "${def.name}" → "${name}"`;
    if (!APPLY) { console.log(`WOULD ${what}`); continue; }
    const body: Record<string, unknown> = { locationId: loc, name, showInForms: def.showInForms ?? true };
    const before = (def.options ?? []).length;
    if (OPTION_TYPES.has(def.dataType)) body.options = (def.options ?? []).map((o: any) => ({ key: o.key, label: o.label }));
    await c.request({ method: 'PUT', path: `/custom-fields/${def.id}`, autoLocation: false, body });
    const after = (await catalog(c)).fields.get(key);
    const ok = after && after.name === name && (after.options ?? []).length === before;
    console.log(`${ok ? 'OK  ' : '!!  '} ${what}`);
    if (!ok) throw new Error(`read-back failed for ${key}; stopping`);
  }
  if (manualMoves.length) console.log(`\nMANUAL folder moves (${manualMoves.length}):\n  ${manualMoves.join('\n  ')}\n`);

  // 4. Associations
  const { listAssociationDefs, clearAssociationCache } = await import('../lib/ghl/associations');
  const existing = await listAssociationDefs(c);
  for (const a of NEW_ASSOCS) {
    const ex = existing.find((d: any) => d.key === a.key);
    if (ex) { console.log(`assoc exists: ${a.key} ${ex.id} first=${ex.first.objectKey} second=${ex.second.objectKey}`); continue; }
    if (!APPLY) { console.log(`WOULD CREATE assoc ${a.key} ${a.first[0]} ↔ ${a.second[0]}`); continue; }
    const r = await c.request<any>({ method: 'POST', path: '/associations/', autoLocation: false, body: {
      locationId: loc, key: a.key,
      firstObjectKey: a.first[0], firstObjectLabel: a.first[1],
      secondObjectKey: a.second[0], secondObjectLabel: a.second[1],
    } });
    const d = r.association ?? r;
    console.log(`CREATED assoc ${d.key} ${d.id}`);
  }
  if (APPLY) {
    clearAssociationCache();
    for (const d of await listAssociationDefs(c)) {
      if (NEW_ASSOCS.some((a) => a.key === d.key)) console.log(`read back: ${d.key} ${d.id} first=${d.first.objectKey} second=${d.second.objectKey}`);
    }
  }
}

if (process.argv[1]?.includes('profiles-resources-setup')) main().catch((e) => { console.error(e?.message ?? e, JSON.stringify(e?.body ?? '')); process.exit(1); });
