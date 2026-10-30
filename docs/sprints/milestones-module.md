# Spec — Milestones module (live client document, PDF report, bulk create)

> **Written 2026-10-29.** Grew out of the first hand-built milestone report (Tackboard, 2026-10-26,
> sent to Joe LaRussa). Zach's framing: *"At any point I want to be able to click a button and get a PDF
> report out for a client"* and *"I like the idea of a live document. If we could make that work, that
> would be actually really sweet."* Companion spec: `milestone-suggester.md` (the object, its fields, the
> AI proposer). This spec is the HUMAN side: a Milestones tab in the app.

## 0. Decisions already made (Zach, 10-26 and 10-29)

| # | Decision |
|---|---|
| D1 | **Milestones get their own top-level tab.** Not a sub-type of Activities. |
| D2 | **Priority order: live document first, PDF second, bulk-create form third.** Everything else is out of scope this round unless it falls out for free. |
| D3 | **Client visibility rule: hide `status = proposed` AND hide any `source` of `ai_intake` / `ai_session`.** Clients see Active and Completed milestones; Dropped is shown in a compact list behind a toggle (default OFF on the client view and PDF, ON for staff). A record with no `source` value counts as staff. If Joe adopts an AI proposal he flips Source to Staff; the suggester never writes Active, so this rule can never hide something a human did not approve. |
| D4 | **Report fields: drop Owner, Follower, Source, and Created-by names.** Keep: milestone, status, definition of done, category, readiness dimension, target date, completed date, evidence link, created date, last updated date. |
| D5 | Source of truth stays GHL (`custom_objects.milestones`). The app reads; it never caches milestones as truth. |
| D6 | **(10-29) Stage progression section is IN, with milestones lined up against the snapshots** (see §2b). |
| D7 | **(10-29) The EIR's name appears on the client document, and the bulk form sets the EIR as the GHL record owner** (see §5). |
| D8 | **(10-29) Overdue target dates render in gold on both staff and client views.** |
| D9 | **(10-29) Public link host: start on the app's Vercel domain; `milestones.leanrocketlab.org` is a free CNAME add later (custom domains cost nothing on any Vercel plan). Decide the plan question separately (§7).** |

## 1. What the tab contains

```
/milestones                      Companies table (companies with ≥1 visible-or-not milestone)
/milestones/[companyId]          Company view = the live document, staff mode, with action buttons
/milestones/new?companyId=...    Bulk-create form (≤5 rows)
/m/[token]                       PUBLIC live document, client mode (no login)
/api/milestones/*                see §5
```

Phase order follows D2: **Phase 1** data layer + company view (staff) · **Phase 2** public link ·
**Phase 3** PDF · **Phase 4** bulk create · **Phase 5 (optional)** status history webhook.

## 2. The live document (Phases 1 and 2)

One React component, `<MilestoneReport mode="staff"|"client" />`, used by the staff page, the public
page, and the PDF renderer. Content, top to bottom, mirroring the Tackboard PDF:

1. **Header** — dark LRL band (#171717), horizontal white logo, kicker "ManuTech Incubator · Client
   Milestones" (program comes from `business.website_programs` when exactly one is set, else blank),
   company name, "as of <today>". No "prepared for" line in client mode.
2. **Snapshot** — company description, city/state, website, selling stage, EIR name(s) = owner(s) of the
   visible milestones ("Expert in Residence: Joe LaRussa"), counts (Active / Completed),
   and the latest TRL / MRL / CRL / MSRL from the newest `custom_objects.business_stage` record (fall
   back to `business.trl_current` etc. if there is no stage record).
3. **Summary table** — visible milestones: #, milestone, status, category, target, days out (negative =
   overdue, styled gold).
4. **Active** — detail cards (definition of done as the gold-ruled block, then the key/value grid).
5. **Completed** — same cards plus Completed Date and Evidence Link; sorted by completed date desc.
6. **Dropped** — one line each (name, category, last updated), behind the toggle per D3.
7. **Progression** — see §2b. Omitted only when there is no stage snapshot at all.
8. **Footer** — LRL address, "Live document, updates automatically" (client) or "Source: GHL milestone
   records" (staff).

