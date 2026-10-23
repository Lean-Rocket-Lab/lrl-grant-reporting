// @ts-nocheck — one-shot blog migration script (ran 2026-10-21); type errors here broke `next build`
// on 2026-10-23 (Set iteration under the ES5 target, Buffer as BlobPart). Not part of the app.
// scripts-ts/blog-migrate-ghl.ts — phase 3 of the Wix -> GHL blog migration (docs/sprints/blog-migration.md).
//
// Reads reports/blog-migration/plan.json (built by scripts/blog-migrate-build.py), re-hosts every cover and
// inline image into GHL Media ("Blog Migration" folder), and creates one published GHL blog post per entry.
//
//   tsx scripts-ts/blog-migrate-ghl.ts                     # DRY RUN: resolve blogs/author/categories, print plan
//   tsx scripts-ts/blog-migrate-ghl.ts --apply --only=<slug>
//   tsx scripts-ts/blog-migrate-ghl.ts --apply             # everything not already in the ledger
//   tsx scripts-ts/blog-migrate-ghl.ts --verify            # read every post back and compare to the plan
//
// Idempotent: reports/blog-migration/ledger.json records each uploaded image (source -> GHL url) and each
// created post (plan key -> post id). A ledgered post is never created twice; the slug check is a second guard.
// The GHL API cannot create blogs, authors or categories; those are made in the UI first (the dry run fails
// loudly naming whatever is missing).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

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
const VERIFY = process.argv.includes('--verify');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
const DIR = join(process.cwd(), 'reports', 'blog-migration');
const LEDGER_FILE = join(DIR, 'ledger.json');
const BLOG_NAMES = { blog: process.env.BLOG_NAME_BLOG ?? 'Lean Rocket Lab Blog', podcast: process.env.BLOG_NAME_PODCAST ?? 'Startup Storytelling Podcast' };
const AUTHOR_NAME = process.env.BLOG_AUTHOR ?? 'Lean Rocket Lab';

type Ledger = { folderId?: string; media: Record<string, string>; posts: Record<string, { id: string; blogId: string; slug: string }> };
const ledger: Ledger = existsSync(LEDGER_FILE) ? JSON.parse(readFileSync(LEDGER_FILE, 'utf8')) : { media: {}, posts: {} };
const saveLedger = () => writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2));
const norm = (s: string) => s.trim().toLowerCase().replace(/[,.;:]+$/, '');
// plan label -> GHL label (same table as blog-migrate-update.ts). null = tag only, no GHL category.
const ALIAS: Record<string, string | null> = { podcast: 'startup storytelling podcast', 'ai software': null };
const catKeys = (labels: string[]) => labels.map((l) => (norm(l) in ALIAS ? ALIAS[norm(l)] : norm(l))).filter((x): x is string => !!x);

