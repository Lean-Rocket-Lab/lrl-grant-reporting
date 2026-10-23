// @ts-nocheck — one-shot blog migration script (ran 2026-10-21); type errors here broke `next build`
// on 2026-10-23 (Set iteration under the ES5 target, Buffer as BlobPart). Not part of the app.
// scripts-ts/blog-migrate-update.ts — phase 4 of docs/sprints/blog-migration.md (2026-10-21).
// Adds categories, the "Lean Rocket Lab" author, and staging canonical links to every migrated post.
//
//   tsx scripts-ts/blog-migrate-update.ts                  # DRY RUN: print the diff per post
//   tsx scripts-ts/blog-migrate-update.ts --apply --only=<slug>
//   tsx scripts-ts/blog-migrate-update.ts --apply [--limit=20]
//   CANONICAL=new tsx ... --apply                          # at cutover: drop the Wix canonicals
//
// PUT /blogs/posts/{id} wants the whole post (blogId, rawHTML, status required), so each write is built from
// a fresh GET of the post with only the three fields changed, then read back and compared. Posts whose
// author/categories/canonical already match are a noop. Canonical during staging = the live Wix url, so
// Google keeps ranking Wix while apply.leanrocketlab.org serves duplicates.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function loadEnvLocal() {
  const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();
process.env.GHL_MAX_RPS ??= '3';
const APPLY = process.argv.includes('--apply');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 1e9);
const CANON_MODE = process.env.CANONICAL ?? 'wix';
const DIR = join(process.cwd(), 'reports', 'blog-migration');

// plan label -> GHL label. AI Software has no GHL category; it stays a tag only.
const ALIAS: Record<string, string | null> = { podcast: 'startup storytelling podcast', 'ai software': null };
const norm = (s: string) => s.trim().toLowerCase().replace(/[,.;:]+$/, '');
const KEEP = ['title', 'blogId', 'imageUrl', 'description', 'rawHTML', 'status', 'wordCount', 'readTimeInMinutes',
  'imageAltText', 'tags', 'urlSlug', 'publishedAt', 'externalFonts', 'archived'];

async function main() {
  const { ghl } = await import('../lib/ghl');
  const g = ghl();
  const plan: any[] = JSON.parse(readFileSync(join(DIR, 'plan.json'), 'utf8'));
  const ledger = JSON.parse(readFileSync(join(DIR, 'ledger.json'), 'utf8'));
  const cats = (await g.request<any>({ path: '/blogs/categories', params: { limit: 50, offset: 0 } })).categories ?? [];
  const catId = new Map<string, string>(cats.map((c: any) => [norm(c.label), c._id]));
  const authors = (await g.request<any>({ path: '/blogs/authors', params: { limit: 50, offset: 0 } })).authors ?? [];
  const author = authors.find((a: any) => norm(a.name) === 'lean rocket lab');
  if (!author) throw new Error('author "Lean Rocket Lab" not found');

  let done = 0, noop = 0, written = 0, failed = 0;
  for (const e of plan) {
    if (ONLY && e.slug !== ONLY) continue;
    if (done >= LIMIT) break;
    const led = ledger.posts[e.key];
    if (!led) { console.error(`  not in ledger: ${e.slug}`); failed++; continue; }
    const wantCats = [...new Set((e.categories as string[]).map((l) => {
      const k = norm(l); const a = k in ALIAS ? ALIAS[k] : k;
      if (a === null) return null;
      const id = catId.get(a!); if (!id) throw new Error(`no GHL category for "${l}"`); return id;
    }).filter(Boolean) as string[])].sort();
    const wantCanon = CANON_MODE === 'wix' && e.oldUrl ? e.oldUrl : '';

    const cur = (await g.request<any>({ path: `/blogs/posts/${led.id}` })).blogPost;
    const curCats = (cur.categories ?? []).map((c: any) => (typeof c === 'string' ? c : c._id)).sort();
    const same = cur.author === author._id && curCats.join() === wantCats.join() && (cur.canonicalLink ?? '') === wantCanon;
    done++;
    if (same) { noop++; continue; }
    const diff = `author ${cur.author ?? '-'}->${author._id} | cats ${curCats.length}->${wantCats.length} | canonical ${cur.canonicalLink ?? '-'} -> ${wantCanon || '(self)'}`;
    if (!APPLY) { console.log(`  ${e.slug}: ${diff}`); continue; }
    try {
      const body: any = Object.fromEntries(KEEP.filter((k) => cur[k] !== undefined && cur[k] !== null).map((k) => [k, cur[k]]));
      Object.assign(body, { author: author._id, categories: wantCats, ...(wantCanon ? { canonicalLink: wantCanon } : { canonicalLink: '' }) });
      await g.request<any>({ method: 'PUT', path: `/blogs/posts/${led.id}`, autoLocation: false, body: { ...body, locationId: g.locationId } });
      const after = (await g.request<any>({ path: `/blogs/posts/${led.id}` })).blogPost;
      const afterCats = (after.categories ?? []).map((c: any) => (typeof c === 'string' ? c : c._id)).sort().join();
      const lost = KEEP.filter((k) => JSON.stringify(cur[k] ?? null) !== JSON.stringify(after[k] ?? null) && k !== 'updatedAt');
      if (after.author !== author._id || afterCats !== wantCats.join() || (after.canonicalLink ?? '') !== wantCanon || lost.length)
        throw new Error(`read-back mismatch: author=${after.author} cats=${afterCats} canon=${after.canonicalLink} changed=${lost.join(',')}`);
      written++; console.log(`  updated ${e.slug}`);
    } catch (err: any) { failed++; console.error(`  FAILED ${e.slug}:`, JSON.stringify(err?.body ?? err?.message ?? err)); }
  }
  console.log(`${APPLY ? '' : 'DRY RUN '}checked ${done}: ${written} updated, ${noop} already correct, ${failed} failed`);
}
main().catch((e) => { console.error(JSON.stringify(e?.body ?? e?.message ?? e)); process.exit(1); });