Staff mode adds: a status pill filter (All / Active / Completed / Dropped / Proposed / AI-proposed) so
staff can see hidden items with a visible "hidden from client" badge; buttons **Copy client link**,
**Revoke link**, **Download PDF**, **Add milestones**.

### 2b. Stage progression and milestone lining (D6)

Inputs: all `custom_objects.business_stage` records for the company (sorted by `rescore_date`), and the
visible milestones. Build one merged, date-sorted event list:

| Event | Date used | Shown as |
|---|---|---|
| Stage snapshot | `rescore_date` | row with TRL · MRL · CRL · MSRL, plus a delta chip per score vs the previous snapshot (▲1, ▼1, none) |
| Milestone committed | record `createdAt` (until the Phase 5 status log exists, then the proposed→active date) | gold dot, "Committed: <milestone>" |
| Milestone completed | `completed_date` (fallback: `updatedAt` when status is completed and no date set, flagged "date approx.") | teal dot, "Completed: <milestone>" |
| Milestone dropped | `updatedAt` (staff view only, Dropped toggle) | grey dot |

Render: client/staff page = vertical timeline, newest at the bottom, with a sticky score strip showing
first snapshot → latest snapshot and the net change per score. PDF = the same as a compact table (one
row per event, four score columns, blank for milestone rows). "Since becoming a client" = the first
snapshot's date; add `business.client_since` later if a truer date is wanted (not this round).

The lining is deliberately descriptive, not causal: a completed milestone sits between two snapshots and
the reader sees what the scores did. The learning question ("which categories precede gains") is a
portfolio query over this same event list and is out of scope here, but the event builder lives in
`lib/milestones/timeline.ts` as a pure, unit-tested function so that query is a one-file addition later.

### 2a. Public link security

- Table `milestone_share_links (id, company_id, token, created_by, created_at, revoked_at,
  last_viewed_at, view_count)`. Token = 32 random bytes, base64url. One active link per company;
  "Revoke" sets `revoked_at` and the next "Copy link" mints a new one.
- `middleware.ts`: add `/m/` and `/api/public/milestones/` to `PUBLIC_PREFIXES`. Nothing else opens up.
- The public page is rendered server-side from the token only; it never accepts a companyId. Unknown or
  revoked token → generic 404. Add a 60 req/min per-IP limiter on the public route.
- What the client page shows is limited to §2 items 1–8 in client mode. No staff names, no record ids,
  no rationale text from the scorer (that field is internal).
- `robots: noindex`. Open question (§7): host on the app domain or a `milestones.leanrocketlab.org` CNAME.

## 3. Data layer (Phase 1)

`lib/milestones/`:

- `load.ts` — `loadCompanyMilestones(companyId)`: `getRelatedRecordIds(company_milestone)` → GET each
  record (ids are few; a direct GET is instant and avoids the ~12s search-index lag). Returns typed
  records with option KEYS resolved to labels via the field catalog.
- `visibility.ts` — pure function `isClientVisible(m)` implementing D3. Unit-tested.
- `portfolio.ts` — `sweepMilestones()`: one `search-object-records` over the whole object with
  `pageLimit: 500` (the object is small; 3x faster than 100), grouped by the `business` relation → feeds
  the Companies table. Cached 5 min server-side.
- `stage.ts` — `loadStageHistory(companyId)` from `custom_objects.business_stage` via the
  `company_business_stage` association (reuse `lib/stage`).

Association ids: `company_milestone = 6abbe67770afb881290a9f62` (business first). Always go through
`resolveAssociationDef` anyway.

## 4. PDF (Phase 3)

- `GET /api/milestones/report?companyId=…&dropped=0|1` (staff auth) → renders
  `/milestones/print/[companyId]?…` with `puppeteer-core` + `@sparticuz/chromium`, Letter,
  `printBackground: true`, CSS `@page` margins as in the Tackboard build (first page margin-top 0 so the
  dark band bleeds). File name `<Company>_Milestones_<YYYY-MM-DD>.pdf`.