async function main() {
  const { ghl } = await import('../lib/ghl');
  const g = ghl();
  const plan: any[] = JSON.parse(readFileSync(join(DIR, 'plan.json'), 'utf8'));

  // ---- resolve the things only the UI can create
  const blogs = (await g.request<any>({ path: '/blogs/site/all', params: { limit: 50, skip: 0 } })).data ?? [];
  const blogId: Record<string, string> = {};
  for (const [k, name] of Object.entries(BLOG_NAMES)) {
    const b = blogs.find((x: any) => norm(x.name ?? '') === norm(name));
    if (b) blogId[k] = b._id;
  }
  const authors = (await g.request<any>({ path: '/blogs/authors', params: { limit: 50, offset: 0 } })).authors ?? [];
  const author = authors.find((a: any) => norm(a.name ?? '') === norm(AUTHOR_NAME)) ?? authors[0];
  const cats = (await g.request<any>({ path: '/blogs/categories', params: { limit: 50, offset: 0 } })).categories ?? [];
  const catId: Record<string, string> = Object.fromEntries(cats.map((c: any) => [norm(c.label ?? c.name ?? ''), c._id]));

  const missing: string[] = [];
  for (const [k, name] of Object.entries(BLOG_NAMES)) if (!blogId[k]) missing.push(`blog "${name}"`);
  // Authors and categories are optional: the UI may not expose them yet. With no categories in GHL, the
  // category labels travel as TAGS so the website widget can still filter by topic.
  const USE_CATS = cats.length > 0;
  if (!author) console.warn(`no author "${AUTHOR_NAME}" in GHL; posts will have no byline`);
  if (USE_CATS) {
    const neededCats = [...new Set(plan.flatMap((e) => e.categories as string[]))];
    for (const c of catKeys(neededCats)) if (!catId[c]) missing.push(`category "${c}"`);
  } else console.warn('no blog categories in GHL; category labels will be written as tags');
  console.log('blogs found:', blogs.map((b: any) => b.name).join(', ') || '(none)');
  console.log('author:', author?.name ?? '(none)', '| categories found:', cats.map((c: any) => c.label).join(', ') || '(none)');
  if (missing.length) {
    console.error('MISSING in GHL (create in Sites -> Blogs first):\n  - ' + missing.join('\n  - '));
    process.exit(2);
  }

  if (VERIFY) return verify(g, plan, blogId, catId, USE_CATS);

  const todo = plan.filter((e) => (!ONLY || e.slug === ONLY) && !ledger.posts[e.key]);
  console.log(`${plan.length} in plan, ${Object.keys(ledger.posts).length} already created, ${todo.length} to do${APPLY ? '' : ' (DRY RUN)'}`);
  if (!APPLY) {
    for (const e of todo) console.log(`  [${e.blog}] ${e.publishedAt.slice(0, 10)}  ${e.slug}  cats=${e.categories.join('|')}  imgs=${e.inlineImages.length}  cover=${e.cover.file ? 'generated' : 'source'}`);
    return;
  }

  // ---- media folder
  if (!ledger.folderId) {
    try {
      const f = await g.request<any>({ method: 'POST', path: '/medias/folder', autoLocation: false,
        body: { altId: g.locationId, altType: 'location', name: 'Blog Migration' } });
      ledger.folderId = f._id ?? f.id ?? f.folder?._id; saveLedger();
      console.log('media folder:', ledger.folderId);
    } catch (e: any) { console.warn('could not create media folder, uploading to root:', JSON.stringify(e?.body ?? e)); }
  }

  async function rehost(src: string | undefined, file: string | undefined, name: string): Promise<string> {
    const key = file ? 'file:' + basename(file) : src!;
    if (ledger.media[key]) return ledger.media[key];
    let bytes: Buffer, type: string;
    if (file) { bytes = readFileSync(file); type = 'image/png'; }
    else {
      const r = await fetch(src!); if (!r.ok) throw new Error(`download ${src} -> HTTP ${r.status}`);
      bytes = Buffer.from(await r.arrayBuffer()); type = r.headers.get('content-type') ?? 'image/jpeg';
    }
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : 'jpg';
    const fname = `${name.slice(0, 80)}.${ext}`;
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), fname);
    form.append('name', fname);
    if (ledger.folderId) form.append('parentId', ledger.folderId);
    const res = await g.request<any>({ method: 'POST', path: '/medias/upload-file', autoLocation: false, body: form });
    const url = res.url ?? res.fileUrl ?? res.data?.url;
    if (!url) throw new Error('upload returned no url: ' + JSON.stringify(res));
    ledger.media[key] = url; saveLedger();
    return url;
  }

  let ok = 0, failed = 0;
  for (const e of todo) {
    try {
      const cover = await rehost(e.cover.source, e.cover.file, e.slug);
      let html: string = e.html;
      for (let i = 0; i < e.inlineImages.length; i++) {
        const src = e.inlineImages[i];
        html = html.split(src).join(await rehost(src, undefined, `${e.slug}-${i + 1}`));
      }
      const exists = await g.request<any>({ path: '/blogs/posts/url-slug-exists', params: { urlSlug: e.slug } });
      if (exists?.exists) throw new Error(`slug "${e.slug}" already exists in GHL but not in the ledger; resolve by hand`);
      const body = {
        locationId: g.locationId, blogId: blogId[e.blog], title: e.title, description: e.description,
        imageUrl: cover, imageAltText: e.cover.alt, rawHTML: html, status: 'PUBLISHED',
        ...(author ? { author: author._id } : {}),
        ...(USE_CATS ? { categories: [...new Set(catKeys(e.categories).map((c) => catId[c]))] } : {}),
        tags: [...new Set([...(USE_CATS ? [] : e.categories), ...e.tags])], urlSlug: e.slug,
        publishedAt: new Date(e.publishedAt).toISOString(), wordCount: e.wordCount, readTimeInMinutes: e.readTime,
      };
      const res = await g.request<any>({ method: 'POST', path: '/blogs/posts', autoLocation: false, body });
      const id = res.blogPost?._id ?? res.data?._id ?? res.data?.id ?? res._id;
      if (!id) throw new Error('create returned no id: ' + JSON.stringify(res).slice(0, 500));
      ledger.posts[e.key] = { id, blogId: blogId[e.blog], slug: e.slug }; saveLedger();
      ok++; console.log(`  created [${e.blog}] ${e.slug} -> ${id}`);
    } catch (err: any) {
      failed++; console.error(`  FAILED ${e.slug}:`, JSON.stringify(err?.body ?? err?.message ?? err));
    }
  }
  console.log(`done: ${ok} created, ${failed} failed`);
}

