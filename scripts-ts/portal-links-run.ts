// scripts-ts/portal-links-run.ts — link every Client Stage and Milestone record to its company's
// contacts, so the record shows in the LRL client hub (the portal resolves visibility through
// contact links, even on company-scoped pages). Only ADDS links. See lib/portal/contactLinks.ts.
//
//   npx vite-node scripts-ts/portal-links-run.ts                 # DRY-RUN: report missing links
//   npx vite-node scripts-ts/portal-links-run.ts --apply --yes   # create them
//
// Runs nightly in .github/workflows/nightly-reconcile.yml. Writes reports/portal_links_<mode>.json.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
for (const l of (() => { try { return readFileSync(join(process.cwd(), '.env.local'), 'utf8'); } catch { return ''; } })().split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

(async () => {
  const apply = process.argv.includes('--apply');
  if (apply && !process.argv.includes('--yes')) {
    console.error('Refusing to APPLY without --yes. This writes association links in GHL.');
    process.exit(1);
  }
  const { sweepPortalContactLinks } = await import('../lib/portal/contactLinks');
  const res = await sweepPortalContactLinks({ apply, log: (s) => console.log(s) });
  const links = res.rows.reduce((n, r) => n + r.contactIds.length, 0);
  const errors = res.rows.filter((r) => r.error);
  const noCompany = res.rows.filter((r) => r.companyId === null && !r.error);
  mkdirSync(join(process.cwd(), 'reports'), { recursive: true });
  writeFileSync(join(process.cwd(), 'reports', `portal_links_${apply ? 'apply' : 'dryrun'}.json`), JSON.stringify(res, null, 1));
  console.log(`${apply ? 'APPLIED' : 'DRY-RUN'}: ${res.records} records, ${links} contact links ${apply ? 'created' : 'missing'}, ` +
    `${noCompany.length} records with no company, ${res.noContacts.length} companies with no contacts, ${errors.length} errors`);
  for (const e of errors.slice(0, 20)) console.log('ERROR', e.objectKey, e.recordId, e.error);
  process.exit(errors.length ? 1 : 0);
})();