- Fonts: Liberation Sans is metric-compatible with Arial and keeps the file ~50 KB; bundle the two TTFs
  under `public/fonts/` (the app already has a fonts dir) and reference them with `@font-face`.
- Fidelity check in CI: render Tackboard, rasterize page 1, assert the logo's rendered aspect ratio is
  within 1% of 4.904 (the brand kit's one hard rule).
- Optional (only if trivial): store each generated PDF in Vercel Blob and list past versions on the
  company view. Not required for Phase 3 acceptance.

## 5. Bulk create (Phase 4)

**UI** `/milestones/new`: `CompanySearch` (reuse) → up to 5 rows. Per row: Milestone (text, required),
Definition of Done (textarea, placeholder "verb + deliverable"), Category (12 options), Readiness
Dimension (5 options), Target Date, Status (Active default, Proposed toggle). Not editable: Source
(always `staff`), Completed Date, Evidence Link. **One EIR picker per batch (D7):** a dropdown of GHL
users flagged as EIRs in `config/eirs.ts` (name → GHL user id; Joe LaRussa = `3ZAtCnxQNT0gktvOsUZr`),
pre-selected from the owner of the company's most recent milestone, otherwise blank and required. "Add another" disabled at 5. Submit shows per-row results.

**API** `POST /api/milestones/create`
```ts
{ batchId: string /* client uuid, idempotency */, companyId: string,
  items: Array<{ milestone; definitionOfDone?; category; readinessDimension; targetDate?; status: 'active'|'proposed' }> }  // 1..5
→ { results: Array<{ index; ok; recordId?; error? }> }
```
Per item, in order: (1) create record with `properties` {milestone, definition_of_done, milestone_category,
readiness_dimension, target_date, status, source: 'staff'}; (2) `createRelation(company_milestone,
first=companyId, second=recordId)`; (3) `PUT` the record with `owners: { add: [eirUserId] }` (modifier shape — a plain array 422s,
verified 10-26); the submitting staff member is added as a follower the same way. Continue past a failed
item; report all. `batchId` claimed in a small `milestone_create_claims` table so a double-submit is a
no-op. Warn (not block) in the UI when the company would exceed 3 Active.

Show the created rows from the create responses, not from a re-search (index lag).

## 6. Status history (Phase 5, optional, but the data is unrecoverable if skipped)

GHL keeps only the current status. To answer "which milestones precede readiness gains":
- App-side status changes (future Complete / Drop buttons) write an Activity `Milestone Status Changed`.
- GHL-side edits: a **record-updated webhook on Milestones** → `/api/milestones/webhook` (self-enforcing
  secret, same pattern as `/api/form-sync`), diffed against the last seen status in
  `milestone_status_log (record_id, status, changed_at, source)`. Body for Zach to paste:
  `{ "recordId": "{{custom_objects.milestones.id}}", "status": "{{custom_objects.milestones.status}}" }`
  (object-key merge-field path; insert via the Custom values picker).

## 7. Resolved 10-29, and the one thing still open

1. Link host → app domain first, CNAME later (D9). Custom domains are free on every Vercel plan. The
   real question is the PLAN: the project sits on the personal team `zach884s-projects` (Hobby, by its
   naming) and Hobby is licensed for personal, non-commercial use. An org-facing client document is the
   point where moving the project to a Pro team (one seat) is the honest move; it also lifts the
   function-duration ceiling that the PDF renderer will want. **Zach to decide; not a blocker for Phase 1.**
2. EIR name on the document → yes (D7). 3. Overdue → gold (D8).

## 8. Acceptance

- Tackboard's company view, client mode, shows exactly the 3 Active milestones; flipping one to
  Proposed or Source = AI hides it within one reload. Dropped toggle works.
- Public link renders with no cookie; revoked token 404s; no `/api/*` other than the two public prefixes
  answers unauthenticated (re-run the 09-08 route sweep).
- PDF of Tackboard matches the 10-26 hand-built file in layout, ≤ 100 KB, logo ratio within 1%.
- Bulk form creates 3 milestones for a sandbox company in one submit, all associated, re-submit of the
  same `batchId` creates nothing.
