# Sprint: Wix blog + podcast -> GHL Blogs (started 2026-10-21)

Goal: the GHL website (AI Studio, Git-synced repo) shows LRL's blog and the Startup Storytelling Podcast from
GHL Blogs instead of Wix. Two GHL blogs in the LRL location: **LRL Blog** and **Startup Storytelling Podcast**.

## Scope (decided by Zach 2026-10-21)
- All 47 non-podcast Wix posts move, including the short 2019-2023 press stubs.
- Podcast = the full YouTube feed (channel UCGFRlBoXi6MdAscjSPX1vuQ): episodes 1-9. Eps 1-6 use the Wix
  show notes; eps 7-9 (no Wix post) use the YouTube description, cleaned (no em dashes), with new titles.
  2OpuDTmsj7Q is a re-upload of ep 3 and is skipped.
- Posts go up PUBLISHED with their original first-published dates and original slugs.
- 13 posts with no cover get a generated LRL title card (#171717, gold bar, teal category, white logo).
- 4 uncategorized readiness posts (TRL/MRL/CRL/Four Scales) get a new category, "Readiness Scales".

## Pipeline (all re-runnable)
1. `tsx scripts-ts/blog-export-wix.ts` -> reports/blog-migration/wix-export.json (read-only).
2. `python3 scripts/blog-migrate-build.py` -> plan.json + covers/. Ricos -> HTML (p, h2-h4, ul/ol, strong/em,
   links, figure/img, YouTube iframes). Underline is dropped (reads as a link).
3. `tsx scripts-ts/blog-migrate-ghl.ts` dry run -> `--apply --only=<slug>` -> `--apply` -> `--verify`.
   Images are re-hosted into GHL Media ("Blog Migration" folder) so nothing depends on Wix hosting.
   ledger.json makes it idempotent; the slug-exists check is the second guard.

## Constraints found
- The GHL public API has NO create endpoint for blogs, authors or categories. Those are made in the UI.
- Categories list caps at limit=50.
- On the Linux VM, node_modules holds darwin esbuild; run tsx from a separately installed copy (~/tools).

## Open
- 45 em dashes remain in migrated archive copy (left verbatim; Zach to decide).
- Internal links to leanrocketlab.org/post/<slug> stay as-is; redirect-map.csv covers them at cutover.

## Result (2026-10-21)
56/56 live and verified. Blogs have no author/categories (UI did not expose them); category labels are TAGS.
The list endpoint omits tags/body: widgets must read `/blogs/posts/{id}` for those.
Update (same day): author + 8 categories applied to all 56 (verify: 0 problems). Staging canonicals point at
Wix; at cutover run `CANONICAL=new tsx scripts-ts/blog-migrate-update.ts --apply`. Category label
"Industry 4.0 Accelerator," has a stray trailing comma in GHL (matched by the scripts; fix the label in the UI).
