# PROJECT STATE — LRL Operations Platform

> **This is the single source of truth for "where things stand right now."**
> Start every planning chat here. Refreshed daily by the maintenance routine.
> Companion docs: `PROJECT_ROADMAP.md` (the phase/sprint plan) · `CANONICAL_REPORTING_MODEL.md` (data spec).
>
> **Last refreshed:** 2026-09-09 (Wednesday).
>
> **✅ THE STALL BROKE — four commits landed 9/08, and the tree is CLEAN.** No commits 9/05–9/07; then
> 9/08 12:41→17:14 delivered `9d50580`, `e7824ce`, `4083d10`, `5eeae04`. **`0 ahead / 0 behind` at
> `5eeae04`, working tree clean** — the first fully clean tree in five runs, which also retires the
> `stage-dupe-audit.ts` flag and unblocks the `reports/` backlog (archived today, see the doc map).
>
> **🐞 What 9/08 actually was: a live data-integrity incident, correctly jumping the queue.** GHL's own
> **backup dedupe matched a client-intake submission to an existing contact BY PHONE**, overwrote that
> contact's email, and wrote the form's business details **straight onto the associated company** — so
> the **Lean Rocket Lab company record itself** became "Aidens Consulting Company, 704 Maple St, Stryker
> OH" at 19:13:55, four seconds *before* the contact updated. **Company first, contact second.**
>
> ⚠️ **The lesson is the one worth carrying: none of it was ours, and our guards could not have helped.**
> The change log holds **no entry at 19:13** — GHL wrote the business directly, so `identityGuard`,
> the convergence guard and the change log were all bypassed. That also explains all three symptoms at
> once (no stage record, no geo recompute, no spread to the 8 other LRL staff contacts): our handler
> never ran. **Our integrity layer only protects writes that go through us.** Damage was one record,
> restored from recovered values (change log 8/11 + the enricher's `geocodedAddress`, the address that
> actually produced the HUBZone/OZ flags on it) rather than invented ones.
>
> **Two durable fixes came out of it, both eligibility-grade:**
> - `business.county` / `contact.county_mi__full` held **84 options, every one a Michigan county**, so an
>   Ohio business could not be represented truthfully — it read "Jackson County (MI)", an **SBSH
>   eligibility dimension**, and would have qualified for a grant it cannot receive while looking
>   entirely ordinary. Both lists now carry **"Out of State"**, 85 options, all 83 counties intact,
>   verified by an **uncached** GET (`getFieldCatalog` is cached and reported a successful write as "did
>   not persist" — a false negative on a live picklist).
> - 🔴 **Our write layer cannot CLEAR a single-select.** `/businesses/{id}` refuses custom fields
>   outright; the objects path drops an empty value before it reaches GHL (`written: [] skipped: []` —
>   it never even attempted). The company-side stale county needed a **manual clear in the GHL UI**.
>
> **✅ The GHL "Contact Changed" workflow is UN-PAUSED and the whole pipeline ran end to end** —
> contact→company fired for the first time since the 8/27 incident, the enrichers computed Ohio geo, and
> the scorer wrote a first stage record. A carried Zach-side blocker is retired **by evidence**.
>
> **✅ Also 9/08: the stage-scoring RACE is closed.** Both call sites did check-then-act across the
> ~12-second GHL search lag, so a burst of webhook deliveries each read `null` and created — proven by
> creation timestamps ~2s apart (CP Design three inside 1.9s; EvaGenomics 147ms). Fixed by claiming
> `(company, day)` in Postgres under the UNIQUE the activities ledger already has —
> `onConflictDoNothing` **is** the mutual exclusion. 9 duplicates cleaned, **106 → 97**, multi-day
> history untouched. **633 tests pass.** The `?echo=1` auth-order hole flagged as UNCOMMITTED yesterday
> is now committed and pinned (`webhook-auth-order.test.ts`, 21/21).
>
> **🔴 `capture-coverage.ts` is now NINE sessions unbuilt (9/01–9/09).** Yesterday's run wrote the exact
> spec into the ⭐ section on the theory that ⭐ fix 1 moved the hour it became an instruction. **That
> theory has now been tested and it did not hold** — the spec was there all day, real work happened, and
> the file still does not exist. What displaced it was legitimate (a live record being silently
> corrupted beats an instrument), so this is not a discipline finding. It is a **structural** one: an
> instrument that only gets built on a quiet day never gets built, because quiet days are when nothing
> forces the calendar.
>
> **✅ THE `CLIENT_LINK_SECRET` BLOCKER IS DEAD — THE FEATURE IT BLOCKED WAS SCRAPPED ON 9/08.** This
> doc carried it for five days and was one edit away from carrying it a sixth. **Zach deleted the
> app-hosted client page** (`/client-reporting/profile`, `/api/client-profile`, `lib/clientProfile/`,
> `lib/security/clientToken.ts`, `mint-rescore-links.ts` → gitignored `_to_delete/scrapped-client-page/`)
> in favour of a **GHL-hosted scoring form**, on the reasoning that *GoHighLevel is already
> internet-facing and is the vendor's problem, while this app holds every credential LRL owns.*
> `grep CLIENT_LINK_SECRET` over `lib/ pages/ scripts-ts/ middleware.ts` returns **nothing**, and
> `PUBLIC_PREFIXES` is now **`['/staff-login', '/api/staff/login']`** — **the app has ZERO public
> routes.** There is no env var to set, no 503 to clear, and no 130 links to mint.
> ⚠️ **Same failure mode as the security 401**: a blocker was restated daily while the thing it
> described had already changed. The check that caught it was reading the memory file, which was more
> current than this document.
>
> **Sprint D (capture completeness, then label correctness) is the ACTIVE sprint** —
> `lrl-grant-reporting/docs/sprints/sprint-d-capture-completeness.md`. Sprint C is **shelved, not
> cancelled**; its grant definitions and TC column bindings stay authoritative about which fields must
> be trustworthy.
>
> *Condensed 2026-08-25, 2026-09-05; pre-condense copies at `_archive/2026-08-25/`, `_archive/2026-09-05/`.*
> ⚠️ **This document is 1,169 lines / 103 KB and is drifting back into being a log.** It has been
> condensed twice and has regrown both times. Flagged for a third condense — see the doc map.

---

## North Star
LRL's team logs each client interaction **once** in GHL. The system enriches it, routes it to every grant it
qualifies for, and **generates each funder's report/portal numbers on demand** — killing manual data entry,
research, and end-of-period aggregation.

## Where we are (one paragraph)
The **data foundation is built and running on live**: a typed GHL data-access layer, the config-as-data mapping
engine, an idempotent down-sync proven over all ~897 companies, enrichers (county + geo-disadvantaged) with
provenance, app-owned LARA-ID dedup, and a full observability layer (`change_log` + Change Logs UI + sync
doctor + convergence guard, shipped 8/04). The GHL⇄Wix ecosystem — Team/Resources upsert sync, Readiness Map,
Resources/TAP, Milestone Maps, configurable gating — is **done and converged** (Resources 91/91 noop, Team
41/41 noop), and its write-path and webhook-delivery defects were found and fixed 8/17–8/18. **Sprint A is
closed** (nightly stage scorer live since 8/04; its "no-route" rate proved to be a data-collection reality, not
a defect). **Sprint B — activity tracking — ran almost end to end on 8/19–8/20:** rescoped from a staff-entry
form to source-driven ingestion, phases 1–5 + 7 shipped and verified live, and the Activities object backfilled
from 2 records to **234**. Only phase 6 (Wix attendance) remains, and it is now a **Sprint C dependency**.
Sprint C's design is settled across **both halves** (eligibility lens + column mapping set), and its two
readiness gates are done: gate (3), the funder-template field trace (~150 columns bound), and gate (4), the
first real population census over 897 companies. On 8/24 the **four grant definitions were drafted precisely**.
**On 8/27 the six-day stall broke:** four commits landed and the tree is clean and pushed — `ca947f0` saved
the whole Sprint C spec pile (funder-field-trace, grant-definitions, the report-engine-design output half,
both census scripts), `0475c18` + `4d4a1bc` shipped the incident's identity guard and oscillation/rate guard,
and `c03b9a5` closed **⭐ fix 2** (TA `modality` + `service_topic` now 15/15) while making ingestion dry-runs
report a real diff. **8/31–9/02 were the most productive stretch since Sprint B:** the whole **sheet
importer** was built, run against live and then corrected twice on Zach's own review (`2d761ef`→`41448d0`),
and it exposed two real engine defects on the way. **9/02 closed the long-carried ⭐ fix 1** — webhook #3 is
wired and the first metrics snapshot in the system's history exists (0 → 1), so the daily snapshot loss has
stopped. **On 9/03 Zach shelved Sprint C and opened Sprint D** on the correct reasoning that a
row-per-qualifying-activity workbook is silently incomplete while two of its seven feeding types have
essentially no records. **That same afternoon both halves of Sprint D moved hard:** the Gateway backfill was
applied to live (**metrics 0 → 188**, seven real periods, zero duplicate company+period pairs) and **⭐ fix 3
was built and applied** (`award_amount` 64/64, `grant_reason` re-derived from the approved line items) —
which in turn exposed and repaired a live reporting bug that had **52 of 64 grants dated the day the backfill
ran** rather than the day they closed. **9/04 finished the grant brief** (all five headline fields populated,
`grant-reason` turned into a gated enricher, three silently-dropped field aliases closed), **pushed everything**
(level with origin), and then **opened a new surface in the evening**: the Client Reporting rescore funnel and
the default-deny authentication it forced, after a probe from outside the network found **42 of 49 API routes
open**, `/api/mapping/apply` among them. **9/05 through 9/07 added nothing**, and the 9/08
maintenance run measured the carried security 🔴 and found it had been closed since the 9/04 deploy —
three anonymous probes that returned 200 now return **401 from `middleware.ts` itself**, `?user_role=admin`
escalation included. **Then 9/08 itself broke the stall, and not with sprint work:** GHL's *own* backup
dedupe matched a client intake to an existing contact **by phone** and wrote the form's business details
straight onto the associated company, renaming **Lean Rocket Lab's own company record** to an Ohio
consultancy — with **no change-log entry at all**, because GHL wrote the business directly and our
handler never ran. That single incident produced four commits and three durable results: the record was
restored from recovered rather than invented values, both county picklists gained an **"Out of State"**
option (county is an SBSH eligibility dimension, so a stale Michigan value on an Ohio business is a false
positive that looks ordinary), and the **stage-scoring race** was closed by claiming `(company, day)` in
Postgres under the existing UNIQUE — 9 duplicate stage records cleaned, 106 → 97, 633 tests passing. The
GHL **"Contact Changed" workflow is un-paused** and the full pipeline was observed running end to end for
the first time since 8/27. What remains inside Sprint D is unchanged and still unopposed on the merits:
**the instrument** — `capture-coverage.ts` does not exist after **nine** sessions as the ⭐, so Sprint D is
still judged by a census that predates the sheet import *and* the Gateway apply — plus the two red capture
cells (`workshop_event` **0**, `introduction_referral` **1**), neither of which is an engineering problem.
The client-rescore thread **pivoted on 9/08**: the app-hosted page built on 9/04 was deleted in favour of
a **GHL-hosted scoring form**, on the reasoning that GHL is already internet-facing while this app holds
every credential LRL owns — so the app now has **zero public routes**, the `CLIENT_LINK_SECRET` blocker
this doc carried for five days is **void**, and what replaces it is a real gap: **0 of 24 scoring fields
have a contact↔company mapping row and 12 of those contact fields do not exist at all**, `business_model`
— the router behind the 38% unroutable rate — among them.

---

## Sprint dashboard

| Sprint / feature | Roadmap phase | Status |
|---|---|---|
| Foundation: data-access, mapping, sync, enrichment, dedup engines | Phase 0 | ✅ Built; proven on live |
| Company-centric data wiring (fields, intake backfill, name cleanup, county+geo) | Phase 2 | ✅ Live |
| Down-sync to production (idempotent over ~897 companies) | Phase 2 | ✅ Live |
| GHL⇄Wix: Upsert sync · Readiness Map · Resources/TAP · Milestone Maps · configurable gating | EOS rock (website) | ✅ Shipped Jul; **not drift** — a deliberate rock the roadmap never captured |
| Business Stage Tracking + scoring enricher (MRL/TRL/CRL/Churchill) | Phase 2 enrichment | ✅ **DONE — Sprint A.** Nightly since 8/04, legacy GHL-workflow scorer retired. The 857/895 "no-route" is expected (new intake question, 3.5% answered) |
| Sync & enricher observability / log-review layer | infra / data QA | ✅ **SHIPPED 8/04** — change_log + UI + Wix sink + sync doctor + convergence guard |
| Square → GHL monthly Cafe Fuel Net Sales opportunity | side feature | ✅ Shipped 8/04 (`08b97a9`); **its first scheduled run failed 9/01 and was fixed the same day** (`81685de`, merged `7a13083`). Verify now reads back via `GET /opportunities/{id}` instead of the lagging search index; adds a Square credential preflight and Node 22. Aug posted: **$15,989.14** (1,706 orders) |
| GHL⇄Wix write-path repair (modifier writes, convergence, associations, reference labels) | infra / integrity | ✅ **COMPLETE + DEPLOYED 8/18** (`6f62728`). All 7 items. Resources 91/91 noop · Team 41/41 noop |
| Webhook delivery reliability (fault-isolated writes + Fluid-Compute fast-ack) | infra / reliability | ✅ **SHIPPED 8/18** (`fc9a3f8`, `9dfbba8`). ⚠️ depends on Vercel Fluid Compute |
| Sync integrity: identity guard + oscillation/rate guard + ledger key-shape fix | infra / integrity | ✅ **BUILT + COMMITTED 8/27** (`0475c18`, `4d4a1bc`). Loop cause disabled in config (live); code pushed — **confirm the deploy carried it** |
| **Activity tracking — source-driven ingestion (7 types)** | **Phase 2, Sprint 3** | 🟢 **phases 1–5 + 7 DONE, backfilled (236 records). Phase 6 remains → now a Sprint C dependency.** ⚠️ grant headline fields still 0/63 (TA `modality`/`service_topic` fixed 8/27; **metrics 0 → 1 on 9/02**) |
| **Webhook #3 (Client Reporting) → metrics snapshots** | ⭐ fix 1 | ✅ **DONE 2026-09-02.** Wired by Zach, verified live: claim → create, `applied=true`, metrics **0 → 1**, 30+ fields, `reporting_period = 2026-08-31`. Working shape = `?formId=` in the URL; no bypass header |
| **Gateway metrics backfill — 7 funder workbooks → dated snapshots** | Sprint D / D1 capture | ✅ **BUILT + APPLIED TO LIVE 9/03 (`7897666` → `02f6de2`). metrics 0 → 188.** 187 created = the dry run's exact prediction, 7 real periods, 13/13 fields at 187/187 (bar 2 legitimately blank), **0 duplicate company+period pairs**, Apr-2023 re-run 15 noop. Bank loans 187/187 (was being silently dropped). ⚠️ **27 rows unresolved** — companies genuinely absent from GHL, each named rather than skipped. ⚠️ FTE absent from Gateway entirely — SBSH col N history unrecoverable |
| **Grant headline fields (⭐ fix 3)** | Sprint D / D2 labelling | ✅ **COMPLETE 9/04 (`3e3d858`→`dac0667`).** All five fields that were 0/64 on 9/03: `award_amount` **64/64** · `award_date` **58/64** · `grant_program` **53/64** · `expense_category_item_3` **53/64** · `grant_reason` **52/64**. `award_amount` is a **majority vote across three witnesses** (opportunity · contact · the amount reported to the funder) — they disagree on 6/64 and on **3 the opportunity is outvoted 2-to-1**, so taking `monetaryValue` on faith (as the brief specified) would have written a wrong figure into a funder field. 🙋 all six want review, Jarsa most (825 vs a reported 4,000). `award_date` takes the funder sheet's own grant date for 57, a stage timestamp for 1, and leaves **6 empty and declared** at Closed Won |
| **`grant-reason` as a GATED enricher** | Sprint D / D2 labelling | ✅ **9/04 (`3e3d858`).** Zach: *"set this up as a gated sync… a perfect way to make sure the configuration is good."* Registry entry, so `/enrichment/grant-reason` edits the gate without a deploy: `activity_type ∈ {grant} AND grant_status ∈ {Agreement Executed, Receipts Received, Closed Won}` — the status half is the amendment requirement **as config**. 62/64 pass · 52 written · re-run all-skip. A **line-item fingerprint** in the change-log rationale is what makes an amended agreement re-derive instead of keeping the first version. 🔴 **The gating paid for itself on its first run: it passed 0 of 64**, because `membershipMatches` compared raw strings while GHL stores option KEYS — so *every* gate written from the UI's labels matched nothing, silently. Third instance of the same label-vs-key bug; fixed in `gate.ts` for all gates |
| **The alias table — 3 silently dropped fields** | Sprint D / D2 labelling | ✅ **9/04 (`00b7240`).** `sources/form.ts` copies contact→activity by KEY match, so a pair differing by one character is dropped on **every** submission with nothing said. Three found in two days by asking where a funder column would land: `bank_loans…` (field did not exist — created 9/03), `direct_grant_program → grant_program` (+ value map **baf → Gateway**), `expense_category_item3 → expense_category_item_3` (a missing underscore). Proven on live: both aliases fired **50×** each. Aliases are reported on the result and printed by the runners **by design** |
| **Form copy runs from the OPPORTUNITY path** | Sprint D / D2 labelling | ✅ **9/04 (`dac0667`).** The last structural piece of the grant brief. `copyFormFields` is a route default on exactly two stages — **Agreement Executed** (line items first final) and **Closed Won** (last, which catches an amendment) — so which stages count stays config. 24 updated · 123 noop. 🔴 The review is the field histogram, and the proof is what is ABSENT from it: **`activity_date` is not written**, refused by `mergeFormValues()` and again by `onlyIfAbsent`, with 4 tests pinning behaviour rather than intent |
| **❌ `program_acceptance` did NOT need the date repair** | Sprint D / D1 integrity | ✅ **MEASURED + NOT APPLIED 9/04.** Claude had claimed it *"almost certainly carries the same frozen ingest date."* It does not: **0 of 84** carry the 8/20 backfill date and 72 already hold the close date. The 13 the repair would touch are SAMA acceptances with **real individual dates** (02-17, 02-19, 02-20) that it would collapse to a single **02-24**, the day the cohort was batch-moved. Applying would have destroyed 13 genuine dates to fix a problem that does not exist. The `--type program_acceptance` flag stays because the dry run is how we know the records are fine |
| **Nightly runners: green, and off deprecated Node 20** | infra / reliability | ✅ **9/04 (`bec074e`).** The Zoom brief's *"has never completed a green run"* was **stale** — nightly-activities has been green for 3 consecutive runs (#3–#5), and run #5's own output (`2 noop / 2 cancelled`, `147 noop / 176 no-route`) proves it does the work rather than exiting 0. Fixed by `7efdb67` (guard the `.env.local` read — CI has no such file); the same bare read was then found in **8 scripts added this week** and guarded. Six workflows moved to **node 22 + v5 actions**, matching the config `square-netsales` already proves. ⚠️ **9/05: the node-22 move has now had its first scheduled run and NOBODY HAS LOOKED** — the PAT lacks the `workflow` scope to dispatch, and a Claude session cannot read the Actions log. **One click: open the Actions tab and confirm run #6 is green.** If it is red, the cause is the runner bump, not the code. Also measured: GitHub defers every scheduled run here by **~4–4.5h**, so every "= 5:15am EDT" comment is fiction — relative ORDER survives, but a Zoom step on the nightly will not see a 9am meeting until the next day |
| **🐞 `activity_date` repair — 52 grants dated the backfill run, not the close** | Sprint D / D2, data integrity | ✅ **FOUND + FIXED 9/03 (`187cfd8`).** `onlyIfAbsent` shipped *after* the 8/20 grant backfill, so it froze 2026-08-20 onto 52 of 64 records. `activity_date` assigns the reporting period, so those grants counted in the wrong half-year while looking plausible. Re-sourced from `opportunity.lastStatusChangeAt` (**not** `lastStageChangeAt` — disagrees on 34/64): **64/64, 57 rewritten, re-run all noop**; only 5 actually crossed a period boundary |
| **🔐 App authentication — default deny** | infra / security | ✅ **VERIFIED LIVE 2026-09-08 — the 401 has been taken.** `/api/mapping/list`, `/api/companies/search`, and `/api/enrichers?user_role=admin` all return **401 `{"error":"unauthorized"}`** anonymously; the JSON body proves it is `middleware.ts` answering rather than Vercel SSO, and `?user_role=admin` no longer escalates. `/staff-login` renders 200 with `frame-ancestors` allowing `*.gohighlevel.com` / `*.leadconnectorhq.com` / `*.msgsndr.com`, so the GHL iframe path is intact. `ADMIN_SECRET` is set in Vercel. **The fix had been working since 9/04 — the three days of 🔴 were three days of nobody measuring**, which is the lesson worth keeping: an unverified fix and an open hole are indistinguishable from the outside, so the probe *is* the work. ⬜ Two acceptance items remain but neither is an exposure: one real webhook returning 200 through the allowlist, and one login sticking inside the iframe. Honest cost, unchanged: staff auth is a **shared password**, so change-log attribution stays as weak as today; the real answer is the GHL Marketplace SSO handshake, structured to replace `verifyStaffSession` alone |
| **🐞 INCIDENT 2026-09-08 — GHL's own dedupe overwrote the LRL company record** | Sprint D / data integrity | ✅ **DIAGNOSED + REPAIRED SAME DAY (`e7824ce`, `4083d10`, `5eeae04`).** A client-intake submission from a personal email was matched by **GHL's backup dedupe on PHONE** to an existing contact (a right match on a unique number); GHL then wrote the form's business details onto the **associated company** — LRL's own — at 19:13:55, **four seconds before** the contact updated. ⚠️ **The change log has no entry at 19:13**: GHL wrote the business directly, so `identityGuard`, the convergence guard and the change log were all bypassed. **Our integrity layer only protects writes that pass through us** — that is the durable lesson, and it is new. Consistent with all three symptoms (no stage record, no geo recompute, **no spread to the other 8 LRL staff contacts** — company→contacts never fired either), so damage was **one record**. Restored from *recovered* values: name/website from the change log's last legitimate write (8/11), address from the enricher's `geocodedAddress` — the address that actually produced the HUBZone/OZ flags sitting on it. The repair script **refuses to run** if the record is no longer named "Aidens Consulting Company", so a re-run cannot clobber a hand fix. Geo re-verified by measurement, not reading: Stryker OH → Williams County, both flags false; Jackson MI → both true. **Nothing ever scored Ohio as a HUBZone** — the flags were LRL's own, stranded on a renamed record |
| **"Out of State" county option — an SBSH eligibility false positive** | Sprint D / D2 labelling | ✅ **9/08 (`4083d10`, `5eeae04`).** `business.county` and `contact.county_mi__full` each held **84 options, all Michigan**, so the geocoder resolving Stryker OH → Williams County had **nowhere to land** and the record kept a stale `Jackson County (MI)` pushed from the contact. County is an **SBSH eligibility dimension** (Jackson/Lenawee/Hillsdale), so an Ohio consultancy reading "Jackson County (MI)" qualifies for a grant it cannot receive **and looks entirely ordinary**. Both lists now **85 options, all 83 counties intact**, verified by a direct **uncached** GET. `contact.county` deliberately untouched (separate 4-option "is this one of ours" list). 🔴 **Two write-shape traps recorded, because the errors point the wrong way:** the OBJECT endpoint takes `options: [{key,label}]`; the LOCATION endpoint calls it **`picklistOptions` and takes plain STRINGS** — sending `[{key,label}]` there answers `400 "v.trim is not a function"` (reads like bad values, is a bad shape), and sending `options` instead of `picklistOptions` is **accepted 200 and silently ignored**. 🔴 **And: the read-back went through the CACHED `getFieldCatalog`, so a successful write reported "did not persist"** — a false negative that invites a pointless retry on a live picklist. **Picklist verification must bypass the cache** |
| **🔴 Our write layer cannot CLEAR a single-select** | infra / write path | ⬜ **FOUND 9/08, NOT FIXED.** Clearing the stale county from the *company* side was impossible programmatically: `/businesses/{id}` refuses custom fields outright (`"Custom fields are not supported"`), and the objects path **drops an empty value before it reaches GHL** — `writeRecordFields` reported `written: [] skipped: []` and never attempted the write. Needed a **manual clear in the GHL UI**. This is a general gap, not an incident detail: any single-select holding a wrong value can only be *changed*, never *emptied*. The "Out of State" option is the workaround, not the fix |
| **Stage-scoring duplicate race** | Sprint A / integrity | ✅ **CLOSED 9/08 (`9d50580`).** Both call sites did check-then-act — read `getCompanyStageContext` for `todayRecordId`, create if null — and that id resolves through the GHL records **SEARCH, which lags a create by ~12s**, the same lag that made activity ingestion duplicate in August. The webhook path fires on every company/contact change, so a burst delivered several scoring events inside the window and **each read null and created**. Proven by creation timestamps, not inference: CP Design's three at 21:17:13.635 / :14.035 / :15.524, EvaGenomics' two **147ms** apart. Fixed by claiming `(company, day)` in Postgres under the UNIQUE the activities ledger already has — **`onConflictDoNothing` IS the mutual exclusion**, no new table; same degradation contract as `lib/activities/claims.ts` (no DB → reports unavailable and creates anyway, because a missed score beats a rare duplicate — **but it now says so**); a failed create releases the claim so the next delivery retries. Webhook path and nightly take the same claim; **11 tests pin it**. Cleanup: 8 pairs, newest kept per company+day, **106 → 97**, 0 remaining; multi-DAY history untouched (31 companies legitimately hold several). 📌 **A correction recorded rather than buried:** an earlier audit reported 2 records "associated twice" — it had **truncated ids to 8 chars** and two records created in the same second share a prefix. The cleanup prints ids in full. **Truncated ids in a destructive script are how the wrong row gets deleted** |
| **✅ GHL "Contact Changed" workflow UN-PAUSED** | infra / carried blocker | ✅ **RETIRED 9/08 BY EVIDENCE.** Carried since the 8/27 loop incident. With the webhook back on, the pipeline was observed running **end to end**: contact→company fired for the first time since 8/27, the contact synced to its own company, the enrichers computed geo, and the scorer wrote a first stage record. The loop's cause stays disabled in config and both guards are live |
| **Client rescore — PIVOTED to a GHL-hosted form** | Sprint D / right-object capture | 🔄 **SCRAPPED AND REPLACED 2026-09-08.** The app-hosted page built 9/04 is **deleted** — `/client-reporting/profile`, `/api/client-profile`, `lib/clientProfile/`, `lib/security/clientToken.ts` and `mint-rescore-links.ts` all moved to gitignored `_to_delete/scrapped-client-page/`. Zach's reasoning, and it is right: *the app should be Lean Rocket Lab-facing only* — **GHL is already internet-facing and is the vendor's problem; this app holds every credential LRL owns.** `PUBLIC_PREFIXES` is now `['/staff-login','/api/staff/login']` and **the app has zero public routes**. ⚠️ **So `CLIENT_LINK_SECRET` is a DEAD blocker** — it was carried here for five days after the feature it gated ceased to exist. Replacement: a **GHL-hosted Scoring Form** whose answers land on the contact, webhook `POST /api/sync/up` syncs them UP to the company, the scorer fires (already wired), scores propagate down, then a 10-minute wait + "`trl_current` not empty" condition sends the results email. **Almost no new code** — `/api/sync/up` already does the sync and already calls `runStageScoreTrigger`. 🔴 **The measurement that forced the pivot is the durable part: there is NO contact↔company sync for ANY scoring field — 0 of 24 have a mapping row**, and **12 of the 24 contact fields do not exist at all**, including `business_model`, the router. The 7 that do exist hold **stale orphan values** from the original intake that nothing keeps in sync. ⚠️ **`config/field-mappings.json` is a LEGACY SEED FILE — the live mappings are in Postgres** (`field_mappings` + `syncs`); a grep of the JSON gives the opposite answer and nearly sent the build the wrong way. **Sync directions, one owner each (the 8/27 rule applied deliberately): 19 inputs contact → business UP only; 5 `*_current` scores business → contact DOWN only. Nothing is two-way.** Spec: `docs/sprints/scoring-form-build-spec.md`; setup: `scripts-ts/scoring-form-setup.ts`. **Live numbers still current:** 136 client contacts · 130 linked · 6 not · **21 of 56 sampled companies unroutable (~38%)** — the same wound as the scorer's 857/895 no-route, and `business_model` is one radio question that fixes it. ⚠️ **Accepted sharp edge of UP-only sync:** sticky-contact prefill shows a client their last submitted answer, so if staff corrected that value on the company since, submitting overwrites the correction. Fine for a bonus path; do not let it become the main one |
| **`capture-coverage.ts` — Sprint D's instrument** | **Sprint D / D1** | 🔴 **STILL NOT BUILT — NINE sessions (9/01–9/09), and yesterday's intervention was tested and failed.** The 9/08 run stopped restating the bullet and wrote the **full spec** into the ⭐ section, on the evidence that ⭐ fix 1 sat six runs as a reminder and moved within an hour of becoming an exact instruction. The spec was in place all of 9/08, four commits landed, and **the file still does not exist** — so the "it just needs a precise spec" hypothesis is now disconfirmed. What displaced it was legitimate (a live record being silently corrupted outranks an instrument), which is exactly the problem: **an instrument that only gets built on a quiet day never gets built**, because a quiet day is precisely when nothing forces the calendar. ⬜ **The unanswered question is now four asks old and is the whole finding: does this get a scheduled block?** Until it exists, Sprint D is measured by `report-readiness-census.ts`, which **predates the sheet import AND the Gateway import** — so "236 activities" and "1 of 8 KPIs producible" are badly stale and should stop being quoted. Live today: **~901 activities · metrics 188 · grants 64 fully populated**. What is genuinely unknown is the thing the instrument would answer: **which activities that SHOULD exist do not** — `workshop_event` is still 0 (Wix, blocked on permissions) and `introduction_referral` is 62 with no idea what the denominator is |
| Funder-template field trace (gate 3) + population census (gate 4) | data QA / Sprint C gate | ✅ **DONE 8/21, COMMITTED 8/27** (`ca947f0`) — ~150 columns bound, 7 with no field, 5 blocking fixes found |
| The four grant definitions, precisely stated | Sprint C spec | ✅ **DRAFTED 8/24, COMMITTED 8/27** (`ca947f0`) — `docs/sprints/grant-definitions.md` |
| **Sprint D — capture completeness, then label correctness** | **Phase 2, the new active sprint** | 🔵 **DEFINED 2026-09-03** (`docs/sprints/sprint-d-capture-completeness.md`). D1 = every activity type has a live source ingesting real records; D2 = every captured activity carries the fields the grant definitions bind to. Instrument first (`capture-coverage.ts`), then the two red cells, then Zoom, then right-object capture |
| **Report-generation engine (regenerate real TC/SBSH reports)** | **Phase 1, Sprint 2** | ⏸️ **SHELVED 2026-09-03 — not cancelled.** Sprint C is fully specified (`docs/sprints/sprint-c-tc-report.md`) and restarts when the Sprint D §3 bar is met. Its grant definitions + TC column bindings stay current and stay authoritative about which fields must be trustworthy |
| **Sheet import — TC/SBSH workflow spreadsheets as a row source** | Sprint B/C bridge | ✅ **BUILT + RUN 8/31–9/02** (8 commits, `2d761ef`→`41448d0`). Pre-2026 slice imported; then corrected on Zach's review: 53 grant-contract notes relabelled, 11 TA→intake promotions, 0 creates, 247 noop. Exposed **two engine defects**: the dedup rule blocked the import correcting its own records, and `didPersist` could never accept a multi-select (57 referral records were being rewritten on every run, forever) |
| Auto meeting logging (Zoom AI Companion → appointment → Activity) | **pulled into Sprint D** | 🔵 **Join key proven; spec advanced 9/03 (UNCOMMITTED, +124 lines).** Every appointment carries its OWN distinct Zoom meeting id in `address` (110 distinct across 110); `zoom_meeting_id` is **15/15** on TA. Scope narrowed: **the GHL appointment list is the driver, not the Zoom meeting list** — meetings with no appointment are out of scope. Decided: write notes + Attended/No-showed to the appointment FIRST, then ingest. 🔴 **BLOCKED on a Zoom role permission** — "Server-to-Server OAuth" is greyed out for Zach; the Zoom **account owner** must enable `User Management → Roles → Role Settings → Advanced features → "Zoom for developers"` (View + Edit). If the owner won't, §3's per-user OAuth fallback is the fork — and is arguably the better answer to "anyone on the team" anyway |
| Outcome-survey capture + internal dashboards | Phase 3, Sprint 6 | ⬜ Not started |

---

## 🟢 INCIDENT 2026-08-27 — company-name sync loop (ROOT CAUSE FIXED AND DEPLOYED)

*(Condensed 2026-09-05 — the full narrative, the two-stage trace and the guard internals are in
`CLAUDE.md`'s hard-won rules, `_archive/2026-09-05/`, and `_briefs/2026-08-28.md`. Kept here: the
outcome and what is still open.)*

A contact import through the Claude connector caused **319 writes across 47 records in 7 minutes**, and
**GHL paused the "Contact Changed" workflow**. Root cause: company name was synced in **both directions
with no owner**, and a bulk import makes contacts on one company disagree *transiently* — so it would
fire on any bulk upload even with perfectly consistent data.

**Fixed in config (live):** the `contact.companyName → business.name` row is **disabled** — the company
owns its name. Dry-run of the worst-hit record: 0 changes / 7 unchanged.
**Fixed in code (`0475c18`, `4d4a1bc`, pushed):** `identityGuard` (domain beats name; measured 1,103
match / 1 rename / 1 block over 1,105 linked contacts, so blocking is safe), the windowed
oscillation + rate guard (replaying the real incident: 20 alternating webhooks → **2 writes, 18
suppressed and escalated**), and the ledger key-shape fix that had made the guard **inert for its
entire life** (410 of 638 rows held an empty value). Triage: `scripts-ts/identity-audit.ts --list`.

### 🔴 STILL OPEN from this incident
1. **Zach: un-pause the GHL "Contact Changed" workflow.** Safe — the loop's cause is disabled in the DB.
2. **Confirm the identity gate is DEPLOYED.** Code is committed and pushed (`0475c18`); the loop fix
   itself is already live in config. Verify the running deployment is at `c03b9a5` before trusting the gate.
3. ~~**Oscillation detection**~~ · 4. ~~**The ledger key-shape bug**~~ — ✅ both built, committed and
   verified live (summarised above; internals in `CLAUDE.md`).
4b. **Still open: the non-converging rule does not escalate to review** (only the new oscillation/rate
   rules do), and it has no window — once we have written value V and the field drifts away, V can never
   be re-proposed. Pre-existing behaviour that fixed the country loop; worth revisiting, not urgent.
5. **The fan-out has no bulk-safety** — it multiplies by the number of contacts on the company, worst
   precisely during an import. Debounce per company, or suppress when the trigger is a bulk change.
6. **Data check for Zach:** 5 contacts (Ken Foster, Kyle McGregor, Brad Fingland, Janet Wyllie, Paul
   Jaques) had `companyName` overwritten by the fan-out and all now read "Grand Rapids SmartZone".
   The COMPANY record never lost its name (it began and ended as "Grand Rapids SmartZone"); the
   exposure is contact-side. Were those five meant to read Grand Rapids SmartZone or "Burgess
   Institute for Entrepreneurship & Innovation"? 180 contact write-backs happened in total.
7. **Duplicate companies underneath it all:** THREE separate records are named "Grand Rapids SmartZone"
   (`697110e0…`, `692619cad…`, `692619c8d…`), plus "Grand Rapids SmartZone LDFA" and "Spartan
   Innovations (working w/MSU Foundation)". Contacts are spread across them, which is how the Burgess
   name landed on a Grand Rapids record. `lib/dedup/engine.ts` exists.

---

## 🟡 2026-08-31 — activity capture: what's proven, what's blocked

**Group-level calendar routing is PROVEN END TO END** (`e096d4c`). Booked a real appointment on
`TEST - SAMA TA` — a calendar with **no per-calendar rule** — and it resolved via the group, created
the activity with `modality=one_on_one` + `service_topic=coaching` inherited from the group defaults,
associated 1 contact + 1 company, and reported `noop` on re-delivery. Appointment and activity both
deleted; back to 236 records, 0 leftovers. All four calendars in the two new groups resolve with zero
per-calendar config, **including ones created after the rules existed** — so adding a TA link later
needs nothing from this app. Zach's existing SAMA links keep their per-calendar rules and stay in the
SAMA group, so his spreadsheet workflows are untouched (precedence is calendar-first, group-second).

**Nightly activity ingest is live** (`47e2d31`, 09:15 UTC): appointments (7-day window) + opportunity
stages. Forms are deliberately NOT swept — see the workflow header for why (metrics would be filed
under the wrong reporting period; grants could overwrite an earlier grant once anyone gets a second).

**A stale claim now self-heals** (`e096d4c`). Deleting an activity by hand left the claims ledger
pointing at a dead id, and the 404 meant that source event could NEVER be re-ingested — every future
delivery threw on the same missing record. 404/400 now releases and re-creates; a 500 still
propagates, because masking it would duplicate activities during an outage.

### 📊 The workflow-written spreadsheets are the RICH source (measured 8/31)

Zach supplied the live Google Sheets his GHL workflows write to (`Past Grant Reports/Trusted Connector
Report.xlsx`, `SBSH Companies Served Spreadsheet (1).xlsx`; i4.0 not yet exported and is last anyway).
These are per-event logs with boolean type flags and a `Date Added` column — **not** the reformatted
submissions.

| Sheet | Rows | Date range | Type flags |
|---|---|---|---|
| TC "Cumulative Reporting" | **375** | 2025-09-30 → 2026-08-27 | 1:1 TA **271** · Group TA 46 · Referral 65 · tech/innovation event **0** · networking **0** |
| SBSH "Sheet1" | **207** | 2025-01-13 → 2026-08-14 | 1:1 consulting 104 · Group training 14 · SB support services 80 · Other 16 |

⚠️ **The headline number: the TC sheet holds 271 one-on-one TA rows; GHL holds 15.** Appointment-based
capture is catching a small fraction of real TA, because most sessions ran on links whose workflow
writes the sheet but which aren't routed here, or on Google Calendar. That is why TC KPI 7 looked thin
— not a bug, a coverage reality, and the sheet is the fix.

✅ **The dedup question is now ANSWERED BY THE DATA** — spec: `docs/sprints/sheet-import.md`.
**Rows are single-type** (253 pure 1:1TA · 65 Referral · 39 GroupTA · 11 1:1TA+Grant · 7 1:1TA+GroupTA),
so an intake and a referral on the same day are two rows and never need disentangling. What needed
disentangling was *inside* the 1:1 TA column — and **the notes carry the appointment title verbatim**
(`"Intake Meeting with Jay Mitchell | …"`, `" Tyler Scott | Check-In with Lean Rocket"`). Classifying
the 271 rows on notes text: **84 intake · 187 technical assistance**. Validated independently: of the
80 in-range rows mentioning intake, **63 have a GHL intake on the exact same date (79%)**.

**Dedup rule = (company, date, resolved type).** Measured overlap:

| | Rows | Already in GHL | Net new |
|---|---|---|---|
| notes say intake | 84 | **63** | 21 |
| resolve to TA | 187 | 14 | **173** |
| | **271** | 77 | **≈194** |

The collision concentrates exactly where expected — intake, the one type GHL already captures well —
which is corroboration the rule measures something real. **232/271 rows (86%) match an existing GHL
company**; 39 don't. **48 rows are pre-2026** where GHL has zero coverage, so those are safe by
construction and are the right first slice. Identity `tc-cumulative:row-<N>` (rows are appended, never
re-sorted; deliberately not a content hash so editing a note can't orphan the record).
**All three of the 8/31 questions are now measured:**
· **CORRECTED — only 9 businesses need a company record, not 39.** Zach checked the examples and
found some DO have companies; name matching was producing false negatives. Re-resolved with the house
rule (email → contact → `businessId`): **345/375 rows resolve by email**, 17 by name fallback, 9 find
a contact with no company, 4 unresolved → **13 rows / 9 distinct businesses**. Why names failed:
sheet "Chem Clean Treatment Services" vs GHL **"ChemClean Treatment"**; "Prescription Earth
Acupuncture + Herba…" truncated. **NEVER match these sheets on company name — email is the key**, and
it's what every other adapter already uses.
⚠️ **One row is a warning, not a win:** "Jessie's Bookkeeping Solutions" resolves by email to
**"Bailey & Co"** — a different business. Either the contact is mislinked or the person changed
business. Same class `lib/sync/identityGuard.ts` exists for, so the importer must apply the same
comparison and **flag a sheet-name vs resolved-company disagreement for review rather than silently
attaching history to the wrong company** (invisible afterwards).
· **`Reason for grant` is a TIMING bug, not a prompt bug.** Zach: it was a GHL workflow + ChatGPT step
reading the contact's line items. It fires while those are still blank, so the model correctly says it
has nothing to summarise and the apology gets stored. Same root cause as the grant snapshot: run it at
**agreement execution**, when line items are final. Importer treats the failure shape as empty.
· **The batch-date question has a sharper discriminator than cluster size: the `|` in the notes.**
**136 of 375 rows carry the appointment-title separator** (`Intake Meeting with Jay Mitchell | …`) —
appointment-derived, so date and type are trustworthy, spread over 63 dates, max 10/day. The 7 dates
with ≥10 rows hold 139 rows (37%) and split cleanly: **2025-09-30 (27 rows, 0 titled, 13 blank) and
2025-12-31 (22, 0 titled)** are catch-up entries — note they're **quarter end and year end** — while
**2026-01-28 (10 rows, 10 of 10 titled) was a genuinely busy day.** Cluster size alone would have
thrown that one away. 7 rows are named `Unsure`/`Unknown` → skip. Import rule: titled rows at full
confidence; untitled rows with an **approximate-date flag**, the same treatment the 52
program-acceptance records already carry.
· ✅ **WEDNESDAY RULE CORROBORATES THE CLASSIFIER.** Zach: *"Intake meetings are always on
Wednesdays. Referrals are all over the place."* Of the 84 rows the notes classify as intake, **80 are
Wednesday** (2 Fri, 1 Thu, 1 Mon) — **95%**. Two independent signals (appointment title in the notes,
day of week) agree, which is the strongest available evidence the classifier reads real intakes rather
than noise. ✅ **Zach's call: approximate dates are FINE for history already reported** — catch-up rows
are Alex writing up meeting notes after the fact, normal practice not a data fault. Date-repair by
snapping to the nearest Wednesday, and scraping calendars/email for real dates, are both noted and
deliberately NOT built.

✅ **`event_type` derivation RESOLVED (Zach, 8/31):** *"We don't really keep track of Innovation Events
specifically… if the event is tech/innovation topic focused it counts for that bucket, if it is more
networking or mentorship driven it goes in the other."* So it is a **topic judgement per event**, not a
maintained field — a one-time classification pass over 47 Wix events, AI-proposed and stored as a
`derivedFrom` value so it recomputes, exactly like the readiness tagger. Two buckets only.
⚠️ **And the sheet cannot supply either events bucket:** `Hosted a Tech or Innovation event` and
`Networking or mentorship initiative` are **false on all 375 rows** — neither has ever been logged
anywhere, so TC required KPI 3 and KPI 6 can ONLY come from phase 6.

### 🔴 Phase 6 (Wix events) — designed, BLOCKED ON WIX PERMISSIONS
Spec: `lrl-grant-reporting/docs/sprints/wix-events-phase6.md` (includes the measured API shapes).
The app's `WIX_API_TOKEN` can list events (47, of which 37 ENDED) but **cannot read attendees**: RSVP
rows come back with `anonymized` set and empty email/name, the `eventId` filter is ignored, and all
ticketed-order endpoints 404 — and most LRL events are TICKETING. The `wix-ghl` MCP tooling reads the
same site with real names, emails and check-in state, so **this is a permissions gap on the API key,
not an API limitation.** ⬜ **Zach: add Wix Events read permission (incl. contact details) to the
app's API key.** Also carried: every ENDED event reports **0 attended**, so the check-in app isn't
being used at the door — the adapter will report zero attendees against TC's target of 100 until that
changes.
⚠️ **API gotcha worth remembering:** Wix Events paging is TOP-LEVEL (`{limit, offset}`). Nesting it as
`{query:{paging:{...}}}` returns `total: 47` with `limit: 0` and an EMPTY array — it looks like an
empty site rather than a bad request.

## 🆕 2026-09-02 — the metrics BACKFILL source changed: Gateway workbooks, not contacts

**Rejected:** backfilling the 382 contacts that hold Client Reporting answers. Zach: *"I do not want
to stamp all of our previous records to the current period."* Right call — a contact holds only its
LATEST answers and **nothing on the contact records when the form was submitted** (every DATE-type
contact field checked; there is none), so that import could only have filed 382 snapshots under one
assumed period. That is fabricated history, and a wrong period on a funder snapshot is worse than none.

**Adopted:** import `Past Grant Reports/Gateway/` — **7 funder-submitted semi-annual workbooks,
227 rows, 225 (99%) carrying an email.** One row per company per period, already reconciled and sent
to MEDC. Brief: `docs/sprints/gateway-metrics-import.md`.

**The periods need NO new logic.** Zach's rule is already encoded in `reportingPeriod.ts` (windows end
Feb-end / Aug-end), and Gateway's April/October cadence lands exactly on those boundaries — pass each
workbook's nominal submission date to `reportingPeriodFor()`:
Apr2023→**2023-02-28** · Oct2023→**2023-08-31** · Apr2024→**2024-02-29** · Oct2024→**2024-08-31** ·
Apr2025→**2025-02-28** · Oct2025→**2025-08-31** · Apr2026→**2026-02-28**. Seven distinct periods, and
**none collides with the live 2026-08-31 snapshot.**

Columns map ~1:1 onto the metrics activity (jobs created/retained, commercialized products, pipeline,
MEDC / federal / VC / angel / bank / owner / new sales / other funding + explanation) and every figure
is already "in the last 6 months" — no re-basing.

**Identity: claim source `Form` with `<contactId>:<periodEnd>`** — the same key `sources/form.ts`
computes — so a future real submission for one of these periods UPDATES rather than duplicating. A
`gateway-<period>:row-N` key reads tidier and silently permits a duplicate per period. (The 8/19
54-duplicate-grants lesson: identity is *both* halves.) Resolve by **email only** — never these
workbooks' company names.

**Two gaps to state, not paper over:** (1) **FTE is absent from Gateway entirely**, so
`current_number_of_full_time_equivalents_fte` history is unrecoverable — and that is **SBSH col N**
by name; nothing will fix it. (2) Cohort is ~33/period (Gateway's lens is ~78), so this is a **Gateway
metrics backfill**, not a general one.

## ✅ 2026-09-02 — ⭐ FIX 1 IS DONE. Webhook #3 is wired, tested, and capturing snapshots.

Zach wired it and a real form submission was verified end to end:

```
20:11:57  claim   Form | wmuLKw1RQLVaoI9n9qeN:2026-08-31
20:11:58  create  "Metrics – Mar–Aug 2026"   applied=true
```

**metrics activities 0 → 1** — the first one in the system's history. The record carries a full
snapshot (30+ fields: FTE, jobs created/retained, MEDC funding, new sales, follow-on funding, patents,
trademarks, NPS) with `reporting_period = 2026-08-31`. **Every future Client Reporting submission is
now captured instead of overwriting its contact.** The six-run ⭐ item is closed.

### 🔴 THE GOTCHA THAT COST A ROUND-TRIP — GHL does not send a custom JSON body
The first attempt fired correctly and did nothing. Vercel log:
`POST /api/form-sync 202 · [fastAck] form-sync completed in 872ms { contactId: 'wmuLKw1RQLVaoI9n9qeN',
formId: undefined, via: 'body.contact_id' }`

**`formId: undefined`**, and `via: body.contact_id` — GHL delivered its own STANDARD payload
(`contact_id`), **not** the custom `{"contactId":"{{contact.id}}","formId":"…"}` body. So the form id
never arrived, `resolveRoute` found nothing, and the adapter took the `no-route` path — which returns
**before** the claims ledger is touched, so there was no claim, no change_log row, and no error. GHL
recorded success. Completely silent.

**THE WORKING SHAPE — put the form id in the URL, and let GHL send whatever body it likes:**
```
POST  https://lrl-grant-reporting.vercel.app/api/form-sync?formId=ed03BbRGWrc6Ugtwr9JB
hdr   x-webhook-secret: <WIX_SYNC_WEBHOOK_SECRET>
body  (none needed — the contact id arrives as contact_id in GHL's standard payload)
```
Also settled: **`x-vercel-protection-bypass` is NOT needed** (production alias is unprotected;
measured HTTP 200 without it), and **Vercel Fluid Compute is working** (the 202 fast-ack completed and
logged its work). Two carried worries retired.

### ⚠️ TWO FIELD-NAMING WARTS FOUND IN THE SNAPSHOT — they will bite at report time
1. **Copyrights issued is stored under a copy-of-a-copy key.** The record holds
   `number_of_copyrights_applied_for_in_the_last_6_months_copy` **and**
   `number_of_copyrights_applied_for_in_the_last_6_months_copy_3nt_copy`. The second is almost
   certainly *copyrights issued*, created by duplicating the "applied for" field without fixing the
   key. **Applied vs issued cannot be told apart by key** — same class as the
   `contact.expense_category_item3` missing-underscore bug.
2. **There are TWO FTE fields:** `current_number_of_full_time_equivalents_fte` = 6 and
   `number_of_full_time_equivalents_fte` = 1. The form's own label is "Current number of Full Time
   Equivalents (FTE)", so the `current_…` one is the real answer and the other looks legacy.
   ⚠️ `form-ingest-run.ts`'s probe regex is `number_of_full_time_equivalents_fte`, which **substring-
   matches both** — fine for finding targets, dangerous if a report ever binds the wrong one.
   **SBSH col N ("Current FTE's") and TC KPI 12–15 must bind `current_…` explicitly.**

## 🔄 2026-09-02 — Sprint C re-sequenced: the WORKBOOK before the KPIs

Zach: *"The companies served sheet is the most important part of this. We can build out the KPI
ability after getting a workbook in the right format."*

**Phase 1 = the row-level companies-served workbook**, in the funder's real format (header row 3,
column order A→AE, col K limited to the sheet's own three dropdown strings, `__`/`Duplicate` helpers
present), reconciled against `Past Grant Reports/Trusted Connector Report.xlsx` "Cumulative Reporting".
**Phase 2 = the KPI tab**, computed over the phase-1 row set — it cannot come first, because a KPI
built on an untrustworthy row set is a number nobody can defend and would be rebuilt anyway.

The 8-KPI table below is therefore the **phase 2** burn-down, not the sprint's. It still earns its
place: it says which columns must be trustworthy in phase 1.

⚠️ Read as **TC's row-level tab**. If Zach meant the **SBSH** "Companies Served Spreadsheet" as the
first target funder, swapping is cheap now and expensive after phase 1 is built.

### Carried facts from the webhook #3 build (still load-bearing for #2)
- ✅ Both form routes exist in `activity_routes` and are **enabled** — `ed03BbRGWrc6Ugtwr9JB` → `metrics`,
  `0d8irJ6Ay6VQFajG06Go` → `grant`. So wiring #2 ingests rather than silently no-opping.
- ❌ **`x-vercel-protection-bypass` is NOT needed** (measured: HTTP 200 without it). Vercel's
  `all_except_custom_domains` covers preview/generated URLs, **not** the production alias — which is
  also precisely why the app was publicly readable until 9/04.
- Handler fallbacks: `?formId=<id>` in the URL; `?echo=1` dumps GHL's real payload while running nothing.
- ⚠️ **`vite-node` cannot run from a Claude session** in the mounted folder — `node_modules` holds the
  darwin rollup binary and the sandbox VM is linux-arm64, which is the same reason **vitest cannot run
  here either**. Ingest scripts and `npm test` are Zach's Mac only. `npx tsc --noEmit` DOES run in the
  VM, and a read-only DB or GHL query works with plain `node` + `fetch` / `@neondatabase/serverless`.

## 🔄 2026-09-02 — Zach retired historical intake/TA classification

*"They all end up going on the sheet as 1:1 TA for TC anyways."* The intake-vs-TA distinction was never
recorded reliably, and **the TC funder does not ask for it**: col L binds to
`intake ∨ (technical_assistance ∧ modality=one_on_one)`. So the 8/31 classification work stands as
evidence but is **not load-bearing for TC**, and there is **no back-classification pass, no date repair,
no calendar scraping** for any program.

- **Rule narrowed for TC-sourced rows:** default `1:1 TA`; promote to `intake` **only if the notes
  literally say "Intake."** Stricter than what shipped in `3d3e19e` (which promoted on notes mentioning
  referrals/intros). ⬜ **Revisit those 11 promotions** — the importer can correct its own records now
  (`e910292`), which is what that fix bought us.
- **SBSH col Z `First Time Served by the Hub` is the discriminator TC lacks** — Yes + 1:1 TA ⇒ probably
  an intake. SBSH self-classifies from its sheet; TC rows inherit by cross-reference on company + date.
- ⚠️ **SBSH 2.0 is expected with a NEW format.** Do not harden against the current SBSH template —
  version the lens and column set separately (design rule 4). Another reason SBSH is out of Sprint C.

## 🔐 2026-09-04 — SECURITY: the app was publicly readable, and the funnel is what made it urgent
### ✅ CLOSED — re-probed 2026-09-08, all three routes now 401

**Measured anonymously from outside the network, no header, not Zach's laptop — BEFORE (9/04):**

```
200  GET https://lrl-grant-reporting.vercel.app/api/companies/search?q=...
200  GET https://lrl-grant-reporting.vercel.app/api/mapping/list
200  GET https://lrl-grant-reporting.vercel.app/api/enrichers
```

**AFTER — the same three, re-probed 2026-09-08:**

```
401  {"error":"unauthorized"}  /api/companies/search?q=test
401  {"error":"unauthorized"}  /api/mapping/list
401  {"error":"unauthorized"}  /api/enrichers?user_role=admin     <- escalation dead
503  {"error":"client links are not configured"}  /api/client-profile   <- fails SHUT (see below)
200  /staff-login  (CSP frame-ancestors allows the GHL iframe hosts)
```

The `{"error":"unauthorized"}` body is `middleware.ts`, not Vercel SSO — so this is app-level
default-deny in production. It had been true since the 9/04 deploy; the three days it spent recorded
here as an open 🔴 were three days of nobody spending one request to find out.

- **7 of 49 API routes checked anything.** Only the webhook receivers, via `x-webhook-secret`. The
  other 42 were open, including `/api/mapping/apply`, which writes to live GHL.
- **`lib/auth.ts` was never authentication.** `parseGHLContext` reads `user_role` from the query
  string, so `?user_role=admin` was an admin. Fine while the URL was a staff secret.
- Vercel SSO is scoped `all_except_custom_domains` — which is exactly why the webhooks work with no
  bypass header, and why production is open.

This was already true. Emailing the app URL to 136 clients is what converted "obscure" into
"published", so it was fixed as a prerequisite of the funnel rather than a follow-up.

**Fixed by `middleware.ts` — default deny.** Everything requires a staff session cookie except two
allowlists: the 7 webhook receivers plus `/api/client-profile` (self-enforcing), and
`/client-reporting/*` + `/staff-login` (public surface). Webhook routes are allowlisted rather than
re-checked one layer up **on purpose**: they already enforce, they are load-bearing during reporting
season, and two secret env vars are in play. No GitHub Actions workflow calls the app over HTTP
(checked), so no nightly can break.

**Staff auth is an interim shared credential** — one password (`ADMIN_SECRET`) exchanged for a signed
httpOnly `SameSite=None` cookie, so the GHL iframe embed keeps working after one login. The correct
answer is the GHL Marketplace SSO handshake; there is no Marketplace app on this location and no SSO
key in the environment, and Zoom is already blocked on an admin dependency. Structured so the
handshake later replaces `verifyStaffSession` alone, not the layer around it. Honest cost: change-log
attribution stays as weak as it is today.

---

## 🗄️ 2026-09-04 — Client Reporting rescore funnel (SCRAPPED 2026-09-08 — HISTORICAL)

> **🔄 THIS WHOLE SECTION DESCRIBES DELETED CODE. Kept for the reasoning and the live numbers only.**
> On 2026-09-08 Zach scrapped the app-hosted page for a **GHL-hosted scoring form**: *the app should be
> Lean Rocket Lab-facing only* — GHL is already internet-facing and is the vendor's problem, while this
> app holds every credential LRL owns. `/client-reporting/profile`, `/api/client-profile`,
> `lib/clientProfile/`, `lib/security/clientToken.ts` and `mint-rescore-links.ts` are in gitignored
> `_to_delete/scrapped-client-page/`; the app has **zero public routes**.
> **Ignore every env-var, minting and GHL-wiring instruction below — none of it applies.** The live
> design is `docs/sprints/scoring-form-build-spec.md` and the dashboard row above.
> **What is still true and worth keeping:** the live numbers (136/130/6, 38% unroutable), the reason a
> contact-scoped GHL form cannot write a company record, and the one-owner sync discipline.
> ⚠️ **This section is why the `CLIENT_LINK_SECRET` blocker survived five days** — the doc kept
> describing a feature that had been deleted. It is the strongest single argument for the third
> condense flagged in the doc map.

Spec: `lrl-grant-reporting/docs/sprints/client-reporting-rescore.md`.

```
email sequence -> funnel p1 Client Reporting Form -> funnel p2 confirmation + CTA
   -> APP /client-reporting/profile -> writes the COMPANY record, rescores, tags
   -> funnel p3 thank-you (+ Aiden's email fires off the tag)
```

The rescore form is an **app page, not a GHL form**, because GHL forms are contact-scoped and cannot
read or write a company record. The app page reads the authoritative company values, writes straight
back, and calls `runStageScoreTrigger` inline. Adds **no new two-way synced field** (the 8/27 lesson).

**Identity is a signed token, not `?cid={{contact.id}}`.** HMAC-SHA256 over `{contact, company, exp}`,
minted ahead of the send onto `contact.rescore_token` (GHL can merge a field but cannot compute an
HMAC). So the endpoint takes the company id from the signed payload and can never be turned into
"return any company by id"; links expire at 90 days; rotating `CLIENT_LINK_SECRET` revokes all of them
at once. Residual and accepted: the link is still a bearer capability if a client forwards it.

**Live numbers measured 2026-09-04:**

| | |
|---|---|
| contacts tagged `client` | **136** |
| linked to a company (get a working link) | **130** |
| **not linked — dead button unless fixed** | **6** (Phil Borchard, Karen Hyatt, Pooja S, Ron Sarver, Kate Burns, Mark Amboy) |
| sampled client companies | 56 |
| routes: tech / service / both | 11 / 19 / 5 |
| **UNROUTABLE — no `business_model`** | **21 of 56 (~38%)** |
| have a current score / never scored | 30 / 26 |

🎯 **That 38% is the same wound as the scorer's long-standing "857/895 no-route", and this funnel is
its treatment.** The page asks `business_model` first when it is missing, so every client who clicks
through converts an unroutable company into a scoreable one. This is a data-collection win, not just
a client-facing nicety.

All 18 scoring input fields, `business_model`, and all 5 `*_current` fields were verified present in
the live business catalog with the expected dataTypes: **0 missing**. `business_model`'s three options
are 200+ character paragraphs, so option lists longer than 60 chars render as radio cards, not a
dropdown.

### ⚠️ WAITING ON ZACH — none of this can be automated (see `ghl-workflow-automation-limits`)

**Before anything else, three env vars in `.env.local` AND Vercel:**

| var | value |
|---|---|
| `CLIENT_LINK_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `ADMIN_SECRET` | already set — this is now the staff password |
| `NEXT_PUBLIC_RESCORE_DONE_URL` | the funnel page 3 URL |

**Then mint the links (dry run first, per the house rule):**

```
npx vite-node scripts-ts/mint-rescore-links.ts            # reports the 130/6 split
npx vite-node scripts-ts/mint-rescore-links.ts --apply
```

**Then wire GHL by hand:**

1. **Funnel page 1 form -> On Submit -> Open URL:**
   `https://go.leanrocketlab.org/<funnel>/confirmation?t={{contact.rescore_token}}`
2. **Funnel page 2 CTA button href:**
   `https://lrl-grant-reporting.vercel.app/client-reporting/profile?t={{t}}`
   (GHL renders a URL parameter on the page as `{{keyword}}`. **Verify with one real submission** —
   if `{{t}}` does not resolve, fall back to putting `?t={{contact.rescore_token}}` in the *email*
   link to page 1 and carrying it forward the same way.)
3. **Email sequence links -> page 1:** append `?t={{contact.rescore_token}}` as a belt-and-suspenders
   second path to the same token.
4. **Aiden's follow-up email:** trigger on **tag added = `rescore-submitted`**. The app applies it on
   every successful rescore.
5. **Link the 6 unlinked contacts to their companies** before the sequence sends, or they get a button
   that fails.

### Acceptance still to run (needs Zach's Mac — vitest cannot run in the sandbox VM, darwin rollup binary)

`npx tsc --noEmit` is **clean**. `lib/security/__tests__/tokens.test.ts` — **10/10 passing** (run in
the cloud container). `lib/clientProfile/__tests__/profile.test.ts` is written and typechecks but has
not been executed. Then: anonymous `/api/mapping/list` must return **401**, a tampered token **401**,
and an unchanged resubmit must write **nothing** and create no second stage record.

---

## ⭐ Top priority — the single most important next thing

> **🔄 2026-09-03 — SPRINT C IS SHELVED. The active sprint is now Sprint D — capture completeness.**
> Zach's call, and the record backs it: *"If we can't get an exhaustive list of activities that would get
> reported on our grants then the rest of it doesn't matter."* TC phase 1 is a row-per-qualifying-activity
> workbook, and **two of the seven feeding types have essentially no records** (`workshop_event` **0**,
> `introduction_referral` **1**) — so it would be confidently, silently incomplete and its acceptance test
> would fail for reasons unrelated to the engine. **Spec: `docs/sprints/sprint-d-capture-completeness.md`.**
> Sprint C is **shelved, not cancelled** — `grant-definitions.md` and the TC column bindings stay current
> and stay authoritative about which fields have to be trustworthy.

**⭐ THE ONE THING (2026-09-09): BUILD `scripts-ts/capture-coverage.ts` — and the spec below is not the
constraint, so put it in the calendar.**

**Ninth session. Yesterday's experiment is now a result worth acting on.** The 9/08 run stopped
restating the bullet and wrote the exact spec here instead, on the precedent that ⭐ fix 1 moved within
an hour of becoming an instruction. **The spec sat here for a full working day during which four commits
landed, and the file still does not exist.** So the constraint is not specification, and one more
rewording will not fix it. What displaced it was a live company record being silently corrupted, which
genuinely outranks an instrument — and that is the structural point: **this file only ever gets built on
a day when nothing goes wrong, and on a day when nothing goes wrong nothing forces it either.**

⬜ **The one ask, now four runs old and unanswered: give it a scheduled block.** ~2 hours. Everything
else in Sprint D is judged by it, and the census standing in for it is blind to 188 of its own records.

**The spec, unchanged and ready — no thinking owed before starting:**

> **`scripts-ts/capture-coverage.ts`** — read-only, no writes, no `--apply`.
> **Output: one row per (activity type × grant definition).** Seven types × four grants.
> **Columns:**
> 1. `type` · `grant`
> 2. `source` — the ingesting source from `activity_routes`, or **`NONE`** (a type with no rule ingests
>    nothing; that is the single most important cell in the table)
> 3. `wired` vs `built` — is there a live webhook/runner delivering, or only code?
> 4. `records_30d` — count created in the trailing 30 days, **excluding backfill provenance**. A backfill
>    proves history, not capture.
> 5. `last_real_ingest` — timestamp of the most recent non-backfill record
> 6. `bound_fields_fill` — per-field populated/total, **for the fields that grant's definition binds to
>    only** (from `docs/sprints/grant-definitions.md`); a field no funder asks for must not dilute the score
> 7. `verdict` — 🟢 live+labelled · 🟡 live, fields thin · 🔴 no real capture
>
> **Acceptance:** it reproduces the four-point bar in `sprint-d-capture-completeness.md` §3 as a table a
> human can read in one screen, and it must print `workshop_event` as 🔴/`NONE`-sourced rather than as a
> zero that could be mistaken for "nothing happened this month".

**Then the second thing, and it is now a REAL build rather than an env var:** run
`scripts-ts/scoring-form-setup.ts` (dry-run → apply) to create the **12 missing contact fields** and the
**24 mapping rows**, then build the GHL Scoring Form from `docs/sprints/scoring-form-build-spec.md`.
⚠️ **Copy the answer options character-for-character** — GHL derives a single-select's option KEY from
the label, and a label off by one character matches nothing and fails **silently**; that has cost this
project data three times. The setup script re-reads the catalog and builds each mapping row from the key
GHL **actually assigned**, never a guessed one — keep it that way.

~~Set `CLIENT_LINK_SECRET` / `NEXT_PUBLIC_RESCORE_DONE_URL`~~ ✅ **VOID — the feature was scrapped
2026-09-08.** Carried here for five days after it stopped existing.

**And one manual GHL-UI click carried out of the 9/08 incident:** clear the stale `county` on the
company record by hand. Our write layer **cannot empty a single-select** (see the dashboard row) — the
objects path drops an empty value before it reaches GHL and reports `written: [] skipped: []`. The
contact side is already cleared, which is the side that governs recurrence.

**Security acceptance still owed, but neither item is an exposure:**

1. **Prove the allowlist did not break what it protects.** Fire one real GHL webhook (or
   `POST /api/form-sync?echo=1` with `x-webhook-secret`) and confirm 200.
2. **One login sticks inside the GHL iframe** (the cookie is `SameSite=None; Secure` for exactly this;
   the CSP `frame-ancestors` header is confirmed correct as of today).
3. **`npm test` on the Mac** — vitest cannot run in the sandbox VM (darwin rollup binary).
   `lib/clientProfile/__tests__/profile.test.ts` typechecks but has never been executed.
4. ~~**Verify a client token end to end**~~ ✅ **VOID — the token code was deleted 9/08.** What replaces
   it as the acceptance test for the *new* path: one real Scoring Form submission reaches
   `/api/sync/up`, lands on the contact, syncs UP to the company, fires the scorer, and propagates the
   five `*_current` values back DOWN — with an unchanged resubmit writing **nothing**.

**Still owed after that — real gaps, named rather than quietly carried:**

- **Per-user attribution.** Staff auth is a SHARED password, so the change log cannot say who did what.
  The fix is the GHL Marketplace SSO handshake, which needs a Marketplace app this location does not
  have. Structured so it replaces `verifyStaffSession` alone. **Decide whether to create that app** —
  it is the same class of admin errand as the Zoom role permission, so ask early.
- **No rate limiting anywhere.** `/api/staff/login` has a 1-second delay on failure and nothing else;
  `/api/client-profile` has nothing. A signed token makes guessing pointless, but a scraper with one
  valid link can still hammer GHL's API through us.
- ~~**Secret rotation has no runbook.**~~ ✅ **VOID — client links no longer exist.** The general lesson
  survives for any future bearer-token feature: write the two-secret grace-period version *before* the
  first rotation, not during it.
- **`GHL_API_KEY` is a full-location key** held by an app that now serves public traffic. Nothing today
  leaks it, but the blast radius of any future bug on the client path is the entire location.
- **No audit trail on client-originated writes.** Still true on the new path, in a different shape: a
  Scoring Form submission arrives as an ordinary `/api/sync/up` webhook, so the change log records the
  field write but not that a *client* caused it. Worth a provenance marker before anyone asks "who
  changed this company's revenue".
- **`GHL_API_KEY` blast radius is now SMALLER, and that was the point of the pivot.** The app no longer
  serves public traffic at all (zero public routes), so a full-location key is no longer sitting behind
  a client-facing surface. Anything client-facing lives in GHL and reaches this app only through a
  webhook receiver with a secret. **Keep it that way.**

---

✅ The `git push` half of this line is **done and stays done** — `0 ahead / 0 behind` at `5eeae04`, and
as of 9/08 the **working tree is fully clean**: `stage-dupe-audit.ts` was committed in `9d50580` after
four runs as the sole dirty path. Nothing on this project is on one disk only, and the code repo is no
longer read-only to the maintenance routine.

**Why the instrument comes first within Sprint D:** everything else in the sprint is judged by it, and the
census standing in for it is **stale** — it predates the sheet import *and* the Gateway apply, so stop
quoting "236 activities" and "1 of 8 KPIs producible". Live today: **~901 activities · metrics 188 ·
grants 64 fully populated**.

**~~⭐ fix 1 — wire GHL webhook #3.~~ ✅ DONE 2026-09-02.** Six runs of listing it; Zach did it the same
hour he was handed a spec that needed no thinking. metrics **0 → 1**. The lesson worth keeping: the item
moved when it stopped being a reminder and became an exact, testable instruction.

**Then the two red cells, which are different kinds of problem:**

| Hole | Nature | Action |
|---|---|---|
| `workshop_event` = **0** | **credentials** — the app's `WIX_API_TOKEN` reads events but attendee PII comes back anonymized; the `wix-ghl` MCP tooling reads the same site with real names and check-in state | **Zach:** add Wix Events attendee/order read permission → phase 6 ships |
| `introduction_referral` = **1** | **behaviour** — the form at `/` works; nobody opens it. TC col P + KPI 16 (target 35) rest on it | a decision about how referrals get logged, not a build |

**Zach's hands, ~20 min, and nothing moves without them:** (1) the **Wix Events permission**, (2) the
**door check-in process** — every ENDED Wix event reports 0 attended because the check-in app isn't used
at the door, so phase 6 built perfectly still reports ~zero against KPI 3's target of 100 — (3)
**webhook #2**, the last unwired ingest path, and (4) 🆕 **the Zoom "Zoom for developers" role
privilege**, which only the Zoom **account owner** can grant. ✅ **The fifth item on this list — un-pause
"Contact Changed" — is DONE and was observed working end to end on 9/08.** If Zach is not the owner, this is a
one-sentence request to whoever is: *User Management → Roles → Role Settings → Advanced features →
"Zoom for developers" → View + Edit.* Without it, Server-to-Server OAuth stays greyed out and the Zoom
thread forks to per-user OAuth.

> **Webhook #2, in the shape that actually worked for #3:**
> `POST https://lrl-grant-reporting.vercel.app/api/form-sync?formId=0d8irJ6Ay6VQFajG06Go` ·
> header `x-webhook-secret: <WIX_SYNC_WEBHOOK_SECRET>` · **body: leave default.**
> `?formId=` goes **in the URL** — GHL delivers its own standard payload (`contact_id`) and silently
> ignores a custom JSON body, which is exactly how #3's first attempt returned 202 and did nothing.
> **`x-vercel-protection-bypass` is NOT needed** (measured: 200 without it); earlier guidance here and in
> `DEPLOY_SYNC.md` over-specified it. `?echo=1` dumps GHL's real payload without running anything.
>
> ⚠️ **This cannot be automated from a Claude session.** GHL's workflow builder runs in a cross-origin
> iframe (`client-app-automation-workflows.leadconnectorhq.com`) that ignores synthetic click events, and
> the public API has only `GET /workflows/`. Attempted and ruled out 9/02. Zach's hands or nobody's.

~~**Un-pause the GHL "Contact Changed" workflow**~~ ✅ **DONE — and verified by observation on 9/08.**
With the webhook back on, contact→company fired for the first time since 8/27, the enrichers computed
geo, and the scorer produced a first stage record. The loop's cause stays disabled in config and both
guards are live. Carried for twelve days; retired on evidence, not on a deploy.

**The remaining fixes, in this order** — they are fields the ingestion path never writes, so no amount of
future data collection fills them (details: `docs/sprints/funder-field-trace.md` §6):

| # | Fix | Why it's first | Size |
|---|---|---|---|
| ~~1~~ | ~~**Wire GHL webhook #3 (Client Reporting)**~~ | ✅ **DONE 2026-09-02.** metrics **0 → 1**; every future Client Reporting submission is now captured instead of overwriting its contact. The *backfill* half moved to the **Gateway workbooks** (real periods) after the 382-contact plan was rejected | done |
| ~~2~~ | ~~Set `modality` + `service_topic` on the 3 TA calendar routes~~ | ✅ **DONE 2026-08-27 (`c03b9a5`).** `--default k=v` (repeatable) added to `activity-routes.ts`; the 3 SAMA coaching calendars carry `modality=one_on_one, service_topic=coaching` (option KEYS — a label is a silent no-op). Backfill **13 updated · 72 noop · 2 created**; repeat run **87 noop**. `modality`+`service_topic` now **15/15** on TA → **TC required KPIs 7 and 8 UNBLOCKED.** `service_topic` stays a route default until Zoom supplies it per meeting | done |
| ~~3~~ | ~~**Fix the grant headline fields**~~ | ✅ **DONE 2026-09-03 (`691159c`, `187cfd8`).** `award_amount` **64/64**, `grant_program` 58/64, `grant_reason` derived from the approved line items (54/64). `award_date` reaches only 26/64 — GHL exposes no stage history — and the rest are left empty **and declared**, per the brief's own rule. Fixing it also caught the `activity_date` freeze (52/64 wrong period source) | done |
| 4 | **Phase 6 (Wix attendance)** | 0 `workshop_event` records. **Now a ROW SOURCE for TC, not just required KPI 3** (Zach 8/24: attending businesses are served businesses, all event types, gated on `attended='Yes'`) — so TC's row count is materially incomplete without it | the last ingestion adapter |
| 5 | **The geo-disadvantaged qualifier answers the wrong question** | `business.geo_disadvantaged` is HUBZone/OZ; TC col K + SBSH col W want SEDI / grant-geographic-area / COVID. **Cheaper than first written:** make it a COMPUTED column (SEDI → `SEDI-owned`, else geo → `Geographic Area defined in Grant Agreement`, else COVID) — nothing needs storing on `business`. But it IS **SBSH's row-selection predicate**, so SBSH can't be built without it | computed column + the derivation |

**5 of TC's 8 required KPIs cannot be produced today.** Only "# total businesses served" is ready as-is.
Then **Sprint C itself** — design settled in `docs/sprints/report-engine-design.md`.

### The four grants, as defined 8/24
A report definition = **eligibility lens + column mapping set**, edited like `/mappings`, where a column binds
to an activity field, an **association hop** to company/contact, an aggregate over the row set, or a row
predicate. Two lenses: *qualify* (which activities make a company count as served) and *emit* (what becomes
rows and cells). Grain is per-definition.

| Grant | Company lens (pure attribute predicate) | Acceptance counts | Emit | Cohort |
|---|---|---|---|---|
| **TC** | MI ∧ small business | LOCAL **or** SAMA | row per qualifying activity (+ event attendees) | **780** |
| **SBSH** | tri-county ∧ (SEDI ∨ geo) | LOCAL only | row per qualifying activity | **346 → 283** when Lenawee drops |
| **Gateway** | NAICS list ∧ MI ∧ age < 10 yrs | — | **one row per company** from the metrics snapshot, zeros when none | **78** |
| **i4.0** | mfg NAICS 31–33 ∧ MI | — | row per activity | **122**; tab 2 unmeasurable |

**TC and SBSH are the same report with different lenses** — same 5 activity types, same grain, differing by
exactly one option value (SAMA). Every lens is now a pure company-attribute predicate; **no lens walks the
activity graph.** SEDI = minority ∨ women ∨ veteran ∨ disabled (a derived OR over fields we already hold).
NAICS: we store **6-digit**, funder lists are **4-digit** → truncate to compare. The county list must be
**versioned config**, not a constant. Live acceptance records carry only `local` 52 · `sama` 32.

**🆕 The reporting subject may be a BARE CONTACT (Zach, 8/24).** The lens evaluates a **subject** = the
activity's company if linked, **else the contact itself**. 451 of 1,537 contacts have no company — but the lens
can evaluate almost none of them, and **the cause is that the enrichment path is company-only** (the [AI]
county/geo enrichers run on companies; the sync only mirrors between *linked* pairs). Two options, **⬜ Zach's
call**: (A) run the enrichers on contacts too — literal, but only 13% have a street address to geocode; or
**(B, recommended) create a lightweight company at first service** — every funder row is business-shaped
anyway, and it gives a stable dedup key. **B also guards a hazard that survives review:** period 1 counting
"Jane Smith, no company" and period 2 counting "Jane's Bakery LLC" double-counts one business on a cumulative
TC sheet, and both rows look plausible.

### Built for grant N, not grant 4 (Zach, 8/21) — four design rules
1. **A named predicate REGISTRY, not a rules DSL.** The current `EnricherFilter` model (`{field, anyOf[]}`)
   expresses only one of the five lens kinds the four existing grants already need. Primitives live in tested
   code (`sedi()`, `naics_in(list, depth)`, `enrolled_in(program, at)`, …); composition lives in config.
2. **Canonical METRICS between columns and facts.** "Jobs created" is already asked three different ways;
   binding columns straight to facts guarantees grant #7 silently disagrees with grant #2.
3. **The readiness report is GENERATED** — unbound columns, thin-population columns, cohort size per lens. An
   unbound column must be a declared state, never a silently blank cell.
4. **Version the lens and the column set SEPARATELY** — funders reissue templates cosmetically far more often
   than they change eligibility; a renewal should be clone-and-bump-the-period.

**Where the cost really lives:** familiar grant = an afternoon of config · novel predicate = one function · a
field we don't COLLECT = weeks of form change plus collection lag, which no engine work shortens.

**⚠️ COVERAGE IS NOT A GATE (Zach, 8/24 — standing guidance).** Population figures are **reference**: they say
how much historical context exists, which matters only for regenerating an already-submitted report. Do not
frame them as blockers on the build. The five ⭐ fixes are a different thing.

**Dimension vocabulary, with coverage measured:** D1 SEDI (39% answered, 259 true) · D2 geo-disadvantaged (77%)
· D3 geography (state 87% / county 82%) · D4 industry (`naics_code` 74%) · D5 business type (**weak**;
`i_am_selling` is 0/897, a dead field) · D6 **tech vs non-tech — knowable for only 165/897 (18%)** · D7 SBA
small business (no size-standard table exists) · D8 program enrollment · D9 served-in-period · D10 business
stage. **D6 is worth flagging:** by Zach's account it is one of the most common grant criteria, so it is an
*eligibility* input at 18% knowable. That is data collection, not engineering — and it belongs on the intake
path now, because the problem is invisible until submission.

**Still open: 10 confirmations** (`grant-definitions.md` §7 — D2's real definition, TC's small-business
predicate, grant periods + Lenawee's effective date, Gateway snapshot tie-break / age semantics / "created",
LOCAL granularity, whether intake/grant qualify for SBSH, 4 derivation maps, i4.0 tab 2).

**⚠️ i4.0 stays LAST — two non-mapping blockers:** its history lives in a **separate GHL sub-account** (shared
with Centrepolis, expected to retire), so none of it is in the Activities object — migrate rather than read
cross-location; and *"startups selling i4.0 solutions to manufacturers"* (tab 2) **has no field** at all.

### 🔎 NEW 2026-08-27 — ingestion dry-runs now report the DIFF, not the intent

Found while applying ⭐ fix 2: **the ingestion dry-runs were not reviewable.** Every adapter returned
before reaching `upsertActivity`, so a dry run restated the DESIRED field set — backfilling 87
appointments printed "would write …" for all 87 whether or not one value differed. Three real updates
were indistinguishable from eighty-four no-ops, which makes the review step of
dry-run → **review** → apply decorative on exactly the path that writes reporting data.

`upsertActivity` now takes `plan: true`: it resolves identity and computes the same diff the apply
uses, then writes **nothing** — no record, no change-log row, and no **idempotency claim** (a dry run
that consumed the claim would leave the following apply believing the event was already handled). All
three adapters (appointment · form · opportunity-stage) route their dry run through it, so plan and
apply cannot drift.

Same command before → after: `would-write: 87` became **`would-update: 13 · noop: 72 ·
would-create: 2 · skip:cancelled 42 · skip:not-yet-held 4`**, and the apply then reported exactly
`updated: 13 · noop: 72 · created: 2`. Two tests named *"plans without writing on a dry run"* had
asserted `upsertActivity` was NOT called; they now assert it IS called with `plan: true` — what their
names always described. 484 tests green.

### 🟡 ZACH-SIDE — two GHL workflows still unwired (#3 landed 9/02)
Everything below is built, tested and DEPLOYED; it just needs a GHL workflow pointed at it. Add a **Custom
Webhook** action with header `x-webhook-secret: <WIX_SYNC_WEBHOOK_SECRET>`. Append `?echo=1` to any of them to
see exactly what GHL delivers without running anything.

| # | Workflow trigger | POST to | Body | Why now |
|---|---|---|---|---|
| ~~1~~ | ~~Opportunity stage changed~~ | `/api/opportunity-sync` | `{"opportunityId":"{{opportunity.id}}"}` | ✅ created by Zach 8/19, live and verified |
| 2 | Form submitted — Direct Grant Application | `/api/form-sync?formId=0d8irJ6Ay6VQFajG06Go` | **default** | **Day 0 gate item 2** — the workflow exists, it just has no webhook |
| ~~3~~ | ~~Form submitted — Client Reporting~~ | `/api/form-sync?formId=ed03BbRGWrc6Ugtwr9JB` | default | ✅ **wired + verified by Zach 9/02; metrics 0 → 1** |
| 4 | Appointment booked / status changed | `/api/appointment-sync` | `{"appointmentId":"{{appointment.id}}"}` | least urgent — the calendar keeps the past |

Also open, smaller: create the **new calendars/groups for meeting types** and route them
(`activity-routes.ts --set <calendarId> --type intake|technical_assistance`); decide whether **Milestone Grant
Meeting** is TA (currently unrouted); match the **65 resources** with no company record by hand.

### 📁 Reference material in the repo
`Past Grant Reports/` (see its README) — 22 submitted workbooks, read-only: **i4.0 ×13** (2023→2026 quarterly),
**Gateway ×7**, **TC ×1**, **SBSH ×1**. These **are** the Sprint C acceptance test, and the multi-period series
lets the engine be validated across several periods rather than one lucky one.
⚠️ **If you backfill activities from these sheets, use the README's rule:** import only rows dated **before
2026-01-01**, for types with no pre-2026 coverage. That makes collision impossible by construction instead of
relying on fuzzy company+date matching, which is how double-counting gets in.

**Lesson worth not relearning (8/19):** activity identity is **(source, source_record_id)** — *both* halves.
The grant form looked its record up under source `Form` while the pipeline had written `Opportunity Stage`, so
it found nothing and would have created 54 duplicate grants. Any adapter sharing a record with another MUST
share both halves of the key.

---

## ⚠️ Drift check (are we working on the right thing?)

- **🟡 2026-09-09 — the stall broke, the work was right, and the ⭐ still lost. The finding is that the
  intervention was tested and failed.**
  **Direction 🟢, without qualification.** Four commits landed 9/08 and every one of them was correct
  work: a live company record was being silently corrupted, and a corrupted record outranks an
  instrument every time. The county fix that came out of it is **eligibility-grade** — an Ohio business
  reading "Jackson County (MI)" is an SBSH false positive that looks entirely ordinary — and the
  stage-scoring race fix removed a real duplicate generator. None of this is drift and it should not be
  scored as drift.
  🔎 **The 9/08 test, both answers.** Does `scripts-ts/capture-coverage.ts` exist? **No. Nine for
  nine.** Has `/api/client-profile` stopped returning 503? **The question is void — the route was
  deleted on 9/08.** Zach scrapped the app-hosted client page in favour of a GHL-hosted form, so a
  blocker this doc had carried for five days described a feature that no longer existed. That is the
  *second* time in a week (after the security 401) that a carried 🔴 turned out to be stale, and the two
  have different causes worth separating: the 401 was never measured, this one **was** measured — the
  503 was real — but nobody asked whether the thing behind it still mattered. **A stale blocker does not
  announce itself by going quiet; it keeps returning exactly the error you expect.**
  **What is genuinely new, and why this is 🟡 rather than 🟢:** yesterday's run did not merely restate
  the ⭐, it **ran an experiment**. The theory — from ⭐ fix 1, which sat six runs as a bullet and moved
  within an hour of becoming an exact instruction — was that the missing ingredient was specification.
  So the full spec went into the ⭐ section. It sat there for a full working day, during which real
  work happened, and **the file still does not exist. The hypothesis is disconfirmed.** The constraint
  is not the spec and never was; three previous entries said so and this one has the evidence.
  **The structural read, which is the useful part:** `capture-coverage.ts` is only ever reachable on a
  day when nothing goes wrong — and a day when nothing goes wrong is exactly the day nothing forces it
  onto the calendar either. Nine sessions is enough to call that a property of the queue, not a
  property of any one day. **A brief cannot fix this and should stop trying;** the ask that has never
  been answered — a scheduled block — is the only lever left, and this is the fourth time of asking.
  **The test for the next run:** does `scripts-ts/capture-coverage.ts` exist as a file? If it does not,
  the correct response is to stop listing it as the ⭐ and escalate the scheduling question directly,
  because a tenth restatement is a measurement of this routine, not of the project.

- **🟡 2026-09-08 — direction 🟢, and the carried 🔴 turned out not to exist. That is the finding.**
  Four days with nothing landed (no commits 9/05–9/08), so there is still no work to drift. What is new
  is that **the thing the pause was being judged against was measured today and it was already fine** —
  the middleware has been denying by default in production since 9/04. Three consecutive briefs escalated
  an "open production security hole" that was closed the whole time, in increasingly sharp language, on
  the reasoning that *"a green deploy is not evidence; the 401 is."* The reasoning was right and the
  conclusion was wrong, because **nobody ran the probe — including this routine, which had the means to
  and instead restated the risk three days running.** The lesson is not "the fix was fine"; it is that a
  cheap measurement deferred is more expensive than the work it was deferring. **A blocker that can be
  checked in one request should never be carried to a second brief.**
  🔎 **The 9/06 test has two answers.** Has the probe returned 401? **Yes** — and it would have on 9/05.
  Does `capture-coverage.ts` exist? **No.** Eight for eight.
  **What this changes about the ⭐:** every previous session had a defensible reason to skip the
  instrument, and four of them genuinely did. That structure is gone. There is now no competing 🔴, no
  live exposure, and no ambiguity — so if `capture-coverage.ts` does not exist tomorrow, the cause is the
  attention constraint named on 8/28 and 9/05 and nothing else. This run has therefore stopped asking and
  written the **exact spec** into the ⭐ section, which is the one intervention that has ever worked here
  (⭐ fix 1 sat six runs as a bullet, moved within an hour as an instruction).
  **The test for the next run:** does `scripts-ts/capture-coverage.ts` exist as a file, and is
  `CLIENT_LINK_SECRET` set (i.e. does `/api/client-profile` stop returning 503)?

- **🟡 2026-09-06 — this is not a drift flag, it is a STALL flag, and the distinction matters.** For six
  runs the question here has been *"is the right thing being worked on?"* Today the honest answer is that
  **nothing was worked on**: no commits on 9/05 or 9/06, no new files, `scripts-ts/stage-dupe-audit.ts`
  still sitting at +28 lines uncommitted exactly as it was yesterday. So direction is **🟢 by default** —
  a weekend with no work cannot drift — and the flag is entirely about a specific cost of pausing *here*.
  **What makes this pause different from a normal quiet weekend:** the thing it is paused on is not a
  sprint item, it is an unverified production security hole. On 9/04 the security work was correctly
  allowed to displace Sprint D *because* it was urgent. Two days later that urgency has not been
  discharged — the code shipped, the proof did not — and an unproven fix carries the worst of both: the
  work is spent and the exposure is live. **The 401 is fifteen minutes.**
  🔎 **The 9/05 test is answered, and the answer is no:** `scripts-ts/capture-coverage.ts` does not exist.
  Six for six. But note what that streak now means — the previous five losses were to genuinely better
  work, and this one was to nothing at all, which is a *different* finding and should not be scored as
  more evidence for the same one. The recommendation from 9/05 still stands and still needs a yes: give
  `capture-coverage.ts` a scheduled block with an exact spec, rather than a sixth top-of-brief bullet.
  **The test for the next run is unchanged, plus one:** does `capture-coverage.ts` exist, and **has the
  probe returned 401?**

- **🟡 2026-09-05 — exposure is fully cleared; the flag is now purely SEQUENCING, and it is the same
  one for the fifth run.** Nothing landed overnight (last commit `9e5c80b`, 9/04 22:15). Two 🔴s are
  gone for good: the push happened, and the nightly is green. So the *cost* side of every flag carried
  since 8/26 is now zero, which is worth saying plainly.
  **What replaced it:** 9/04 evening opened an entirely new surface — a client-facing funnel and an
  authentication layer — and it is **defensible on its own terms but it is not Sprint D**. The
  defence is real and should be recorded: the security work was **forced**, not chosen (emailing the
  app URL to 136 clients converts "obscure" into "published", and the probe found `/api/mapping/apply`
  open to the internet — a live-data-integrity risk beats a sprint item, exactly as the 8/27 incident
  did); and the funnel itself is the **right-object capture** thread arriving early, treating the same
  38%-unroutable wound as the scorer's 857/895 no-route. Neither is drift in *direction*.
  **The flag is that `capture-coverage.ts` has now been declared THE ⭐ on five consecutive days and has
  never been started.** Five sessions have each found something more urgent, and four of the five
  genuinely were. But the pattern itself is now the finding: Sprint D's own instrument loses to
  whatever arrives, so Sprint D's completeness is still asserted rather than measured, from a census
  that cannot see 188 of its own records. **This is the same failure mode as ⭐ fix 1**, which sat for
  six runs and then moved in an hour once it became an exact instruction rather than a reminder.
  ⬜ **Recommendation, needs Zach's yes:** treat `capture-coverage.ts` the way ⭐ fix 1 finally got
  treated — write the exact spec (one row per activity type × grant; columns: source, wired-vs-built,
  trailing-30-day count, last real ingest, per-field fill for bound fields) as a *scheduled block*,
  not a bullet at the top of a brief. A brief cannot fix an attention constraint by restating itself.
  **The test for the next run:** does `scripts-ts/capture-coverage.ts` exist as a file?

- **🟢 2026-09-04 (evening) — CLEARED. The pile is pushed.** `dac0667` on
  `claude/lrl-activity-logging-app-4ixdC`; the local branch had also fallen *behind* `7efdb67` (the
  `.env.local` guard that made the nightly green) and was rebased onto it. Nothing is now on one disk
  only. The day's work stayed inside Sprint D throughout: the gated enricher and the alias table are
  D2 labelling, and the `program_acceptance` measurement is D1 integrity. **The remaining flag is the
  same one as yesterday and it has not moved: `capture-coverage.ts` is still not built, and it is
  still THE ⭐.** Four sessions have now each found something more urgent — three of them genuinely
  were (a live loop, a frozen date, three silently dropped fields) but the instrument that would tell
  us whether capture is complete still does not exist, and every number quoted about coverage comes
  from a census that predates the sheet import.

- **🟡 2026-09-04 (earlier) — direction was 🟢; the flag was entirely about the UNPUSHED SEVEN.** Every piece of work
  done on 9/03 sits inside Sprint D and none of it is out of order in any way worth naming: the Gateway
  apply is D1 capture (metrics 0 → 188), ⭐ fix 3 is D2 labelling, the `activity_date` repair is a live
  integrity bug found *by* that work and correctly jumped the queue, and the Zoom spec is a named Sprint D
  thread. Yesterday's test — *"does phase 1 exist as a file?"* — is **void**, because phase 1 belongs to
  the sprint that was shelved hours later. So: no drift in direction, and a genuinely strong day.
  **What is flagged instead is exposure.** Yesterday's brief said *"1 behind / 4 ahead — push them."*
  Today it is **1 behind / 7 ahead**, so the response to the flag was to add three more commits to the
  unbacked pile. Those seven include the entire Gateway import and the entire grant-fields fix — the two
  most valuable things built this month — and they exist on exactly one disk. **Clears to 🟢 on `git push`
  and nothing else.** Secondary, milder: `capture-coverage.ts` was declared THE ⭐ and the day's work went
  around it rather than through it; the D2 work that happened instead was real, but Sprint D is still
  being measured with an instrument that cannot see 188 of its own records.
- **🟢 2026-09-03 (evening) — the drift was named by Zach and the plan changed to match.** The 🟡 below
  flagged that Sprint C's phase 1 had no code while adjacent work did. Zach's read went further and is
  better: the problem was not the order of the work, it was **that the report was the goal at all** while
  two of the seven feeding activity types have essentially no records. **Sprint C is shelved; Sprint D
  (capture completeness) is the active sprint.** This resolves both 🟡 entries below rather than carrying
  them — a report built on an incomplete row set was the actual risk, and it is now removed by
  sequencing. **The next drift check should ask: is `capture-coverage.ts` built, and are the two red
  cells closing?**
- **🟡 2026-09-03 — the 🔴 cost cleared; a new, milder pattern replaced it.** The five-run "webhook #3"
  flag is **retired**: it landed 9/02 and the daily snapshot loss has stopped. What replaced it is not
  urgency but **sequencing**. Sprint C was deliberately narrowed to TC and re-sequenced so that phase 1 —
  *the row-level companies-served workbook* — comes first, on Zach's own reasoning that it is "the most
  important part." Since that decision, the work actually done has been: a **Gateway** metrics-backfill
  brief plus a started adapter (Gateway is **explicitly out of Sprint C scope**), and a **grant headline
  fields** brief (⭐ fix 3, in scope). Both are defensible — the Gateway import is the replacement for a
  backfill plan Zach correctly rejected, and it buys real dated history rather than fabricated history —
  but the net is that **phase 1 has no code and the two things that do have code are adjacent to it.**
  Not drift in direction; drift in *order*. The check for the next run: does phase 1 exist as a file?
- **🟢 2026-09-03 — the uncommitted-only-copy risk cleared while this run was in progress.** It opened the
  run as a 🔴 (12 modified/untracked paths including new source, the same exposure the 8/26 flag named);
  a live session then landed **`7897666`** (1,559 insertions). Only residue: still **1 behind / 4 ahead**
  of origin, so those four commits are the sole copy. Push them.
- **📌 8/28–8/31, condensed 9/05 — one lesson, kept because it is repeating.** Those entries tracked
  ⭐ fix 1 (wire webhook #3) sitting un-moved for five consecutive runs while adjacent work landed. It
  finally moved on 9/02, **within an hour of being handed an exact, testable instruction instead of a
  reminder.** The conclusion drawn then — *"the constraint is attention, not capacity, and a brief
  cannot fix an attention constraint by restating itself"* — is the same conclusion the 9/05 entry
  above reaches about `capture-coverage.ts`. Full text in `_briefs/2026-08-28.md` … `2026-08-31.md`.
- **🟢 Direction is correct, and the readiness bar says so.** Gate (1) enrichers: still not all
  spot-check-verified with provenance. Gate (2) observability: **met** (8/04 + the 8/17–18 repair).
  Gate (3) funder-template tracing: **DONE** — ~150 columns bound, only 7 with no field anywhere.
  Gate (4) population: **measured** — good on identity/geography (74–100%), thin on firmographics (28–39%),
  absent on outcomes. So the model is right and the piping works; what is missing is *collected data* plus the
  five targeted fixes.
- **Deliberate strategy (Zach, 7/27), still in force:** get the data layer and piping rock-solid — trustworthy
  enrichers, reliable and observable syncs, and a proven mapping from GHL onto each funder template — *before*
  building the reporting/export side. Data-layer work is not drift while the bar is being worked toward; the
  only thing to flag is polish with no path to clearing it.
- **The Wix ecosystem was NOT drift** (recalibrated 7/27) — a deliberate EOS rock the roadmap never captured.
  Drift checks should stop flagging it.
- *(Readiness-bar and drift entries from 8/13–8/21 removed 8/25 — superseded. Full history in `_briefs/` and
  `_archive/2026-08-25/PROJECT_STATE-full-through-2026-08-24.md`.)*

---

## Blockers & open decisions

**Immediate**
- **⬜ NEW 2026-09-09 — read the suppression rows, then decide about review items.** The convergence
  guard now logs every suppressed write as its own `applied: false` change-log row (`ad9cbeb`); before
  that a suppression and "nothing happened" were indistinguishable, which is why Aiden's company sat
  at `mrl_current = 6` while its stage record said `7`. **The decision this unblocks:** `flagForReview`
  is only called for `guard.loops`, which carries the *oscillation* kinds — a **`non-converging`**
  suppression ("we wrote X, the field still reads Y, check the mapping transform/options") reaches
  **nobody**. That is a config fault sitting silently and it arguably deserves a review item as much as
  a loop does. It was NOT added, because filing one per affected field could flood the queue and these
  have been invisible, so the volume is unknown — the tracker's own note that *37 of 38 mapped fields
  form closed cycles* suggests it could be dozens.
  **Do this in a day or two, once rows have accumulated:** filter the change log on `applied = false`
  and count the rows whose `rationale` contains `non-converging`, grouped by field.
    - **a handful, concentrated in one or two fields** → add the review item; it is a real fault list.
    - **dozens across many fields** → do NOT file review items. It is a mapping-configuration problem
      to fix at the source, and a queue full of it would bury the identity-mismatch items that matter.
  A test in `lib/sync/__tests__/guardVisibility.test.ts` asserts the CURRENT behaviour (no review item
  for non-converging), so changing it is a deliberate edit rather than a drift.
- **⬜ CARRIED 2026-09-09 — the enricher concurrency race is still open.** `company-enrichers` wrote
  `county` three times in three seconds for Aidens Consulting on 9/09, each with `from=undefined`:
  three concurrent deliveries all read the field as empty before any of them wrote. The state gate is
  Postgres (immediately consistent) but is written *after* enriching, so it has the same shape as the
  scorer gate bug that was fixed in `bb80568`. **Not fixed, and currently not biting:** the narrowed
  GHL trigger means one delivery per submission, and the five SAMA/intake submissions on 9/09 each
  produced exactly one enricher run. It returns the moment concurrency does — a widened trigger, a
  backfill, or a burst — so fix it before re-widening the trigger rather than after.
- ~~**Five uncommitted files**~~ — ✅ **RESOLVED 8/27.** Tree clean, pushed, `origin` in sync at `c03b9a5`.
  (This also unblocked the `reports/` backlog, archived 8/28 after seven skipped runs.)
- ~~**⚠️ 3 GHL webhooks unwired**~~ → **2 remain, and neither loses data.** ✅ **#3 (Client Reporting) wired
  and verified 9/02** after five carried runs. #2 (Direct Grant Application) and #4 (Appointment) are
  backfillable at any time; **#2 is Day 0 gate item 2** and is a copy of #3 with one id changed.
- ~~**🔴 12 uncommitted paths, including new source, are the only copy**~~ → ✅ **RESOLVED MID-RUN, 9/03.**
  A live session committed all 12 as **`7897666` — "Import the Gateway workbooks as dated snapshots, and
  restore the dropped bank loans"** (1,559 insertions). Tree is clean.
- ~~**🔴 1 behind / 7 AHEAD of origin — the only copy**~~ → ✅ **RESOLVED 2026-09-04 evening.** Rebased
  onto `7efdb67` and pushed; 9/05 reads **0 ahead / 0 behind** at `9e5c80b`. Carried as a flag across
  three runs (4 ahead → 7 ahead → cleared). Only uncommitted path today: `scripts-ts/stage-dupe-audit.ts`.
- ~~**⬜ `scripts-ts/stage-dupe-audit.ts` +28 lines uncommitted for four runs**~~ → ✅ **RESOLVED 9/08**
  (`9d50580`). The working tree is clean and level with origin at `5eeae04`, so `lrl-grant-reporting/`
  is no longer read-only to this routine and the `reports/` backlog **unblocked itself and was archived
  on 9/09**, exactly as predicted.
- ~~**🔴 the security fix is committed but the production hole is unverified**~~ → ✅ **RESOLVED
  2026-09-08 BY MEASUREMENT — and it had been fine since 9/04.** Anonymous probes now return **401
  `{"error":"unauthorized"}`** on `/api/mapping/list`, `/api/companies/search` and
  `/api/enrichers?user_role=admin`; the JSON body identifies `middleware.ts` as the responder, not Vercel
  SSO. Carried as 🔴 across 9/05, 9/06 and 9/08 on the correct principle that *"a green deploy is not
  evidence; the 401 is"* — while the 401 sat one request away. **Retire the flag, keep the principle, and
  add its corollary: take the measurement in the run that raises the question.**
- ~~**🟡 `CLIENT_LINK_SECRET` unset / the funnel is inert**~~ → ✅ **VOID 2026-09-09 — the feature was
  scrapped on 9/08 and this blocker described something that no longer exists.** The app-hosted client
  page is deleted, `grep CLIENT_LINK_SECRET` over the source returns nothing, and the app has zero
  public routes. **Carried for five days.** Same failure mode as the security 401 a week earlier: a
  blocker restated daily while the thing it described had already changed. **The corollary to add to
  the 9/08 rule: before carrying a blocker to a second brief, confirm the FEATURE still exists, not
  just that the symptom is unfixed.**
- **🟡 REPLACES IT — the GHL Scoring Form is unbuilt, and the gap under it is bigger than an env var.**
  **0 of 24 scoring fields have a contact↔company mapping row**, and **12 of 24 contact fields do not
  exist**, including `business_model` — the router, and the field behind the 38% unroutable rate. Run
  `scripts-ts/scoring-form-setup.ts` (dry-run → apply), then build the form from
  `docs/sprints/scoring-form-build-spec.md`.
- **⚠️ `config/field-mappings.json` is a LEGACY SEED FILE — never read it to answer "is this field
  synced".** The live mappings are in Postgres (`field_mappings` + `syncs`). Grepping the JSON gives the
  **opposite** answer and nearly sent the scoring-form build the wrong way. Query the DB.
- **⬜ Housekeeping, flagged not done:** `lib/clientProfile/` and `lib/clientProfile/__tests__/` are now
  **empty directories** left by the 9/08 deletion (git does not track empty dirs, so the tree still
  reads clean). Left in place — they are inside the source tree and this routine does not touch source.
- **⬜ NEW, 9/08 — one manual GHL-UI click owed:** clear the stale `county` on the repaired company
  record. Not automatable — **our write layer cannot empty a single-select** (`/businesses/{id}` refuses
  custom fields; the objects path drops an empty value before it reaches GHL and reports
  `written: [] skipped: []`). The contact side, which governs recurrence, is already cleared.
- **⬜ NEW, 9/08 — picklist verification must bypass the field-catalog cache.** A successful live write
  to `business.county` read back through the **cached** `getFieldCatalog` and reported "did not
  persist" — a false negative that invites a pointless retry against a live picklist, where a bad retry
  costs the whole option list. Worth fixing in the verification helper, not per-script.
- **⬜ NEW, 9/08 — GHL's own dedupe can write our data without touching our code.** The incident was
  caused by GHL's **backup dedupe matching on PHONE** and cascading a form's business fields onto the
  associated company, with **no change-log entry**. `identityGuard` could not have helped — it guards
  *our* sync path. There is no fix here yet, only a fact that should shape design: **anything we rely on
  our guards to prevent, GHL can still do directly.** Worth deciding whether the nightly should diff
  company identity fields against the change log to detect the next one.
- ~~**⚠️ Deploy unconfirmed.**~~ ✅ **RESOLVED 2026-09-02.** Production is READY at `7efdb67`, past
  `c03b9a5` — the identity guard and the oscillation/rate guard are live. Base URL:
  `https://lrl-grant-reporting.vercel.app`. Vercel **SSO protection is ON** for all non-custom domains,
  so every GHL webhook needs `x-vercel-protection-bypass` alongside the app secret.
- ~~**🔴 `nightly-activities.yml` has never completed a run**~~ → ✅ **RETIRED 2026-09-04 — the claim was
  stale.** It has been green for three consecutive runs (#3–#5); run #5's output (`2 noop / 2 cancelled`,
  `147 noop / 176 no-route`) proves it does the work rather than exiting 0. The bare
  `readFileSync('.env.local')` was fixed in `7efdb67` and the same pattern was then found and guarded in
  **8 more scripts** added that week. ⬜ **One click still owed:** six workflows moved to node 22 + v5
  actions in `bec074e` and the first scheduled run since has not been looked at — open the Actions tab
  and confirm **run #6 is green**. Also measured, and it matters for the Zoom design: GitHub defers every
  scheduled run here by **~4–4.5 hours**, so a Zoom step on the nightly will not see a 9am meeting until
  the next day. Relative order survives; the "= 5:15am EDT" comments are fiction.
- **🆕 Zoom is blocked on a ROLE PERMISSION, not on money or feasibility.** Server-to-Server OAuth is
  greyed out in Zach's Zoom developer portal because it needs account owner / admin / the **"Zoom for
  developers"** role privilege. Only the **account owner** can grant it, and Zoom's own forums report that
  existing admins still can't see Role Settings. **First question: who owns LRL's Zoom account?**
- **Report-critical activity families — RE-STATE THESE, most of the old figures are dead:** metrics
  **188** (was 0 on 9/02 — 1 live snapshot + 187 from the Gateway backfill across 7 real periods) · grant
  headline fields ✅ (`award_amount` 64/64, `activity_date` 64/64 repaired) · `workshop_event` **0**
  (phase 6, gated on the Wix Events permission) · `introduction_referral` **1** (behaviour, not code) ·
  TA `modality` 15/15. ⬜ **`report-readiness-census.ts` is STALE and must not be quoted** — it predates
  both the sheet import and the Gateway apply. Its replacement is `capture-coverage.ts`, unbuilt.
- **⬜ Suspect: other pre-8/19 read-backs through a GHL search.** The 9/01 net-sales bug was
  `verifyMonthlyOpportunity` trusting `/opportunities/search` one second after its own write. `d25a275`
  (8/19) established the lagging-index rule and gave ingestion `activity_source_claims`, but code written
  **before** that date was never retrofitted — the net-sales feature shipped 8/04. Worth one sweep for other
  search-based find-or-create / verify paths. The net-sales one is fixed; no others are confirmed.
- **⬜ Zach's call: bare-contact subjects** — enrich contacts (A) or create a lightweight company at first
  service (B, recommended). Blocks how SBSH/TC count unlinked contacts.

**Infrastructure / carried**
- **⚠️ Vercel Fluid Compute is load-bearing.** Both GHL webhooks fast-ack via `waitUntil`; without it the
  invocation freezes when the response is sent and the work is **silently discarded** while GHL records
  success. If it is ever disabled, revert the handlers to synchronous. `?dryRun=1` / `?sync=1` still run
  synchronously.
- **`business.logo` is unwritable** — GHL rejects the `services.leadconnectorhq.com` form-upload link. It
  reports `skipped` rather than 500-ing the cascade. **Data decision:** drop the mapping row, or re-host logos
  where GHL can fetch them.
- **New GitHub secrets needed:** `WIX_API_TOKEN` + `WIX_SITE_ID`, or `nightly-resources.yml` cannot run.
- **Mapping/gate prod-persistence:** partly addressed (Wix mapping sets + gates are in Postgres); remaining
  runtime edits still want a DB.
- **`valueMap` is script-editable only** (`scripts-ts/set-team-value-maps.ts`) — the `/wix-sync` UI does not
  expose it.
- **`service_areas` on `custom_objects.resources` is still TEXT.** Flip when wanted:
  `resources-fields-to-multiselect.ts --include-service-areas --apply --yes`. Nothing depends on it being TEXT.
- **`TEXTBOX_LIST` writability is unverified, not proven** — no field of that type exists to probe. CHECKBOX
  turned out writable after six weeks of being wrongly refused, so don't trust the label.
- **BusinessStageTracking object** migration: 20 disabled mapping rows + the re-scoring automation should move
  to a dedicated custom object.
- **Zoom AI Companion feasibility** — gates the auto-meeting sprint; not yet verified.

**Data hygiene that bites at report time**
- **27 distinct spellings of `state`** (MI/Michigan/Mi/mi = 780 MI companies, 90 null) · **69 addresses holding
  the literal string `"undefined"`** · `business.date_of_initial_intake` 0/897 (derive from intake activities)
  · `business.phone`/`.email` 0/897 — **always read the contact** (owner name/email resolve for 99% that way).
- **One correction to `REPORTING_TEMPLATES_ANALYSIS.md`:** TC KPIs 12/13 (jobs created/retained) are listed as
  "not derivable" but **are** — the metrics activity carries both. Only KPIs 9–11 (LRL's own org) are genuinely
  outside the system.
- **90 of 92 resource records have no contact/company relations** (the original import) — needs a name/domain
  matching pass if resources should be joinable for reporting.
- **2 legacy April test activities** with no associations — safe to delete, say the word.
- **Zach-side, not code:** the Expert form must set `contact.website_team_tags` (without it a new expert never
  tags and never reaches the map); the Resource form needs a substantive-description requirement (a 29-char
  description yields zero service areas and zero stops).
- Minor: Alyssa Marken's unlinked Wix Team row · `program` reference resolver case-insensitivity · `i_am_selling`
  has no real source.

---

## Document & artifact map

**Canonical (keep current)**
- `PROJECT_STATE.md` — this doc; current state + top priority.
- `PROJECT_ROADMAP.md` — the phase/sprint plan, the dependency map, and the data-layer readiness gate.
- `CANONICAL_REPORTING_MODEL.md` — data spec · `REPORTING_TEMPLATES_ANALYSIS.md` — funder field inventory.
- `COMPANY_CENTRIC_DESIGN.md` · `CUSTOM_OBJECTS_SPEC.md` · `GHL Company-Centric Architecture - Playbook.md`.
- `lrl-grant-reporting/` — the live Next.js app (managed in Claude Code; specs in its root + `docs/sprints/`).

**Sprint D — the ACTIVE sprint (9/03)**
- `docs/sprints/sprint-d-capture-completeness.md` — **the doc to start from.** The reframe, the two halves
  (capture then labelling), the four-point bar that un-shelves Sprint C, the `capture-coverage.ts`
  instrument, the measured state of all 7 types, and the Zoom + right-object threads.
- `docs/sprints/wix-events-phase6.md` — the largest capture hole, fully diagnosed: a Wix **permissions**
  problem, with the live-probed API shapes (including the paging gotcha that silently returns nothing).

- `docs/sprints/zoom-notes-appointments.md` — the Zoom thread. ✅ **committed 9/04** (`974713f`,
  `26dd8cb`) — §0 carries the scope narrowing, the read-only spike plan, and the greyed-out-S2S
  diagnosis, and a stale blocker was retired from it.
- `docs/sprints/scoring-form-build-spec.md` — 🆕 **9/08 (`e7824ce`).** The GHL **scoring form**, generated
  from the LIVE company field definitions. This is the treatment for the **38% of client companies with
  no `business_model`** — the same wound as the scorer's 857/895 no-route — and it names the wiring
  end to end (form → `/api/sync/up` webhook → sync up to company → scorer → propagate down → 10-minute
  wait → results email, gated on `{{contact.trl_current}}` being non-empty so a failed score never sends
  a client blanks). ⚠️ **Its options must be copied character-for-character:** GHL derives a
  single-select's option KEY from the label, and a label differing by one character matches nothing and
  fails **silently** — the same label-vs-key bug that has now cost this project data three times.
- `docs/sprints/client-reporting-rescore.md` — **9/04. ⚠️ HALF SUPERSEDED 9/08 — read with care.** Its
  **security half is live and current** (§5's checklist was run and passed 9/08: 401 on three routes).
  Its **funnel half is scrapped**: §2 argues the rescore form must be an app page because contact-scoped
  GHL forms cannot touch a company record — true, but Zach chose the GHL form anyway and closed the gap
  with a sync-up webhook, because keeping the app non-public outweighed the direct write. §4's
  signed-token identity is deleted code. **For the live design read `scoring-form-build-spec.md`
  instead.**

**Sprint C — shelved 9/03, spec kept current (committed `7897666`)**
- `docs/sprints/sprint-c-tc-report.md` — *"Regenerate the TC report, end to end."* Scope, the Day 0 gate,
  the locked TC decisions, the column bindings, the 8 required KPIs. **Restarts when Sprint D §3 is met.**
- `docs/sprints/gateway-metrics-import.md` — the 7-workbook metrics backfill. ✅ **APPLIED to live 9/03**
  (metrics 0 → 188). Audit script: `scripts-ts/gateway-metrics-audit.ts`.
- `docs/sprints/grant-headline-fields.md` — ⭐ fix 3. ✅ **BUILT + APPLIED 9/03.** Read it for the
  `lastStatusChangeAt` vs `lastStageChangeAt` reasoning and the line-item placeholder hazard.
- `docs/sprints/sheet-import.md` — the TC/SBSH workflow spreadsheets as a row source (built + run 8/31–9/02).

**Sprint C — the live spec set (all committed 8/27, `ca947f0`)**
- `docs/sprints/report-engine-design.md` — the design, both halves: eligibility as a report-time lens, plus
  the column mapping set.
- `docs/sprints/grant-definitions.md` — the four grants precisely stated: lens, qualifying activities, emit
  rule, measured cohort, open questions. **The spec the engine is built against.**
- `docs/sprints/funder-field-trace.md` — gate (3): every funder column → its GHL field/aggregate/hop, with
  measured population. Doubles as the seed row set for the mapping UI.
- `scripts-ts/dump-catalogs-full.ts` + `report-readiness-census.ts` — the two read-only census scripts behind
  gate (4). ⚠️ **Their outputs were archived 9/09 as stale** — `report-readiness-census.json` predates
  both the sheet import and the Gateway apply. **Re-run them rather than reading the old JSON**, and
  note that `capture-coverage.ts` is the intended replacement for the census half.

**Shipped sprint specs (reference)**
- `docs/sprints/activity-tracking.md` (Sprint B — the source map + the two live-measured API constraints) ·
  `multiselect-write-fix.md` (the write-path repair, with live test matrices) · `change-log-plan.md` ·
  `scoring-enricher-kickoff.md` · `scorer-routing-config-plan.md` (planned, not built) ·
  `configurable-gating.md` (deploy pending) · `readiness-map.md` · `resources-tap.md` ·
  `upsert-find-or-create.md`.
- `_briefs/2026-08-17-wix-sync-audit.md` — the audit narrative and what was fixed live on config/data.

**Historical**
- `SPRINT_0_STATUS.md` — the foundation build handoff log; kept for its API/live-write detail.
- `GHL_ASBUILT_AUDIT.md` · `CONTACT_FIELDS_INVENTORY.tsv` — the original live audit.
- **`PROJECT_SUMMARY.md` was ARCHIVED 2026-08-26** → `_archive/2026-08-26/`. Flagged as superseded across
  five runs with no objection and no live reference to it anywhere outside the doc map; archiving is
  reversible — move it back out if it was still wanted.
- `COMPANY_FIELD_MAPPING_WORKSHEET.xlsx` — parked 123-field classification · `COMPANY_CLEANUP_REVIEW.xlsx` —
  the applied July cleanup (still referenced by `scripts/apply_company_cleanup.py`).
- `scripts/` (root) — the June/July Python one-offs that stood up the live fields; superseded by the app's
  `scripts-ts/` but kept as the record of what was run against live.
- `_archive/` — dated subfolders, 50 MB cap, FIFO pruning. See its README. **3.9 MB used, 92% of cap free**
  (9/03: archived `_backup_uncommitted_20260901-162029/` → `_archive/2026-09-03/`; deleted 2 `.DS_Store`;
  nothing pruned). ⚠️ The backup's `sheet-import-run.ts` **differs** from the committed copy — it is the
  9/01 pre-correction snapshot, superseded by `e910292`/`41448d0`. `_now.ts` was byte-identical.
  **9/09:** `_archive/` at **4.7 MB of the 50 MB cap** (91% free), nothing pruned, and **no OS junk
  anywhere in the project** for the **sixth** run running.
  - ✅ **`lrl-grant-reporting/reports/` — CLEARED after FIVE consecutive skips** →
    `_archive/2026-09-09/reports/` (14 artifacts, 692 KB; README explains each). The blocker was never
    the folder, it was the dirty tree; `9d50580` committed `stage-dupe-audit.ts` on 9/08 and the backlog
    unblocked itself. Every file moved is a **pure output** — written with `writeFileSync`, read by
    nothing. Includes the **stale `report-readiness-census.json`**, whose "236 activities / 1 of 8 KPIs"
    figures have been quoted wrongly for a week; getting it out of the working folder is the point.
  - ⚠️ **FOUR files were deliberately LEFT in `reports/` because they are INPUTS, not outputs** — the
    check that found them is the reason the conservative rule exists: `sheet-rows.json` (read by
    `sheet-import-run.ts:60` **and** `grant-award-fill.ts:73`), **`sheet-import-overrides.json`** (read
    at `sheet-import-run.ts:55` — **Zach's own hand-entered review decisions, which nothing
    regenerates**), `gateway-metrics-rows.json` (`gateway-metrics-run.ts:63`), and
    `grant-fields-census.json` (`grant-lineitem-census.ts:75`). The nine 2026-09-08 artifacts were also
    left in place as the current investigation.
  - ✅ **`scripts/preview_business_name.json` — ARCHIVED 9/08** → `_archive/2026-09-08/`, after three
    flagged runs. Its entire contents are `[]` (2 bytes) and
    `backfill_contact_business_name.py:69` regenerates it.
  - ⬜ **THIS DOCUMENT is 1,169 lines / 103 KB and should be condensed a third time.** It was condensed
    on 8/25 and 9/05 and has regrown past both. The instruction it is written against is *"concise —
    a living dashboard, not a log"*, and roughly half of it is now closed-incident narrative that
    `_briefs/` and `CLAUDE.md` already hold. **Not done unilaterally** because the resolved sections are
    where several hard-won API facts live and a bad cut loses them. Suggested cut: move the closed
    incident sections (8/27 loop, 9/02 webhook #3, 9/04 security) to
    `_archive/2026-09-09/PROJECT_STATE-history.md` leaving one-line pointers, after confirming each
    fact they contain is also in `CLAUDE.md`.
  *(9/05: this doc was condensed; pre-condense copy → `_archive/2026-09-05/`.)*
- **`lrl-grant-reporting/reports/` was cleared 2026-08-28** → `_archive/2026-08-28/reports/` (41 one-off
  dry-run / apply / checkpoint / drift artifacts, Jul 31–Aug 19, ~1.2 MB). Only the three current artifacts
  remain in place: `catalog-dump-full.json` (8/21), `identity-audit.json`, `report-readiness-census.json`
  (both 8/27). The folder is gitignored, so nothing tracked moved. Reversible.
