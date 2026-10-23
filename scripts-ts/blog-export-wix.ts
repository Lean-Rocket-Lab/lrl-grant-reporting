// scripts-ts/blog-export-wix.ts — phase 1 of the Wix -> GHL blog migration (docs/sprints/blog-migration.md).
// Read-only. Pulls every published Wix blog post with rich content, media, SEO, categories and tags
// into reports/blog-migration/wix-export.json.
//
//   npx tsx scripts-ts/blog-export-wix.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function loadEnvLocal() {
  const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();

async function main() {
  const { wix } = await import('../lib/wix');
  const w = wix();
  const cats = await w.request<any>({ method: 'POST', path: '/blog/v3/categories/query', body: { paging: { limit: 100 } } });
  const tags = await w.request<any>({ method: 'POST', path: '/blog/v3/tags/query', body: { paging: { limit: 100 } } });
  const posts: any[] = [];
  for (let offset = 0; ; offset += 100) {
    const r = await w.request<any>({
      method: 'POST',
      path: '/blog/v3/posts/query',
      body: { fieldsets: ['URL', 'RICH_CONTENT', 'SEO', 'CONTENT_TEXT'], paging: { limit: 100, offset } },
    });
    posts.push(...(r.posts ?? []));
    if ((r.posts ?? []).length < 100) break;
  }
  const out = {
    exportedAt: new Date().toISOString(),
    categories: (cats.categories ?? []).map((c: any) => ({ id: c.id, label: c.label ?? c.title })),
    tags: (tags.tags ?? []).map((t: any) => ({ id: t.id, label: t.label })),
    posts,
  };
  const file = join(process.cwd(), 'reports', 'blog-migration', 'wix-export.json');
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`exported ${posts.length} posts, ${out.categories.length} categories, ${out.tags.length} tags -> ${file}`);
}
main().catch((e) => { console.error(e?.body ?? e); process.exit(1); });
