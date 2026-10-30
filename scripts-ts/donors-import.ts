// scripts-ts/donors-import.ts — Wix "Funders" (donors) → Profiles (Zach 2026-10-27).
//
//   tsx scripts-ts/donors-import.ts            # DRY RUN
//   tsx scripts-ts/donors-import.ts --apply
//
// Input:  reports/wix-funders-2026-10-26.json  (22 rows from the Wix CSV; company + existing-profile ids
//         decided with Zach 2026-10-26/27 — exact matches, merged duplicates, parent links for Eaton
//         Aerospace / Henry Ford Allegiance / Consumers Energy Foundation; never creates companies)
//         reports/donor-logos-ledger.json      (logo urls already in the GHL Media Library)
// Output: reports/donors-profiles-ledger.json (slug → profile id)
//
// 7 donors are ALREADY Resource profiles: only donor_status / rank_donors / wix_funder_row_id are set
// there, plus the logo ONLY if the profile has none. Everything else on them is left alone.
// The other 15 become profile_type=organization, profile_status=published.
// Idempotent: caller-side scalar diff, relations created only when missing, every record read back.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';
const APPLY = process.argv.includes('--apply');
const PRO = 'custom_objects.profiles';
const R = (f: string) => join(process.cwd(), 'reports', f);
const LEDGER = R('donors-profiles-ledger.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const empty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

async function main() {
  const { ghl } = await import('../lib/ghl/client');
  const { getFieldCatalog } = await import('../lib/ghl/customFields');
  const { createObjectRecord } = await import('../lib/ghl/createRecord');
  const { writeRecordFields } = await import('../lib/ghl/writeRecord');
  const { createRelation, listAssociationDefs, getAllRelations } = await import('../lib/ghl/associations');
  const c = ghl();
  const catalog = await getFieldCatalog(PRO);
  for (const k of ['donor_status', 'rank_donors', 'wix_funder_row_id']) if (!catalog.byKey[`${PRO}.${k}`]) throw new Error(`${k} missing — run donors-setup.ts --apply`);
  const pc: any = (await listAssociationDefs(c)).find((d: any) => d.key === 'profile_company');
  if (!pc) throw new Error('profile_company association missing');
  const bizFirst = pc.first.objectKey === 'business';

  const rows: any[] = JSON.parse(readFileSync(R('wix-funders-2026-10-26.json'), 'utf8'));
  const logos: Record<string, any> = JSON.parse(readFileSync(R('donor-logos-ledger.json'), 'utf8'));
  const ledger: Record<string, string> = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : {};
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} on ${c.locationId} · ${rows.length} donors\n`);
  const T = { created: 0, updated: 0, noop: 0, links: 0, verifyFail: 0, errors: 0 };

  for (const d of rows) {
    const pid0: string | undefined = d.existingProfileId ?? ledger[d.slug];
    const isExistingResource = !!d.existingProfileId;
    const logoUrl: string | undefined = logos[d.slug]?.url;
    const donorVals: Record<string, unknown> = { donor_status: d.donorStatus, rank_donors: d.order, wix_funder_row_id: d.wixRowId };
    const values: Record<string, unknown> = isExistingResource ? donorVals : {
      display_name: d.name, profile_type: 'organization', profile_status: 'published',
      bio: d.description, website: d.website, ...donorVals,
    };
    for (const k of Object.keys(values)) if (empty(values[k])) delete values[k];
    const tag = `#${String(d.order).padStart(2)} ${d.name}`;

    let cur: Record<string, unknown> = {};
    let rels: any[] = [];
    if (pid0) {
      cur = ((await c.request<any>({ path: `/objects/${PRO}/records/${pid0}` })).record?.properties ?? {}) as Record<string, unknown>;
      rels = await getAllRelations(pid0, c);
    }
    const changes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if (String(cur[k] ?? '') !== String(v)) changes[k] = v;
    const wantLogo = logoUrl && empty(cur.company_logo);
    const hasLink = d.companyId && rels.some((x: any) => x.associationId === pc.id && (x.firstRecordId === d.companyId || x.secondRecordId === d.companyId));
    const needLink = d.companyId && !hasLink;

    if (!APPLY) {
      console.log(`${pid0 ? (isExistingResource ? 'UPDATE resource ' : 'UPDATE ') + pid0 : 'CREATE'} ${tag} · ${pid0 ? Object.keys(changes).join(',') || 'no field changes' : Object.keys(values).length + ' fields'}${wantLogo ? ' + logo' : logoUrl ? ' (keeps own logo)' : ' (NO LOGO)'}${needLink ? ' + company link' : d.companyId ? ' (already linked)' : ' (no company)'}`);
      continue;
    }

    try {
      let pid = pid0;
      if (!pid) {
        const rep = await createObjectRecord(PRO, values, catalog.byKey, c);
        pid = rep.recordId; ledger[d.slug] = pid!; writeFileSync(LEDGER, JSON.stringify(ledger, null, 2)); T.created++;
        if (rep.skipped?.length) console.log(`   create skipped ${JSON.stringify(rep.skipped)}`);
      } else ledger[d.slug] = pid;
      const w: Record<string, unknown> = pid0 ? { ...changes } : {};
      if (wantLogo) w.company_logo = [logoUrl];
      let wrote = 0;
      if (Object.keys(w).length) {
        const wr = await writeRecordFields(PRO, pid!, w, catalog, c);
        wrote = wr.written.length;
        if (wr.skipped.length) console.log(`   SKIPPED ${JSON.stringify(wr.skipped)}`);
      }
      if (pid0) wrote ? T.updated++ : T.noop++;
      if (needLink) {
        await createRelation({ associationId: pc.id, firstRecordId: bizFirst ? d.companyId : pid!, secondRecordId: bizFirst ? pid! : d.companyId }, c);
        T.links++; await sleep(300);
      }
      // read back
      const back = ((await c.request<any>({ path: `/objects/${PRO}/records/${pid}` })).record?.properties ?? {}) as Record<string, unknown>;
      const bad = Object.entries(values).filter(([k, v]) => String(back[k] ?? '') !== String(v)).map(([k]) => k);
      if (logoUrl && empty(back.company_logo)) bad.push('company_logo');
      if (d.companyId && !(await getAllRelations(pid!, c)).some((x: any) => x.associationId === pc.id && (x.firstRecordId === d.companyId || x.secondRecordId === d.companyId))) bad.push('profile_company');
      if (bad.length) T.verifyFail++;
      console.log(`${pid0 ? (wrote ? 'updated' : 'noop   ') : 'created'} ${pid} ${tag}${bad.length ? ' !! VERIFY FAILED ' + bad.join(',') : ' ✓'}`);
    } catch (e: any) {
      T.errors++; console.log(`ERROR ${tag}: ${e?.message ?? e} ${JSON.stringify(e?.body ?? '')}`);
    }
    writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
    await sleep(300);
  }
  console.log(`\nTOTALS ${JSON.stringify(T)}`);
}
main().catch((e) => { console.error(e?.message ?? e, JSON.stringify(e?.body ?? '')); process.exit(1); });
