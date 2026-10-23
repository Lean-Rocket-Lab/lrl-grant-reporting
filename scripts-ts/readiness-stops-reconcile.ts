// scripts-ts/readiness-stops-reconcile.ts — make every Profile's stop fields (person AND resource
// profiles — Resources moved onto Profiles 2026-10-23) equal what
// its CURRENT service_areas derive to (STOP_SERVICES), all five lines incl. MSRL.
//
//   npx tsx scripts-ts/readiness-stops-reconcile.ts           # dry run: list the drift
//   npx tsx scripts-ts/readiness-stops-reconcile.ts --apply   # write {add,remove} modifiers
//
// Why it exists (2026-10-22): when a re-tag makes a line EMPTY, the write layer drops the empty value
// instead of clearing the field, so the old stops stay forever (Amy Proffitt kept MRL 6/9/10, Jeff
// Matzen kept MRL 8/9). This sends explicit `remove` modifiers, which GHL honors. No LLM calls.
// Reads each record with a GET (the search index lags writes and gave false drift).
const ROOT = process.cwd();
import { readFileSync } from 'node:fs';
for (const line of readFileSync(ROOT + '/.env.local', 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const APPLY = process.argv.includes('--apply');
(async () => {
  const { ghl } = await import(ROOT + '/lib/ghl/client');
  const R = await import(ROOT + '/lib/enrichment/data/readiness');
  const { profileServiceKey } = await import(ROOT + '/lib/enrichment/enrichers/profileTagger');
  const c = ghl();
  const keyToTag = new Map((Object.keys(R.SERVICES) as any[]).map((t) => [profileServiceKey(t), t]));
  let fixes = 0;
  for (const [obj, toTags] of [
    ['custom_objects.profiles', (v: any) => (Array.isArray(v) ? v : []).map((k: string) => keyToTag.get(k)).filter(Boolean)],
  ] as const) {
    const recs: any[] = [];
    for (let page = 1; page < 5; page++) { const d: any = await c.request({ method: 'POST', path: `/objects/${obj}/records/search`, autoLocation: false, body: { locationId: c.locationId, page, pageLimit: 100 } }); recs.push(...d.records); if (d.records.length < 100) break; }
    for (const r0 of recs) {
      const r = ((await c.request({ path: `/objects/${obj}/records/${r0.id}` }) as any).record) ?? r0;
      const p = r.properties ?? {}; const tags = (toTags as any)(p.service_areas);
      if (!tags.length) continue;
      const want = R.deriveStops(tags as any);
      const props: Record<string, any> = {};
      for (const l of R.LINE_KEYS) {
        const k = R.LINE_STOP_BARE[l]; const have = (p[k] ?? []).map(String); const w = want[l].map(String);
        const add = w.filter((x: string) => !have.includes(x)); const remove = have.filter((x: string) => !w.includes(x));
        if (add.length || remove.length) props[k] = { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) };
      }
      if (Object.keys(props).length) {
        fixes++; console.log(obj.split('.')[1], p.display_name ?? p.resources, JSON.stringify(props));
        if (APPLY) { await c.request({ method: 'PUT', path: `/objects/${obj}/records/${r.id}`, body: { properties: props } }); await new Promise((s) => setTimeout(s, 300)); }
      }
    }
  }
  console.log(`${APPLY ? 'fixed' : 'would fix'} ${fixes}`);
})().catch((e) => { console.error(e?.message ?? e, JSON.stringify(e?.body ?? '')); process.exit(1); });
