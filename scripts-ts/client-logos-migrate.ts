// scripts-ts/client-logos-migrate.ts — move the website-ready client logos from the Wix "Clients" CMS
// collection onto GHL company records (2026-10-22).
//
//   npx tsx scripts-ts/client-logos-migrate.ts            # DRY RUN
//   npx tsx scripts-ts/client-logos-migrate.ts --apply    # upload + write
//
// Field convention (decided 2026-10-22, see PROJECT_STATE):
//   business.website_logo_url  = THE website logo: a GHL Media Library URL (public CDN) of the prepared,
//                                square, website-ready image. The site reads only this field.
//   business.logo              = whatever file the client sent us (any format). Never shown as-is.
//   business.companylogo       = GHL's own auto-generated logo (source "auto_generated"). Ignore it.
// Display is gated by business.show_logo_on_website + business.website_programs, which this script
// does NOT touch.
//
// Input: reports/client-logos-wix-to-ghl-mapping.json (Wix row -> GHL company, matched by website
// domain, then normalized name, then 13 hand-confirmed fuzzy matches). Every Wix image is a 2000x2000
// canvas; we store an 800x800 PNG rendition (Wix transform keeps transparency).
// Idempotent: skips a company whose website_logo_url is already set; ledger in reports/.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function loadEnvLocal() {
  const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const APPLY = process.argv.includes('--apply');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
const MAP = join(process.cwd(), 'reports', 'client-logos-wix-to-ghl-mapping.json');
const LEDGER = join(process.cwd(), 'reports', 'client-logos-ledger.json');
const MEDIA_FOLDER = '6ada99ddac05a0d91fd3a6d4'; // Media Library: Website / Client Logos
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** wix:image://v1/<id>/<name>#... -> 800x800 PNG rendition url */
function wixRendition(wixImage: string): { url: string; name: string } {
  const m = wixImage.match(/^wix:image:\/\/v1\/([^/]+)\/([^#]+)/);
  if (!m) throw new Error(`not a wix image: ${wixImage}`);
  const base = decodeURIComponent(m[2]).replace(/\.[a-z0-9]+$/i, '');
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'logo';
  return { url: `https://static.wixstatic.com/media/${m[1]}/v1/fill/w_800,h_800,al_c,q_90/${slug}.png`, name: `${slug}.png` };
}

(async () => {
  loadEnvLocal();
  const KEY = process.env.GHL_API_KEY!, LOC = process.env.GHL_LOCATION_ID!;
  const H = { Authorization: `Bearer ${KEY}`, Version: '2021-07-28', 'User-Agent': 'lrl-ops/1.0' };
  async function ghl(method: string, path: string, body?: unknown): Promise<any> {
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`https://services.leadconnectorhq.com${path}`, { method, headers: { ...H, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if (r.status === 429) { await sleep(1000 * 2 ** i); continue; }
      const t = await r.text();
      if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${t}`);
      return t ? JSON.parse(t) : {};
    }
    throw new Error('429 retries exhausted');
  }

  const rows: any[] = JSON.parse(readFileSync(MAP, 'utf8'));
  const ledger: Record<string, any> = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : {};
  const seen = new Set<string>();
  const todo = rows.filter((r) => r.image && r.bizId && (!ONLY || r.bizId === ONLY)).filter((r) => (seen.has(r.bizId) ? false : (seen.add(r.bizId), true)));
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${todo.length} companies with a Wix logo`);
  const stats = { written: 0, skippedHasUrl: 0, errors: 0 };

  for (const r of todo) {
    const rec = (await ghl('GET', `/objects/business/records/${r.bizId}?locationId=${LOC}`)).record;
    const current = rec?.properties?.website_logo_url;
    if (current) { stats.skippedHasUrl++; console.log(`skip (has url) ${rec.properties.name}`); continue; }
    const src = wixRendition(r.image);
    if (!APPLY) { console.log(`WOULD SET ${rec.properties.name} <- ${r.wix} (${src.name})`); continue; }
    try {
      const img = await fetch(src.url);
      if (!img.ok) throw new Error(`download ${img.status} ${src.url}`);
      const bytes = Buffer.from(await img.arrayBuffer());
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), src.name);
      form.append('name', src.name);
      form.append('parentId', MEDIA_FOLDER);
      let up: any;
      for (let i = 0; i < 6; i++) {
        const res = await fetch('https://services.leadconnectorhq.com/medias/upload-file', { method: 'POST', headers: H, body: form });
        if (res.status === 429) { await sleep(1000 * 2 ** i); continue; }
        const t = await res.text();
        if (res.status >= 300) throw new Error(`upload ${res.status} ${t}`);
        up = JSON.parse(t); break;
      }
      const url: string = up?.url;
      if (!url) throw new Error(`upload returned no url: ${JSON.stringify(up)}`);
      await ghl('PUT', `/objects/business/records/${r.bizId}?locationId=${LOC}`, { properties: { website_logo_url: url } });
      const back = (await ghl('GET', `/objects/business/records/${r.bizId}?locationId=${LOC}`)).record.properties.website_logo_url;
      if (back !== url) throw new Error(`did not persist (stored ${back})`);
      ledger[r.bizId] = { company: rec.properties.name, wix: r.wix, mediaId: up.fileId ?? up._id, url, at: new Date().toISOString() };
      writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
      stats.written++;
      console.log(`set ${rec.properties.name} <- ${url}`);
    } catch (e: any) {
      stats.errors++; console.log(`ERROR ${rec?.properties?.name ?? r.bizId}: ${e?.message ?? e}`);
    }
    await sleep(300);
  }
  console.log('TOTALS', JSON.stringify(stats));
})().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
