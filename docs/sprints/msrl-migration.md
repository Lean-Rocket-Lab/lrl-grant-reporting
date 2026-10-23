# Sprint: Churchill → MSRL (Main Street Readiness Level)

Opened 2026-10-21. Source framework: *Main Street Readiness Level (MSRL)*, LRL Draft v2, October 2026.
MSRL replaces Churchill & Lewis **everywhere Churchill touched**: scorer, Client Stage Tracking record,
company fields, contact fields, Scoring/Intake form, results email, Readiness Map, and the Profiles +
Resources readiness enrichers (new MSRL subway line).

## Locked decisions (Zach, 2026-10-21)

| # | Decision | Consequence |
|---|---|---|
| 1 | **LLM rubric scorer** (not a deterministic checklist) | The model scores D, M, O separately. **Code** computes headline = min(D,M,O), applies the flag cap, formats the label and picks the bottleneck. The model never types the headline. |
| 2 | **Replace Churchill 1:1** | service → MSRL · both → TRL/MRL/CRL + MSRL · tech unchanged |
| 3 | **Delete Churchill after migration** | Archive first (`docs/audits/<date>-churchill-archive/`), then delete. No 1-5 → MSRL conversion. |
| 4 | **Fully automatic for now** | No coach-confirm step, even though the framework says levels 3-6 are coach-scored. Revisit later. |

## Defaults I set (change any of these by saying so)

5. **Path and lens:** the owner's stated answer always wins; when blank the model infers it (default S) and the record says "inferred".
6. **Unknown place flags do NOT cap.** Only a flag the model marks `open` on evidence caps the headline. Capping on unknown would pin every brick-and-mortar client at MSRL 1 until the new site questions are answered.
7. **The flag cap applies to the headline only**, not to the dimension scores (matches "caps the headline level").
8. **Bottleneck ties:** Demand first through level 3, then Model, then Operations.
9. **A Churchill-era prior is shown to the scorer as "first MSRL assessment".** The record's `snapshot_kind` still says Rescore when an older record exists.
10. **MSRL subway stops** (STOP_SERVICES.MSRL in `lib/enrichment/data/readiness.ts`) are my first draft, plus 6 new Main Street services: Bookkeeping & Accounting, Licensing/Permits/Insurance, Site Selection & CRE, Small Business Lending, Hiring & HR, Operations & Procedures. **Brandon should review this**, because it extends his providers-db taxonomy.

## What changed in code (done 2026-10-21, 780/780 tests pass, typecheck clean)

| File | Change |
|---|---|
| `lib/stage/msrl.ts` **new** | Rubric text, lenses, P1-P9 flags, `computeMsrl()` (min + cap + label + bottleneck), `isCommercialSite`, `normalizePath` |
| `lib/stage/companyInputs.ts` | `churchill` dimension → `msrl`; 26 MSRL inputs (10 existing fields + 16 new `business.msrl_*`) |
| `lib/stage/scoreCompany.ts` | Churchill scale/guidance/schema/parse removed; MSRL schema (D/M/O, path, lens, flags, next-rung gaps); `MsrlContext` (stated path/lens, commercial site) |
| `lib/stage/writeStageRecord.ts` | Writes `msrl, msrl_demand, msrl_model, msrl_operations, msrl_path, msrl_lens, msrl_open_flags, msrl_label, msrl_next_milestone` |
| `lib/stage/trigger.ts`, `priorAssessment.ts`, `propagateScoring.ts` | MSRL fields in meta, change log, prior read; contact Churchill fallback removed |
| `lib/stage/portfolio.ts`, `pages/readiness-map.tsx` | Scales `msrl` + the three dimensions (dimensions excluded from "stages moved"); default scale MSRL; table shows the MSRL label |
| `lib/enrichment/data/readiness.ts` + both taggers | 5th line `MSRL`, 6 new services, `msrl_stops` on contact/profiles/resources, Main Street crosswalks in both prompts |
| `wix-embed/readiness-subway-map.html`, `wix-embed/backend/http-functions.js` | Main Street Line (9 stops, rust color) + `msrlStops` column read |
| `scripts-ts/stage-score-run.ts` | MSRL report columns; `--paths service,both` filter for the baseline |
| `scripts-ts/msrl-fields-setup.ts` **new** | Creates every field (dry run by default) |
| `scripts-ts/msrl-churchill-retire.ts` **new** | Archive + coverage gate + delete |

