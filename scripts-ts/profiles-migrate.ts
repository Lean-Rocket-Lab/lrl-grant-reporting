// scripts-ts/profiles-migrate.ts — copy website profiles from contact fields onto Profile records and
// associate each to its contact (docs/sprints/profiles-object.md, phase 2).
//
//   npx tsx scripts-ts/profiles-migrate.ts                  # DRY RUN: print the mapped payload per contact
//   npx tsx scripts-ts/profiles-migrate.ts --apply --only=<contactId>   # one record first
//   npx tsx scripts-ts/profiles-migrate.ts --apply          # everyone
//
// Population = every contact with `contact.status` (Website Profile Status) set.
// Idempotent: a contact whose id already sits in a profile's `source_contact_id` (or in the local ledger)
// is UPDATED (diffed by objectWrite, so an unchanged re-run is a no-op), never created twice.
// Contact fields are read only; nothing on the contact changes.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
const OBJ = 'custom_objects.profiles';
const ASSOC = 'profile_contact';
const LEDGER = join(process.cwd(), 'reports', 'profiles-migration-ledger.json');

// Contact custom field ids (read from the live location schema 2026-10-20).
const CF = {
  status: 'uhMXVvv2sWa15VUwnxdi',
  roles: 'TCCMGrG6Pv9Lfhga0Fi0',
  programs: '58YNmbkHWahxdwn9yb9f',
  collectives: 'lW17fW7GSnbfvugy7CLR',
  jobTitle: 'sLbLkuB3uO7cW5Egkpti',
  bio: '5DsGtcbAWOR2cNLYFQf2',
  linkedin: 'YSS7z08zleBB2Hy1J5VD',
  website: 'QhfW9YQYKRXb9MJaVA8s',
  headshot: 'fb3uZjhMTAGK80wEC61t',
  companyLogo: '3yf1JeXP7GCWkonJ3KAi',
  serviceAreas: '4cwXyHXVmKae5hWrZLCT',
  mrl: 'uDrHbARvMAQttKxnKiCl',
  trl: 'jmZaR2m6t64l6XeWHgHA',
  crl: 'UhG8N7Nq5HN5AMtySbq4',
  irl: 'RTxPQGQbqX5dIlMaRTpf',
  confidence: 'qMbeXSZpCmPbjKSqopug',
  rationale: 'ttiZVLC0mVBp7rZLAUH2',
  wixRow: 'mnSsC0uCxSScciUHNtGI',
};
const PROGRAM_KEYS: Record<string, string> = {
  'local': 'local', 'sales and marketing': 'sales_and_marketing_accelerator',
  'manutech incubator': 'manutech_incubator', 'i4.0 accelerator': 'industry_40_accelerator',
};
const COLLECTIVE_KEYS: Record<string, string> = {
  'lean startup': 'lean_startup', 'mainstreet': 'mainstreet', 'manufacturing tech': 'manufacturing',
};
const ROLE_KEYS: Record<string, string> = { team: 'team', eir: 'eir', board: 'board' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arr = (v: unknown): string[] =>
  v == null || v === '' ? [] : Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [String(v).trim()];

async function wixLocalRanks(): Promise<Record<string, number>> {
  // Wix Team `localDisplayRanking` (100 = unranked) keyed by ghlContactId. Wix-only seed for rank_local.
  const out: Record<string, number> = {};
  if (!process.env.WIX_API_TOKEN) return out;
  const r = await fetch('https://www.wixapis.com/wix-data/v2/items/query', {
    method: 'POST',
    headers: { Authorization: process.env.WIX_API_TOKEN!, 'wix-site-id': process.env.WIX_SITE_ID!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataCollectionId: 'Team', query: { paging: { limit: 100 } } }),
  });
  const j: any = await r.json();
  for (const it of j.dataItems ?? []) {
    const d = it.data ?? {};
    const n = Number(d.localDisplayRanking);
    if (d.ghlContactId && Number.isFinite(n) && n > 0 && n < 100) out[d.ghlContactId] = n;
  }
  return out;
}

