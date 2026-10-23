# Sprint spec: Resources merged into Profiles (one directory object)

**Status:** DATA LIVE + VERIFIED 2026-10-23 · DEPLOYED (6df0905), live dry runs pass · GHL manual steps open (below).
Follows `profiles-object.md`. Goal: one directory object for staff and for the new website, before launch.

## Decisions (Zach, 2026-10-23)
| Question | Decision |
|---|---|
| How is a resource marked? | New single-select **`profile_type`**: `person` / `resource`. `roles` (Team/EIR/Board) stays, for people only. |
| Companies for unlinked resources | **Exact matches only.** Carry the existing links; add a link only on exactly one normalized-name match, or exactly one website-domain match whose names plausibly agree. Never create a company (the company object has no client/provider field, so a provider would count as a company served). |
| Wix during the transition | **Frozen.** No profile or resource edit reaches Wix until the new site launches. |
| Old Resources object | **Frozen archive.** Relabelled "Resources (Archived)"; webhook, nightly and Wix set off. Delete later. |

## Profiles layout (live)
| Folder | Fields |
|---|---|
| Profile Info (core) | display_name, profile_type, profile_status, programs, collectives, website, company_logo ("Logo"), bio ("Bio / Description") |
| Person Details | roles, job_title, company_name, linkedin, headshot, headshot_url |
| Resource Details | category, sub_category, short_description, public_email |
| [AI] Readiness Tags | service_areas, mrl/trl/crl/investor_readiness/msrl_stops, readiness_confidence, readiness_rationale |
| Page Ranking | rank_* (unchanged) |
| [SYNC] System | source_contact_id, wix_team_row_id, source_resource_id, wix_resource_row_id |

⚠️ **The public API cannot move an existing field between folders** (`PUT /custom-fields/{id}` →
422 "property parentId should not exist"). New fields can be created in a folder; existing ones were
moved in the UI (Settings → Custom Fields → Profile → select → *Move to folder*, which does bulk moves).

## Associations (definitions are permanent; read back 2026-10-23, none swapped)
| Key | Id | First → second | Replaces (archived) |
|---|---|---|---|
| `profile_company` | `6adb83db4d273170ee7dd243` | business → profile | `resource_company` |
| `profile_contact` | `6ad81f751f3a6ce0ea97740a` | contact → profile | `resource_contact` |
| `referral_referred_to_profile` | `6adb83dd63ba7fdb95573cbb` | activity → profile | `referral_referred_to_resource` |
| `milestone_profile` | `6adb83dd3781cf9ae0873369` | milestone → profile | `milestone_resource` |

## Migration (applied + verified)
- `scripts-ts/profiles-resources-setup.ts` — folders, 7 new fields, 2 label renames, 3 associations. Idempotent audit.
- `scripts-ts/profiles-from-resources.ts` — 94/94 resources → profiles; idempotent on `source_resource_id`
  + `reports/profiles-resources-ledger.json`; read-back of every field, logo and relation. Re-run = **94 noop**.
  Relations carried: 27 company, 5 contact, 1 referral, 3 milestone; **17 new company links**; 50 left
  unlinked (no company in the CRM, printed by the script). `--persons` set `profile_type=person` on the 47 people.
- Field map: resources→display_name · resource_status→profile_status · full_description→bio · email→public_email ·
  resource_logo→company_logo · rank_local__mainstreet→rank_local AND rank_mainstreet · service_areas TEXT labels →
  multi-select keys · programs/collectives: **64 of 94 held a comma-joined LABEL string**, mapped to keys.
- Domain matches that were rejected for review: APEX Accelerator → Accelerate Jackson, Start Garden → Grand Rapids
  SmartZone, Michigan Economic Development Corporation → MEDC, Marr Professional Development → Sandler Systems.
- Post-checks: `resources-tag-run.ts` dry run = 93 in scope, **0 writes**; `profiles-tag-run.ts` = 39 in scope (unchanged);
  `readiness-stops-reconcile.ts` = **0 drift** over all 141 profiles.

## Code (uncommitted, on top of the uncommitted MSRL work; 810/810 tests, typecheck clean bar pre-existing blog scripts)
- `resourceTagger` reads/writes `custom_objects.profiles` (service_areas as keys); gate `resource-tagger::custom_objects.profiles`
  = profile_type Resource AND status Approved/Published. `profile-tagger` gate gains profile_type Person.
- `lib/profiles/pipeline.ts` + **`/api/profile-sync`** (new webhook, on the middleware allowlist) — routes by profile_type;
  resource profiles also get the company-link guarantee (`resourceRelations.ts`, now on the profile associations).
- `/api/resource-sync` retired (410, off the allowlist); `runResourcePipeline` stubbed.
- Referral picker searches resource profiles; Resource referrals link via `referral_referred_to_profile`.
- `nightly-resources.yml` → tags resource + person profiles; Wix sync step removed.
- Postgres: old `resource-tagger::custom_objects.resources` row and the "Resources → Wix Resources" set **disabled**.

## Manual GHL steps (Zach) — in this order
1. **Deploy** the app (MSRL phase 1 fields are already live, so the MSRL code is safe to ship with this).
2. **Workflow "Profile Changed"** (custom object Profiles, record created/updated) → Webhook POST
   `https://lrl-grant-reporting.vercel.app/api/profile-sync?recordId={{custom_objects.profiles.id}}`,
   header `x-webhook-secret: <WIX_SYNC_WEBHOOK_SECRET>`. Id in the URL because GHL has dropped custom
   bodies before (memory: ghl-workflow-automation-limits); the handler also deep-scans the standard payload.
   Insert the token with the Custom values picker. Test once with `&echo=1`.
3. **Turn OFF the "Resource Changed" workflow** (and any other workflow, smart list or dashboard on Resources).
4. **Rebuild "Become a Resource" form** on Profiles: contact fields + Profile fields (display_name, category,
   sub_category, short_description, bio, website, public_email, logo, programs, collectives), a hidden
   `profile_type = Resource`, `profile_status = Pending`, association `profile_contact`. The company link is
   added by `/api/profile-sync`. Untested: whether a resubmission duplicates the Profile.
5. Hide "Resources (Archived)" from staff navigation; add saved views on Profiles (People / Resources).
6. Link the 50 unlinked resources to companies by hand where a company should exist.