## Intake: TWO new questions, not fifteen (Zach, 2026-10-21)

The first draft added 15 intake questions. Zach rejected it, and he was right. The form gets only:
- **MSRL Owner Path** (`msrl_owner_path`): Sustain or Grow. The owner's choice, which can't be inferred.
- **MSRL Owner Goals** (`msrl_owner_goals`): income wanted, plus the hours and seasons they want to work.

Everything else is inferred by the scorer from answers intake already collects (description, where they
are today, revenue, paying customers, financial statements, cash flow, FTE, owner involvement,
management, footprint, locations, NAICS, founded date). Lens and site flags are inferred too, and only
stored on the stage record.

## ✅ Phase 1 DONE 2026-10-21: 22 fields created + read back

- business_stage, folder "Main Street Readiness (MSRL)": 9 fields
- business, folder "Main Street Readiness (MSRL)": 2 intake + 7 current-score fields
- profiles + resources: `msrl_stops`; profiles `service_areas` 29 → 35 options (all 29 kept)
- contact: `msrl_owner_path`, `msrl_owner_goals`, placed in the intake folder next to `owner_involvement`.
  No contact `msrl_stops`: those contact fields are being retired with the profile folder.
- ⚠️ The readiness tagger still writes CONTACT stop fields, so EIR MSRL stops need the tagger re-pointed
  to `custom_objects.profiles` (already owed from the Profiles migration).

## Live rollout (order matters)

⚠️ **Do not deploy the code before phase 1.** The scorer would POST `msrl_*` properties to a
business_stage object that doesn't have them yet.

**Phase 1: fields.** `tsx scripts-ts/msrl-fields-setup.ts` (dry run) → review → `--apply`. Creates:
- business_stage: 9 fields · business: 15 intake + 7 current-score fields
- profiles + resources: `msrl_stops`, plus the 6 new `service_areas` options on profiles (read-append-readback; resources' service_areas is TEXT)
- contact: 15 intake fields + `msrl_stops` + 6 `service_areas` options. **Read the printed keys**; GHL derives contact keys from the name.

**Phase 2: wiring.**
1. Mapping rows: 15 UP (contact → business, form owns them) and 7 `company-current-scoring` rows (business_stage → business). Use the keys phase 1 printed. Dry-run `/api/sync/up?dryRun=1` on one company before trusting it.
2. **Disable** the Churchill `company-current-scoring` rows and the Churchill `company-to-contacts` rows.
3. Wix: add `msrlStops` (ARRAY_STRING) to the Team and Resources collections, add the two Wix mapping rows, confirm each set's gate is unchanged, publish `http-functions.js` and the updated embed HTML.
4. GHL forms (manual, no write API): add the MSRL questions to the Scoring Form and the Client Re-Scoring form; remove the Churchill-only questions you no longer want. Results email: swap `churchill_current` merge fields for `msrl_label_current` and `msrl_next_milestone_current`, and change the send condition to `msrl_current` / `trl_current` not empty.

**Phase 3: deploy.** Push → Vercel. Enricher config cache is 10 min per lambda.

**Phase 4: baselines.**
1. `stage-score-run.ts --paths service,both` (dry run) → review the CSV → `--apply --yes`. ⚠️ Both-path companies also re-roll TRL/MRL/CRL in that call (the September variance finding). Read the tech deltas in the report before applying.
2. Re-classify directory entries so the new Main Street tags can land: `readiness-tag-run.ts` and `resources-tag-run.ts` (LLM). `--rederive` alone places nobody on MSRL until an entry carries one of the new tags.

**Phase 5: retire Churchill.** `msrl-churchill-retire.ts` (dry run writes the archive and lists gaps) → disable any remaining mapping rows/Wix columns → `--apply --yes`. Refuses if any Churchill-scored company has no MSRL yet.

## Reporting (framework "Reporting" row)

The Readiness Map covers headline intake → now and per-dimension movement. **Not built yet:** count clearing MSRL 6 and the S/G mix as KPIs (the data is on the record: `msrl`, `msrl_path`).

## Open questions for later

- Coach-confirm workflow for levels 3+ and a second-staff countersign for 7-9 (decision 4).
- Site-flag questions only matter for commercial sites. Show them conditionally on the form (`physical_footprint` = Brick and mortar / Office location).
- `parseStageNotes.ts` still parses old Churchill notes for the history backfill. It is historical only, so it was left as is.
