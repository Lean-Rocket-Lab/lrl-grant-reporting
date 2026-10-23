// scripts-ts/profiles-from-resources.ts — move every Resource record onto a Profile (profile_type =
// resource) and carry its relations over (docs/sprints/profiles-resources-merge.md, Zach 2026-10-23).
//
//   tsx scripts-ts/profiles-from-resources.ts                      # DRY RUN
//   tsx scripts-ts/profiles-from-resources.ts --apply --only=<resourceId>
//   tsx scripts-ts/profiles-from-resources.ts --apply              # all 94
//   tsx scripts-ts/profiles-from-resources.ts --persons [--apply]  # set profile_type=person on the
//                                                                  # existing person profiles
//
// Idempotent on `source_resource_id` + a local ledger (reports/profiles-resources-ledger.json): a re-run
// UPDATES (caller-side scalar diff; objectWrite diffs option/file sets) and links only missing relations.
// The Resources object is READ ONLY here — it becomes a frozen archive.
//
// Relations carried over, per resource:
//   resource_company → profile_company            (business first)
//   resource_contact → profile_contact            (contact first)
//   referral_referred_to_resource → referral_referred_to_profile (activity first)
//   milestone_resource → milestone_profile        (milestone first)
// Plus NEW company links for unlinked resources, exact matches only (Zach 2026-10-23): exactly one
// company with the same normalized name, or exactly one with the same website domain (generic hosts
// excluded). Never creates a company — the company object has no client/provider field, so a created
// provider would count as a company served.
//
// Every record is read back after the write and compared field by field.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
const APPLY = process.argv.includes('--apply');
const PERSONS = process.argv.includes('--persons');
const SKIP_DONE = process.argv.includes('--skip-done'); // resume a run cut off by a shell time limit
const FROM = Number(process.argv.find((a) => a.startsWith('--from='))?.split('=')[1] ?? 0); // verify in slices
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];

const RES = 'custom_objects.resources';
const PRO = 'custom_objects.profiles';
const LEDGER = join(process.cwd(), 'reports', 'profiles-resources-ledger.json');

/** Old association key → new key, and which object of the new pair is stored FIRST (read back 10-23). */
const CARRY: Record<string, { to: string; other: string }> = {
  resource_company: { to: 'profile_company', other: 'business' },
  resource_contact: { to: 'profile_contact', other: 'contact' },
  referral_referred_to_resource: { to: 'referral_referred_to_profile', other: 'custom_objects.activities' },
  milestone_resource: { to: 'milestone_profile', other: 'custom_objects.milestones' },
};