async function verify(g: any, plan: any[], blogId: Record<string, string>, catId: Record<string, string>, USE_CATS: boolean) {
  const live: any[] = [];
  for (const id of new Set(Object.values(blogId))) {
    for (let offset = 0; ; offset += 50) {
      const r = await g.request<any>({ path: '/blogs/posts/all', params: { blogId: id, limit: 50, offset, status: 'PUBLISHED' } });
      const posts = r.blogs ?? r.data ?? r.posts ?? [];
      live.push(...posts);
      if (posts.length < 50) break;
    }
  }
  const bySlug = new Map(live.map((p: any) => [p.urlSlug, p]));
  const problems: string[] = []; const rows: string[] = ['old_url,new_slug,blog'];
  for (const e of plan) {
    const hit = bySlug.get(e.slug);
    if (!hit) { problems.push(`MISSING ${e.slug}`); continue; }
    // the list omits tags and body, so read the full post
    const p = (await g.request<any>({ path: `/blogs/posts/${hit._id}` })).blogPost;
    const imgs = (p.rawHTML.match(/<img [^>]*src="([^"]+)"/g) ?? []);
    if (imgs.some((t: string) => /wixstatic/.test(t))) problems.push(`WIX IMAGE ${e.slug}`);
    if (imgs.length !== e.inlineImages.length) problems.push(`IMAGES ${e.slug}: want ${e.inlineImages.length} got ${imgs.length}`);
    if (e.blog === 'podcast' && !/youtube\.com\/embed\//.test(p.rawHTML)) problems.push(`NO PLAYER ${e.slug}`);
    if (new Date(p.publishedAt).getTime() !== new Date(e.publishedAt).getTime()) problems.push(`DATE ${e.slug}: ${p.publishedAt}`);
    if (p.title !== e.title) problems.push(`TITLE ${e.slug}: "${p.title}"`);
    if (!p.imageUrl) problems.push(`NO COVER ${e.slug}`);
    if ((p.blogId ?? blogId[e.blog]) !== blogId[e.blog]) problems.push(`WRONG BLOG ${e.slug}`);
    if (USE_CATS) {
      const want = [...new Set(catKeys(e.categories).map((c) => catId[c]))].sort().join();
      const got = (p.categories ?? []).map((c: any) => (typeof c === 'string' ? c : c._id)).sort().join();
      if (want !== got) problems.push(`CATEGORIES ${e.slug}: want ${want} got ${got}`);
    } else {
      const tags = new Set((p.tags ?? []).map((t: any) => (typeof t === 'string' ? t : t.name ?? t.label)));
      for (const c of e.categories) if (!tags.has(c)) problems.push(`TAG ${e.slug}: missing "${c}"`);
    }
    if (!p.author) problems.push(`NO AUTHOR ${e.slug}`);
    if ((p.canonicalLink ?? '') !== (e.oldUrl ?? '')) problems.push(`CANONICAL ${e.slug}: ${p.canonicalLink}`);
    if (e.oldUrl) rows.push(`${e.oldUrl},${e.slug},${e.blog}`);
  }
  writeFileSync(join(DIR, 'redirect-map.csv'), rows.join('\n') + '\n');
  const dupes = live.length - bySlug.size;
  if (dupes) problems.push(`${dupes} DUPLICATE slug(s) live`);
  console.log(`verify: ${plan.length} planned, ${live.length} live, ${problems.length} problems`);
  for (const p of problems) console.log('  ' + p);
  if (live[0]) console.log('sample live post keys:', Object.keys(live[0]).join(','));
}

main().catch((e) => { console.error(JSON.stringify(e?.body ?? e?.message ?? e)); process.exit(1); });
