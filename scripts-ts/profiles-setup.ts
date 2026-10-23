// scripts-ts/profiles-setup.ts — create the Profiles object, its fields, and the profile_contact
// association (docs/sprints/profiles-object.md).
//
//   npx vite-node scripts-ts/profiles-setup.ts           # AUDIT: what exists, what would be created
//   npx vite-node scripts-ts/profiles-setup.ts --apply   # CREATE whatever is missing
//
// Idempotent: checks before every create. The object KEY and the association KEY are permanent in GHL
// (no delete), so they are constants here and never derived.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function loadEnvLocal() {
  try {
    const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ok */ }
}
const APPLY = process.argv.includes('--apply');

export const PROFILES_OBJECT = 'custom_objects.profiles';
export const PROFILE_CONTACT_ASSOC = 'profile_contact';
const FOLDER_INFO = 'Profile Info';
const FOLDER_RANK = 'Page Ranking';

type Opt = { key: string; label: string };
type FieldSpec = { key: string; name: string; type: string; folder: string; options?: Opt[]; file?: boolean };

const o = (pairs: Array<[string, string]>): Opt[] => pairs.map(([key, label]) => ({ key, label }));
const nums = (n: number) => Array.from({ length: n }, (_, i) => ({ key: String(i + 1), label: String(i + 1) }));

