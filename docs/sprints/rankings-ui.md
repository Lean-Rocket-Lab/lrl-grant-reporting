# Sprint brief: Rankings — drag-and-drop page ranking for Profiles

**Status:** BUILT + verified live 2026-10-23 (`c892ae5`; see PROJECT_STATE.md). Brief written 2026-10-23. Build in this repo (lrl-grant-reporting, Next.js pages router).
**Goal:** Zach reorders who appears first on each website page by dragging, and the app writes the
`rank_*` fields on GHL Profiles. The live site (leanrocketlab.org, GHL) already sorts by these fields.

## Placements (one NUMERICAL field per page on `custom_objects.profiles`)
| Placement (UI label) | Field | Who is listed |
|---|---|---|
| Team page | `rank_our_team` | people with `roles` ∋ `team` |
| EIRs page | `rank_eir` | people with `roles` ∋ `eir` |
| Board page | `rank_board` | people with `roles` ∋ `board` |
| Resources page | `rank_resources` | every resource profile (`profile_type = resource`) |
| LOCAL | `rank_local` | `programs` ∋ `local` |
| Sales & Marketing Accelerator | `rank_sama` | `programs` ∋ `sales_and_marketing_accelerator` |
| ManuTech Incubator | `rank_manutech` | `programs` ∋ `manutech_incubator` |
| i4.0 Accelerator | `rank_i40` | `programs` ∋ `industry_40_accelerator` |
| Lean Startup | `rank_lean_startup` | `collectives` ∋ `lean_startup` |
| Mainstreet | `rank_mainstreet` | `collectives` ∋ `mainstreet` |
| Manufacturing Tech | `rank_manufacturing` | `collectives` ∋ `manufacturing` |

- The four directory pages (Team, EIRs, Board, Resources) have ONE list each. Someone on Team AND
  Board (Brandon Marken, Ken Seneff) appears on both lists and is ranked separately on each.
- Every program and collective placement has two lists, **People** (`profile_type = person`) and **Resources**
  (`profile_type = resource`). They rank independently: the site shows them in separate tabs, so both
  lists are numbered 1..n in the same field.
- Show only `profile_status = published` by default; a toggle to include approved/pending is a nice-to-have.
- `rank_resources`, `rank_eir`, `rank_board` were CREATED 2026-10-23 (all blank). The website's
  Resources, EIRs and Board pages must be updated to sort by them (Zach is handling the site side).
- Put the placement table in ONE module (`lib/rankings/placements.ts`) so adding a page = one row + one field.
- Membership values are option KEYS (multi-selects come back as arrays of keys from the object search).

## UI (`pages/rankings.tsx`, add to `lib/nav/modules.ts` with icon `fa-arrow-down-1-9`)
- Use `Shell` (it switches to the embedded shell inside GHL iframes) and the existing CSS variables
  (`--brand`, `--ink-900`, `--surface`, `--border`, …). No new UI library is needed: native HTML5
  drag-and-drop is fine, and add **up/down buttons** on each row (keyboard + touch fallback).
- Layout per placement + type: **Ranked** column (ordered, draggable) and **Unranked** column
  (alphabetical; drag or click "Add" to append to Ranked; a "Remove" on ranked rows sends them back).
- Row: headshot/logo thumbnail (`headshot` or `company_logo` FILE_UPLOAD → first `url`), name, job title
  or category, current rank number.
- A **Save** button with a dirty-state indicator and a summary after save ("4 updated, 1 cleared").
  Warn on navigation away with unsaved changes.

## API
- `GET /api/rankings` → all profiles needed for the page in ONE search:
  `POST /objects/custom_objects.profiles/records/search` with `pageLimit: 500` (≈141 records today).
  Return only display fields + `profile_type`, `profile_status`, `roles`, `programs`, `collectives` and
  every `rank_*`. Do NOT cache across saves (or bust the cache on POST).
- `POST /api/rankings` body `{ field, type, orderedIds }` (validate `field` against the placement table):
  1. Compute the plan in a **pure, unit-tested function**: ranked ids get 1..n; profiles in that
     placement+type that currently hold a rank but are no longer in `orderedIds` get cleared. Only
     records whose value actually changes are written (`noop` must be reachable).
  2. Set values with `writeRecordFields` (`lib/ghl/writeRecord.ts`). To CLEAR a number, PUT
     `{ properties: { <field>: null } }` on `/objects/custom_objects.profiles/records/{id}`. **Measured
     2026-10-23: `null` clears it; an empty string `''` hangs the request — never send `''`.**
  3. Read each written record back with a direct GET (`/objects/custom_objects.profiles/records/{id}`)
     and report anything that didn't stick as `skipped`. **Do not re-read via search: the object search
     index lags writes by ~12 s** (see CLAUDE.md), so a search right after save shows stale ranks.
  4. Respect rate limits: ≥0.3 s between GHL calls (`GHL_MAX_RPS=3`).
  5. Return `{ updated, cleared, unchanged, skipped }`; the UI updates its state from this response.
- Both routes sit behind the default-deny middleware (staff cookie). Do NOT add them to
  `SELF_ENFORCING` in `middleware.ts`.

## Tests / done
- Vitest for the plan function: reorder, add from unranked, remove (clear), no-op (zero writes),
  people and resources in the same field don't disturb each other.
- `npx tsc --noEmit -p .` must be clean for the WHOLE project (Vercel's `next build` type-checks
  `scripts-ts/` too; a type error anywhere fails the deploy).
- Verify live: reorder one placement, save, then GET the records directly and confirm the ranks.
- Update `docs/PROJECT_STATE.md` when done.

## Data facts (as of 2026-10-23)
- 141 profiles: 47 people, 94 resources. Ranks were synced from the Wix CMS on 10-23; `rank_our_team`
  set for the 6 Team members (Brandon Marken 1, Ken Seneff 2, Alex Masten 3, Zach Kraabel 4,
  Lauren Lyons 5, Aiden Brunin 6). EIR ranks are mostly blank (Zach will set them with this tool).
- Lower number = shown first; blank = after all ranked items, alphabetical.
- Programs also include `exit_readiness_accelerator`, which has no rank field or page yet.