/** Hosts that say nothing about which organization a resource is. */
const GENERIC_HOSTS = new Set([
  'calendly.com', 'linkedin.com', 'facebook.com', 'google.com', 'docs.google.com', 'forms.gle',
  'sites.google.com', 'eventbrite.com', 'youtube.com', 'michigan.gov', 'sba.gov', 'linktr.ee',
  'wixsite.com', 'squarespace.com', 'instagram.com', 'x.com', 'twitter.com',
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const empty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
const host = (v: unknown): string | null => {
  if (empty(v)) return null;
  const raw = String(v).trim();
  try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return null; }
};
/** A domain hit is only trusted when the names plausibly describe the same org: a shared word (4+
 *  letters) inside the other name, or one name is the other's acronym. Measured on the dry run
 *  2026-10-23: a shared domain alone matched "Start Garden" → "Grand Rapids SmartZone" and
 *  "Marr Professional Development" → "Sandler Systems LLC" (a franchise) — those go to review. */
export function namesPlausiblySame(a: string, b: string, norm: (s: string) => string): boolean {
  const ta = norm(a).split(' ').filter(Boolean), tb = norm(b).split(' ').filter(Boolean);
  const ca = ta.join(''), cb = tb.join('');
  if (ta.some((t) => t.length >= 4 && cb.includes(t)) || tb.some((t) => t.length >= 4 && ca.includes(t))) return true;
  const stop = new Set(['of', 'for', 'and', 'the', 'a']);
  const acr = (ts: string[]) => ts.filter((t) => !stop.has(t)).map((t) => t[0]).join('');
  const strip = (s: string) => s.replace(/\(.*?\)/g, ' ');
  const sa = norm(strip(a)).split(' ').filter(Boolean), sb = norm(strip(b)).split(' ').filter(Boolean);
  return (sb.length === 1 && acr(sa) === sb[0]) || (sa.length === 1 && acr(sb) === sa[0]);
}
const sameSet = (a: unknown, b: unknown) => {
  const x = (Array.isArray(a) ? a : empty(a) ? [] : [a]).map(String).sort();
  const y = (Array.isArray(b) ? b : empty(b) ? [] : [b]).map(String).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

async function searchAll(c: any, objectKey: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page < 50; page++) {
    const r = await c.request({ method: 'POST', path: `/objects/${objectKey}/records/search`, autoLocation: false,
      body: { locationId: c.locationId, page, pageLimit: 500, query: '' } });
    out.push(...(r.records ?? []));
    if ((r.records ?? []).length < 500) break;
  }
  return out;
}

async function main() {
  const { ghl } = await import('../lib/ghl/client');
  const { getFieldCatalog } = await import('../lib/ghl/customFields');
  const { createObjectRecord } = await import('../lib/ghl/createRecord');
  const { writeRecordFields } = await import('../lib/ghl/writeRecord');
  const { createRelation, listAssociationDefs, getAllRelations } = await import('../lib/ghl/associations');
  const { normalizeName } = await import('../lib/dedup/normalize');
  const c = ghl();
  const catalog = await getFieldCatalog(PRO);
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} on ${c.locationId}`);

  const profiles = await searchAll(c, PRO);

  // ── --persons: mark the existing person profiles ────────────────────────────────────────────────
  if (PERSONS) {
    let n = 0;
    for (const p of profiles) {
      const pr = p.properties ?? {};
      if (pr.source_resource_id || pr.profile_type) continue;
      n++;
      console.log(`${APPLY ? 'set ' : 'would set '} person  ${pr.display_name} (${p.id})`);
      if (!APPLY) continue;
      const wr = await writeRecordFields(PRO, p.id, { profile_type: 'person' }, catalog, c);
      if (!wr.written.length) console.log(`  !! not written ${JSON.stringify(wr.skipped)}`);
      await sleep(300);
    }
    console.log(`\n${n} person profile(s) ${APPLY ? 'set' : 'to set'}`);
    return;
  }

  // ── definitions (read, never assumed) ───────────────────────────────────────────────────────────
  const defs = await listAssociationDefs(c);
  const byKey = new Map(defs.map((d: any) => [d.key, d]));
  const byId = new Map(defs.map((d: any) => [d.id, d]));
  for (const { to } of Object.values(CARRY)) if (!byKey.has(to)) throw new Error(`association ${to} missing — run profiles-resources-setup.ts --apply`);

  // service area label → option key on Profiles
  const saOpts = new Map<string, string>(
    ((catalog.byKey[`${PRO}.service_areas`] as any)?.options ?? []).map((o: any) => [String(o.label).toLowerCase(), o.key]),
  );

  // programs / collectives: 64 of 94 resources hold a comma-joined LABEL string, not an array of keys
  // (legacy writes). Keys are shared between the two objects; labels differ ("Manufacturing" vs
  // "Manufacturing Tech"), so accept key or label from EITHER catalog and emit keys.
  const resCatalog = await getFieldCatalog(RES);
  const optKey = (field: string) => {
    const m = new Map<string, string>();
    for (const cat of [resCatalog.byKey[`${RES}.${field}`], catalog.byKey[`${PRO}.${field}`]] as any[]) {
      for (const o of cat?.options ?? []) { m.set(String(o.key).toLowerCase(), o.key); m.set(String(o.label).toLowerCase(), o.key); }
    }
    return m;
  };
  const OPT = { programs: optKey('programs'), collectives: optKey('collectives') };
  const toKeys = (field: 'programs' | 'collectives', v: unknown, warn: string[]): string[] => {
    const parts = Array.isArray(v) ? v.map(String) : empty(v) ? [] : String(v).split(',');
    return Array.from(new Set(parts.map((x) => x.trim()).filter(Boolean).map((x) => {
      const k = OPT[field].get(x.toLowerCase()); if (!k) warn.push(`unmapped ${field} "${x}"`); return k;
    }).filter(Boolean) as string[]));
  };

  // companies for exact matching
  const companies = await searchAll(c, 'business');
  const byName = new Map<string, any[]>(); const byHost = new Map<string, any[]>();
  for (const b of companies) {
    const pr = b.properties ?? {};
    const n = normalizeName(pr.name); if (n) byName.set(n, [...(byName.get(n) ?? []), b]);
    const h = host(pr.website); if (h && !GENERIC_HOSTS.has(h)) byHost.set(h, [...(byHost.get(h) ?? []), b]);
  }

  const resources = (await searchAll(c, RES)).filter((r) => !ONLY || r.id === ONLY);
  const existing = new Map<string, string>();
  for (const p of profiles) if (p.properties?.source_resource_id) existing.set(p.properties.source_resource_id, p.id);
  mkdirSync(join(process.cwd(), 'reports'), { recursive: true });
  const ledger: Record<string, string> = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : {};
  for (const [rid, pid] of Object.entries(ledger)) if (!existing.has(rid)) existing.set(rid, pid);
  console.log(`resources=${resources.length} profiles=${profiles.length} companies=${companies.length} already migrated=${existing.size}\n`);

  const T = { created: 0, updated: 0, noop: 0, relations: 0, newCompanyLinks: 0, verifyFail: 0, errors: 0 };
  const review: string[] = [];

  for (const r of resources.slice(FROM)) {
    if (SKIP_DONE && existing.has(r.id)) continue;
    const p = r.properties ?? {};
    const name = String(p.resources ?? '').trim();
    const warn: string[] = [];
    const sa = String(p.service_areas ?? '').split(';').map((s) => s.trim()).filter(Boolean).map((l) => {
      const k = saOpts.get(l.toLowerCase()); if (!k) warn.push(`unmapped service area "${l}"`); return k;
    }).filter(Boolean) as string[];
    const rank = p.rank_local__mainstreet;
    const values: Record<string, unknown> = {
      display_name: name,
      profile_type: 'resource',
      profile_status: p.resource_status,
      category: p.category, sub_category: p.sub_category,
      short_description: p.short_description, bio: p.full_description,
      website: p.website, public_email: p.email,
      programs: toKeys('programs', p.programs, warn), collectives: toKeys('collectives', p.collectives, warn), service_areas: sa,
      mrl_stops: p.mrl_stops, trl_stops: p.trl_stops, crl_stops: p.crl_stops,
      investor_readiness_stops: p.investor_readiness_stops, msrl_stops: p.msrl_stops,
      readiness_confidence: p.readiness_confidence, readiness_rationale: p.readiness_rationale,
      rank_local: rank, rank_mainstreet: rank,
      source_resource_id: r.id, wix_resource_row_id: p.wix_resource_row_id,
    };
    for (const k of Object.keys(values)) if (empty(values[k])) delete values[k];
    const files: Record<string, unknown> = {};
    if (!empty(p.resource_logo)) files.company_logo = p.resource_logo;

    // relations to carry
    const rels = await getAllRelations(r.id, c);
    const carry: Array<{ to: string; other: string; otherId: string }> = [];
    for (const x of rels) {
      const d: any = byId.get(x.associationId); if (!d || !CARRY[d.key]) { warn.push(`unknown relation ${x.associationId}`); continue; }
      const otherId = x.firstRecordId === r.id ? x.secondRecordId : x.firstRecordId;
      carry.push({ ...CARRY[d.key], otherId });
    }
    if (!carry.some((x) => x.other === 'business')) {
      const nHits = byName.get(normalizeName(name)) ?? [];
      const h = host(p.website);
      const hAll = h && !GENERIC_HOSTS.has(h) ? byHost.get(h) ?? [] : [];
      const hHits = hAll.filter((b) => namesPlausiblySame(name, String(b.properties?.name ?? ''), normalizeName));
      if (hAll.length && !hHits.length) warn.push(`domain ${h} matches ${hAll.map((b) => b.properties?.name).join(' / ')} but the names differ → review`);
      const pick = nHits.length === 1 ? { b: nHits[0], via: 'name' } : hHits.length === 1 ? { b: hHits[0], via: `domain ${h}` } : null;
      if (pick) { carry.push({ to: 'profile_company', other: 'business', otherId: pick.b.id }); warn.push(`NEW company link via ${pick.via} → ${pick.b.properties?.name}`); T.newCompanyLinks++; }
      else review.push(`${name}${nHits.length > 1 || hHits.length > 1 ? ' (AMBIGUOUS)' : ''}${h ? ` [${h}]` : ''}${hAll.length && !hHits.length ? ` (domain shared with ${hAll.map((b) => b.properties?.name).join(' / ')})` : ''}`);
    }

    const pid0 = existing.get(r.id);
    const tag = `${name} (${r.id})`;
    if (!APPLY) {
      console.log(`${pid0 ? 'UPDATE ' + pid0 : 'CREATE'} ${tag} · ${Object.keys(values).length} fields${files.company_logo ? ' + logo' : ''} · relations: ${carry.map((x) => x.to.replace('_profile', '').replace('profile_', '')).join(', ') || 'none'}`);
      for (const w of warn) console.log(`   ${w}`);
      continue;
    }

    try {
      let pid = pid0;
      const skipped: any[] = [];
      if (!pid) {
        const rep = await createObjectRecord(PRO, values, catalog.byKey, c);
        pid = rep.recordId; ledger[r.id] = pid; writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
        skipped.push(...rep.skipped.filter((s: any) => s.key !== 'company_logo')); T.created++;
      }
      let changes: Record<string, unknown> = { ...files };
      if (pid0) {
        const cur = ((await c.request<any>({ path: `/objects/${PRO}/records/${pid}` })).record?.properties ?? {}) as Record<string, unknown>;
        for (const [k, v] of Object.entries(values)) {
          if (Array.isArray(v)) { changes[k] = v; continue; }
          if (String(cur[k] ?? '') !== String(v)) changes[k] = v;
        }
      }
      let wrote = 0;
      if (Object.keys(changes).length) {
        const wr = await writeRecordFields(PRO, pid!, changes, catalog, c);
        skipped.push(...wr.skipped); wrote = wr.written.length;
      }
      if (pid0) wrote ? T.updated++ : T.noop++;

      // relations (only missing ones)
      const have = new Set((await getAllRelations(pid!, c)).map((x: any) => `${x.associationId}:${x.firstRecordId === pid ? x.secondRecordId : x.firstRecordId}`));
      for (const x of carry) {
        const d: any = byKey.get(x.to);
        if (have.has(`${d.id}:${x.otherId}`)) continue;
        const otherFirst = d.first.objectKey === x.other;
        await createRelation({ associationId: d.id, firstRecordId: otherFirst ? x.otherId : pid!, secondRecordId: otherFirst ? pid! : x.otherId }, c);
        T.relations++; await sleep(300);
      }

      // read back
      const back = ((await c.request<any>({ path: `/objects/${PRO}/records/${pid}` })).record?.properties ?? {}) as Record<string, unknown>;
      const bad = Object.entries(values).filter(([k, v]) => Array.isArray(v) ? !sameSet(back[k], v) : String(back[k] ?? '') !== String(v)).map(([k]) => k);
      if (files.company_logo && empty(back.company_logo)) bad.push('company_logo');
      const relBack = await getAllRelations(pid!, c);
      const missingRel = carry.filter((x) => !relBack.some((y: any) => y.associationId === (byKey.get(x.to) as any).id && (y.firstRecordId === x.otherId || y.secondRecordId === x.otherId)));
      if (bad.length || missingRel.length) { T.verifyFail++; warn.push(`VERIFY FAILED fields=${bad.join(',')} relations=${missingRel.map((x) => x.to).join(',')}`); }
      console.log(`${pid0 ? (wrote ? 'updated' : 'noop   ') : 'created'} ${pid} ${tag}${skipped.length ? ' SKIPPED ' + JSON.stringify(skipped) : ''}${warn.length ? ' · ' + warn.join(' · ') : ''}`);
    } catch (e: any) {
      T.errors++; console.log(`ERROR ${tag}: ${e?.message ?? e} ${JSON.stringify(e?.body ?? '')}`);
    }
    await sleep(300);
  }

  console.log(`\nTOTALS ${JSON.stringify(T)}`);
  console.log(`\nNo company in CRM (left unlinked, ${review.length}):\n  ${review.join('\n  ')}`);
}

main().catch((e) => { console.error(e?.message ?? e, JSON.stringify(e?.body ?? '')); process.exit(1); });
