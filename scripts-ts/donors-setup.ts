// scripts-ts/donors-setup.ts — Profiles fields for DONORS (Wix "Funders" retirement, Zach 2026-10-27).
//
//   tsx scripts-ts/donors-setup.ts           # AUDIT
//   tsx scripts-ts/donors-setup.ts --apply
//
// Design (docs: PROJECT_STATE "2026-10-26 — Donors"): donor is a RELATIONSHIP, not a profile_type —
// 7 donors are already Resource profiles, and profile_type is single-select. So:
//   donor_status      SINGLE_OPTIONS current | past      (Profile Info)   ← the kiosk/website filter
//   rank_donors       NUMERICAL                          (Page Ranking)   ← display order
//   wix_funder_row_id TEXT                               ([SYNC] System)  ← idempotent import key
//   profile_type      + option `organization`            (donor-only orgs that are not public Resources)
// Picklist update REPLACES the whole list: read → append → write → read back, prove nothing dropped.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
const APPLY = process.argv.includes('--apply');
const PRO = 'custom_objects.profiles';

const NEW_FIELDS = [
  { key: 'donor_status', name: 'Donor Status', type: 'SINGLE_OPTIONS', folder: 'Profile Info',
    options: [{ key: 'current', label: 'Current' }, { key: 'past', label: 'Past' }] },
  { key: 'rank_donors', name: 'Rank: Donors', type: 'NUMERICAL', folder: 'Page Ranking' },
  { key: 'wix_funder_row_id', name: '[SYNC] Wix Funder Row ID', type: 'TEXT', folder: '[SYNC] System' },
];
const ADD_OPTIONS = [{ field: 'profile_type', add: [{ key: 'organization', label: 'Organization' }] }];

async function catalog(c: any) {
  const cat = await c.request({ path: `/custom-fields/object-key/${PRO}` });
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

  for (const f of NEW_FIELDS) {
    if (fields.has(f.key)) { console.log(`exists  ${f.key}`); continue; }
    if (!folders[f.folder]) throw new Error(`folder "${f.folder}" missing`);
    if (!APPLY) { console.log(`WOULD CREATE ${f.key} ${f.type} in "${f.folder}"`); continue; }
    const body: Record<string, unknown> = {
      locationId: loc, name: f.name, dataType: f.type, objectKey: PRO,
      fieldKey: `${PRO}.${f.key}`, parentId: folders[f.folder], showInForms: true,
    };
    if (f.options) body.options = f.options;
    const r = await c.request<any>({ method: 'POST', path: '/custom-fields/', autoLocation: false, body });
    console.log(`CREATED ${f.key} ${(r.field ?? r.customField ?? r).id}`);
  }

  for (const step of ADD_OPTIONS) {
    ({ fields } = await catalog(c));
    const def = fields.get(step.field);
    if (!def) throw new Error(`${step.field} missing`);
    const existing: any[] = def.options ?? [];
    const missing = step.add.filter((o) => !existing.some((e) => e.key === o.key));
    console.log(`${step.field}: existing ${existing.map((o) => o.key).join('|')}; adding ${missing.map((o) => o.key).join('|') || '(nothing)'}`);
    if (!missing.length || !APPLY) continue;
    await c.request({ method: 'PUT', path: `/custom-fields/${def.id}`, autoLocation: false, body: {
      locationId: loc, name: def.name, showInForms: def.showInForms ?? true,
      options: [...existing.map((o) => ({ key: o.key, label: o.label })), ...missing],
    } });
    const now: any[] = (await catalog(c)).fields.get(step.field)?.options ?? [];
    const dropped = existing.filter((o) => !now.some((n) => n.key === o.key));
    if (dropped.length) throw new Error(`LOST OPTIONS on ${step.field}: ${dropped.map((o) => o.key).join(',')}`);
    console.log(`  now ${now.map((o) => o.key).join('|')} ✅`);
  }

  if (APPLY) {
    ({ fields } = await catalog(c));
    const missing = NEW_FIELDS.filter((f) => !fields.has(f.key)).map((f) => f.key);
    if (missing.length) throw new Error(`read-back: missing ${missing.join(',')}`);
    console.log('read-back OK: all donor fields present');
  }
}
main().catch((e) => { console.error(e?.message ?? e, JSON.stringify(e?.body ?? '')); process.exit(1); });