async function main() {
  loadEnvLocal();
  const { ghl } = await import('../lib/ghl/client');
  const { getFieldCatalog } = await import('../lib/ghl/customFields');
  const { createObjectRecord } = await import('../lib/ghl/createRecord');
  const { writeRecordFields } = await import('../lib/ghl/writeRecord');
  const { createRelation, resolveAssociationDef, getRelatedRecordIds } = await import('../lib/ghl/associations');
  const { SERVICE_AREAS, serviceKey } = await import('./profiles-setup');
  const c = ghl();
  const catalog = await getFieldCatalog(OBJ);
  const saKey = new Map(SERVICE_AREAS.map((l) => [l.toLowerCase(), serviceKey(l)]));

  // Association definition: read it, never assume sides.
  const def: any = await resolveAssociationDef(ASSOC);
  if (!def) throw new Error(`association ${ASSOC} not found`);
  const contactIsFirst = def.first.objectKey === 'contact';
  console.log(`assoc ${def.id}: first=${def.first.objectKey} second=${def.second.objectKey}`);

  // Population
  const contacts: any[] = [];
  let searchAfter: unknown;
  for (let p = 0; p < 20; p++) {
    const body: any = { locationId: c.locationId, pageLimit: 100, filters: [{ field: `customFields.${CF.status}`, operator: 'exists' }] };
    if (searchAfter) body.searchAfter = searchAfter;
    const r = await c.request<any>({ method: 'POST', path: '/contacts/search', autoLocation: false, body });
    contacts.push(...r.contacts);
    if (r.contacts.length < 100) break;
    searchAfter = r.contacts.at(-1).searchAfter;
  }
  const population = ONLY ? contacts.filter((x) => x.id === ONLY) : contacts;
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${population.length} of ${contacts.length} profile contacts`);

  // Existing profiles by source_contact_id
  const existing = new Map<string, string>();
  for (let page = 1; page < 20; page++) {
    const r = await c.request<any>({ method: 'POST', path: `/objects/${OBJ}/records/search`, autoLocation: false,
      body: { locationId: c.locationId, page, pageLimit: 100 } });
    for (const rec of r.records ?? []) if (rec.properties?.source_contact_id) existing.set(rec.properties.source_contact_id, rec.id);
    if ((r.records ?? []).length < 100) break;
  }
  const ledger: Record<string, string> = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : {};
  for (const [cid, rid] of Object.entries(ledger)) if (!existing.has(cid)) existing.set(cid, rid);

  const ranks = await wixLocalRanks();
  const totals = { created: 0, updated: 0, noop: 0, linked: 0, skippedFields: 0, errors: 0 };

  for (const stub of population) {
    // GET the contact: search omits FILE_UPLOAD values.
    const full = (await c.request<any>({ path: `/contacts/${stub.id}`, autoLocation: false })).contact;
    const cf = (id: string) => (full.customFields ?? []).find((x: any) => x.id === id)?.value;
    const warn: string[] = [];
    const mapKeys = (vals: string[], table: Record<string, string> | Map<string, string>, label: string) =>
      vals.map((v) => {
        const k = table instanceof Map ? table.get(v.toLowerCase()) : table[v.toLowerCase()];
        if (!k) warn.push(`unmapped ${label} "${v}"`);
        return k;
      }).filter(Boolean) as string[];

    const name = [full.firstName, full.lastName].filter(Boolean).join(' ').trim() || full.contactName || full.email;
    const values: Record<string, unknown> = {
      display_name: name,
      profile_status: cf(CF.status) ? String(cf(CF.status)).toLowerCase() : undefined,
      roles: mapKeys(arr(cf(CF.roles)), ROLE_KEYS, 'role'),
      job_title: cf(CF.jobTitle),
      company_name: full.companyName,
      bio: cf(CF.bio),
      linkedin: cf(CF.linkedin),
      website: cf(CF.website),
      programs: mapKeys(arr(cf(CF.programs)), PROGRAM_KEYS, 'program'),
      collectives: mapKeys(arr(cf(CF.collectives)), COLLECTIVE_KEYS, 'collective'),
      service_areas: mapKeys(arr(cf(CF.serviceAreas)), saKey, 'service area'),
      mrl_stops: arr(cf(CF.mrl)), trl_stops: arr(cf(CF.trl)), crl_stops: arr(cf(CF.crl)),
      investor_readiness_stops: arr(cf(CF.irl)),
      readiness_confidence: cf(CF.confidence) ? String(cf(CF.confidence)).toLowerCase() : undefined,
      readiness_rationale: cf(CF.rationale),
      source_contact_id: full.id,
      wix_team_row_id: cf(CF.wixRow),
      rank_local: ranks[full.id],
    };
    for (const k of Object.keys(values)) {
      const v = values[k];
      if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) delete values[k];
    }
    const files: Record<string, unknown> = {};
    if (cf(CF.headshot)) files.headshot = cf(CF.headshot);
    if (cf(CF.companyLogo)) files.company_logo = cf(CF.companyLogo);

    const recId = existing.get(full.id);
    const tag = `${name} (${full.id})`;
    if (!APPLY) {
      console.log(`\n${recId ? 'UPDATE ' + recId : 'CREATE'} ${tag}`);
      console.log('  ' + Object.entries(values).map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 40 ? v.slice(0, 40) + '…' : JSON.stringify(v)}`).join('\n  '));
      console.log(`  files: ${Object.keys(files).join(', ') || '(none)'}`);
      for (const w of warn) console.log(`  !! ${w}`);
      continue;
    }

    try {
      let id = recId;
      const skipped: Array<{ key: string; reason: string }> = [];
      if (!id) {
        const rep = await createObjectRecord(OBJ, values, catalog.byKey, c);
        id = rep.recordId;
        ledger[full.id] = id;
        writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
        skipped.push(...rep.skipped);
        totals.created++;
      }
      // Updates (existing record) and files (only settable on update) go through the one writer.
      // writeRecordFields sends every scalar it is handed (only modifier fields diff internally), so
      // the CALLER diffs scalars against the stored record; otherwise a re-run can never be a no-op.
      let changes: Record<string, unknown> = files;
      if (recId) {
        const cur = ((await c.request<any>({ path: `/objects/${OBJ}/records/${id}` })).record?.properties ?? {}) as Record<string, unknown>;
        changes = { ...files };
        for (const [k, v] of Object.entries(values)) {
          if (Array.isArray(v)) { changes[k] = v; continue; } // option sets: objectWrite diffs these
          if (String(cur[k] ?? '') !== String(v)) changes[k] = v;
        }
      }
      if (Object.keys(changes).length) {
        const wr = await writeRecordFields(OBJ, id!, changes, catalog, c);
        skipped.push(...wr.skipped);
        if (recId) wr.written.length ? totals.updated++ : totals.noop++;
        if (recId && wr.written.length) warn.push(`wrote ${wr.written.join(',')}`);
      } else if (recId) totals.noop++;

      // Association (skip if already linked)
      const linked: string[] = await getRelatedRecordIds(id!, 'contact', c).catch(() => []);
      if (!linked.includes(full.id)) {
        await createRelation({
          associationId: def.id,
          firstRecordId: contactIsFirst ? full.id : id!,
          secondRecordId: contactIsFirst ? id! : full.id,
        }, c);
        totals.linked++;
      }
      totals.skippedFields += skipped.length;
      console.log(`${recId ? 'updated' : 'created'} ${id} ${tag}${skipped.length ? ' SKIPPED: ' + JSON.stringify(skipped) : ''}${warn.length ? ' WARN: ' + warn.join('; ') : ''}`);
    } catch (e: any) {
      totals.errors++;
      console.log(`ERROR ${tag}: ${e?.message ?? e} ${JSON.stringify(e?.body ?? '')}`);
    }
    await sleep(300);
  }
  console.log('\nTOTALS', JSON.stringify(totals));
}

main().catch((e) => { console.error(e?.message ?? e, JSON.stringify(e?.body ?? '')); process.exit(1); });