export const SERVICE_AREAS = [
  'IP & Patents', 'Legal & Contracts', 'Non-dilutive Funding', 'R&D Partnerships', 'Prototyping',
  'Design for Manufacturing', 'Contract Manufacturing', 'Supply Chain', 'Quality Systems',
  'Lean & Continuous Improvement', 'Test & Certification', 'Systems Engineering', 'Tooling & Automation',
  'Factory Layout & Industrial Eng.', 'Workforce Training', 'ERP / MES & Ops Software',
  'Regulatory & Compliance', 'Market Research', 'Customer Discovery', 'Go-to-Market Strategy',
  'Pricing Strategy', 'Sales & Business Development', 'Marketing & Brand', 'Financial Modeling',
  'Fundraising & Investor Readiness', 'Business Model Design', 'Product Management',
  'Capital Equipment & Financing', 'M&A / Exit Planning',
];
export const serviceKey = (label: string) =>
  label.toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export const FIELDS: FieldSpec[] = [
  { key: 'profile_status', name: 'Profile Status', type: 'SINGLE_OPTIONS', folder: FOLDER_INFO,
    options: o([['pending', 'Pending'], ['approved', 'Approved'], ['published', 'Published'], ['hidden', 'Hidden']]) },
  { key: 'roles', name: 'Roles', type: 'MULTIPLE_OPTIONS', folder: FOLDER_INFO,
    options: o([['team', 'Team'], ['eir', 'EIR'], ['board', 'Board']]) },
  { key: 'job_title', name: 'Job Title', type: 'TEXT', folder: FOLDER_INFO },
  { key: 'company_name', name: 'Company Name', type: 'TEXT', folder: FOLDER_INFO },
  { key: 'bio', name: 'Bio', type: 'LARGE_TEXT', folder: FOLDER_INFO },
  { key: 'linkedin', name: 'LinkedIn', type: 'TEXT', folder: FOLDER_INFO },
  { key: 'website', name: 'Website', type: 'TEXT', folder: FOLDER_INFO },
  { key: 'headshot', name: 'Headshot', type: 'FILE_UPLOAD', folder: FOLDER_INFO, file: true },
  { key: 'company_logo', name: 'Company Logo', type: 'FILE_UPLOAD', folder: FOLDER_INFO, file: true },
  { key: 'programs', name: 'Programs', type: 'MULTIPLE_OPTIONS', folder: FOLDER_INFO,
    options: o([['local', 'LOCAL'], ['sales_and_marketing_accelerator', 'Sales and Marketing Accelerator'],
      ['manutech_incubator', 'ManuTech Incubator'], ['industry_40_accelerator', 'i4.0 Accelerator'],
      ['exit_readiness_accelerator', 'Exit Readiness Accelerator']]) }, // added live 2026-10-22 (options are add-only)
  { key: 'collectives', name: 'Collectives', type: 'MULTIPLE_OPTIONS', folder: FOLDER_INFO,
    options: o([['lean_startup', 'Lean Startup'], ['mainstreet', 'Mainstreet'], ['manufacturing', 'Manufacturing Tech']]) },
  { key: 'service_areas', name: '[AI] Service Areas', type: 'MULTIPLE_OPTIONS', folder: FOLDER_INFO,
    options: SERVICE_AREAS.map((l) => ({ key: serviceKey(l), label: l })) },
  { key: 'mrl_stops', name: '[AI] MRL Stops', type: 'MULTIPLE_OPTIONS', folder: FOLDER_INFO, options: nums(10) },
  { key: 'trl_stops', name: '[AI] TRL Stops', type: 'MULTIPLE_OPTIONS', folder: FOLDER_INFO, options: nums(9) },
  { key: 'crl_stops', name: '[AI] CRL Stops', type: 'MULTIPLE_OPTIONS', folder: FOLDER_INFO, options: nums(9) },
  { key: 'investor_readiness_stops', name: '[AI] Investor Readiness Stops', type: 'MULTIPLE_OPTIONS', folder: FOLDER_INFO, options: nums(9) },
  { key: 'readiness_confidence', name: '[AI] Readiness Confidence', type: 'SINGLE_OPTIONS', folder: FOLDER_INFO,
    options: o([['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]) },
  { key: 'readiness_rationale', name: '[AI] Readiness Rationale', type: 'LARGE_TEXT', folder: FOLDER_INFO },
  { key: 'source_contact_id', name: '[SYNC] Source Contact ID', type: 'TEXT', folder: FOLDER_INFO },
  { key: 'wix_team_row_id', name: '[SYNC] Wix Team Row ID', type: 'TEXT', folder: FOLDER_INFO },
  ...([
    ['rank_our_team', 'Rank: Our Team page'], ['rank_local', 'Rank: LOCAL'], ['rank_sama', 'Rank: SAMA'],
    ['rank_manutech', 'Rank: ManuTech'], ['rank_i40', 'Rank: i4.0 Accelerator'],
    ['rank_lean_startup', 'Rank: Lean Startup'], ['rank_mainstreet', 'Rank: Mainstreet'],
    ['rank_manufacturing', 'Rank: Manufacturing Tech'],
  ] as Array<[string, string]>).map(([key, name]) => ({ key, name, type: 'NUMERICAL', folder: FOLDER_RANK })),
];

async function main() {
  loadEnvLocal();
  const { ghl } = await import('../lib/ghl/client');
  const c = ghl();
  const loc = c.locationId;
  console.log(`${APPLY ? 'APPLY' : 'AUDIT'} on location ${loc}`);

  // 1. Object
  const schemas = await c.request<any>({ path: '/objects/' });
  let obj = (schemas.objects ?? []).find((s: any) => s.key === PROFILES_OBJECT);
  if (obj) console.log(`object exists: ${obj.key} (${obj.id})`);
  else if (!APPLY) console.log(`WOULD CREATE object ${PROFILES_OBJECT} (primary display_name)`);
  else {
    const res = await c.request<any>({
      method: 'POST', path: '/objects/', autoLocation: false,
      body: {
        locationId: loc,
        labels: { singular: 'Profile', plural: 'Profiles' },
        key: PROFILES_OBJECT,
        description: 'Public website profiles (Team, EIR, Board) associated to a contact',
        primaryDisplayPropertyDetails: { key: `${PROFILES_OBJECT}.display_name`, name: 'Display Name', dataType: 'TEXT' },
      },
    });
    obj = res.object ?? res;
    console.log(`CREATED object ${obj.key} (${obj.id})`);
  }
  if (!obj) { console.log('(object missing; stopping audit here)'); return; }

  // 2. Folders + fields
  const cat = await c.request<any>({ path: `/custom-fields/object-key/${PROFILES_OBJECT}` });
  const folders: Record<string, string> = {};
  for (const f of cat.folders ?? []) folders[f.name] = f.id;
  const existing = new Map<string, any>((cat.fields ?? []).map((f: any) => [String(f.fieldKey).split('.').pop(), f]));
  console.log(`existing fields: ${Array.from(existing.keys()).join(', ') || '(none)'}`);

  for (const name of [FOLDER_INFO, FOLDER_RANK]) {
    if (folders[name]) continue;
    if (!APPLY) { console.log(`WOULD CREATE folder "${name}"`); continue; }
    const r = await c.request<any>({ method: 'POST', path: '/custom-fields/folder/', autoLocation: false,
      body: { locationId: loc, objectKey: PROFILES_OBJECT, name } });
    folders[name] = (r.folder ?? r).id;
    console.log(`CREATED folder "${name}" ${folders[name]}`);
  }

  for (const f of FIELDS) {
    const ex = existing.get(f.key);
    if (ex) {
      if (ex.dataType !== f.type) console.log(`!! ${f.key} exists as ${ex.dataType}, spec says ${f.type}`);
      continue;
    }
    if (!APPLY) { console.log(`WOULD CREATE ${f.key} ${f.type}${f.options ? ` (${f.options.length} opts)` : ''}`); continue; }
    const body: Record<string, unknown> = {
      locationId: loc, name: f.name, dataType: f.type, objectKey: PROFILES_OBJECT,
      fieldKey: `${PROFILES_OBJECT}.${f.key}`, parentId: folders[f.folder], showInForms: true,
    };
    if (f.options) body.options = f.options;
    if (f.file) { body.maxFileLimit = 1; body.acceptedFormats = ['.jpg', '.jpeg', '.png', '.gif']; }
    try {
      const r = await c.request<any>({ method: 'POST', path: '/custom-fields/', autoLocation: false, body });
      const nf = r.field ?? r.customField ?? r;
      console.log(`CREATED ${f.key} ${f.type} ${nf.id}`);
    } catch (e: any) {
      console.log(`FAILED ${f.key}: ${e?.message ?? e} ${JSON.stringify(e?.body ?? '')}`);
    }
  }

  // 3. Association
  const assoc = await c.request<any>({ path: '/associations/', params: { limit: 100 } });
  const list = assoc.associations ?? assoc;
  const a = list.find((x: any) => x.key === PROFILE_CONTACT_ASSOC);
  if (a) console.log(`association exists: ${a.key} ${a.id} first=${a.firstObjectKey} second=${a.secondObjectKey}`);
  else if (!APPLY) console.log(`WOULD CREATE association ${PROFILE_CONTACT_ASSOC} contact <-> ${PROFILES_OBJECT}`);
  else {
    const r = await c.request<any>({ method: 'POST', path: '/associations/', autoLocation: false, body: {
      locationId: loc, key: PROFILE_CONTACT_ASSOC,
      firstObjectKey: 'contact', firstObjectLabel: 'Contact',
      secondObjectKey: PROFILES_OBJECT, secondObjectLabel: 'Profile',
    } });
    const d = r.association ?? r;
    console.log(`CREATED association ${d.key} ${d.id} first=${d.firstObjectKey} second=${d.secondObjectKey} (read back sides; GHL may swap)`);
  }
}

if (process.argv[1]?.includes('profiles-setup')) main().catch((e) => { console.error(e?.message ?? e, JSON.stringify(e?.body ?? '')); process.exit(1); });
