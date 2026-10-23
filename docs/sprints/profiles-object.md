# Sprint spec: Profiles object (Team / EIR / Board) off the contact record

**Status:** BUILDING (2026-10-20). **Decided with Zach 2026-10-20:** website profiles move off contact
custom fields onto a dedicated GHL custom object, `custom_objects.profiles`, associated to the person's
contact. Resources stays its own object. The two objects share the same filter keys so the AI Studio
directory widget treats them identically.

## Why
- The website proxy no longer has to read `/contacts/search` (email, phone, DND, visitor IPs) and
  whitelist its way down. A profile record holds public fields only; the token can drop `contacts.readonly`.
- Contact multi-selects store LABELS, object multi-selects store KEYS. With both directory sources on
  objects, the slug table collapses to one key set.
- Contacts lose ~17 website-only fields. Enrichment already runs on objects (`recordEngine`).
- `source_contact_id` gives a durable back-pointer that survives a contact merge even if the
  association does not (the 10-02 incident: a merge silently dropped Zach's profile fields).

## Schema (permanent parts flagged)
Object key **`custom_objects.profiles`** (PERMANENT, schemas cannot be deleted). Labels Profile / Profiles
(renameable). Primary display property `display_name`.

| key | type | source on contact | notes |
|---|---|---|---|
| display_name | TEXT (primary) | firstName + lastName | |
| profile_status | SINGLE_OPTIONS pending/approved/published/hidden | `contact.status` | same state machine as `resource_status` |
| roles | MULTIPLE_OPTIONS team/eir/board | `contact.website_team_tags` | |
| job_title | TEXT | `contact.job_title` | |
| company_name | TEXT | contact `companyName` | |
| bio | LARGE_TEXT | `contact.biowho_you_are` | |
| linkedin | TEXT | `contact.linkedin` | |
| website | TEXT | `contact.your_website_andor_social_media_handle` | |
| headshot | FILE_UPLOAD | `contact.headshot` | rehosted |
| company_logo | FILE_UPLOAD | `contact.company_logo` | rehosted |
| programs | MULTIPLE_OPTIONS | `contact.programs` | **same option keys as Resources** |
| collectives | MULTIPLE_OPTIONS | `contact.collectives` | **same option keys as Resources** |
| service_areas | MULTIPLE_OPTIONS (29) | `contact.service_areas` | true multi-select (Resources still TEXT) |
| mrl/trl/crl/investor_readiness_stops | MULTIPLE_OPTIONS | same on contact | keys "1".."10" |
| readiness_confidence | SINGLE_OPTIONS high/medium/low | same | |
| readiness_rationale | LARGE_TEXT | same | internal, never public |
| wix_team_row_id | TEXT | `contact.wix_team_row_id` | until Wix is retired |
| source_contact_id | TEXT | contact id | durable link + migration idempotency key |
| rank_* | NUMERICAL | Wix `localDisplayRanking` → `rank_local` | see Ranking |

Association **`profile_contact`** (PERMANENT): contact "Contact" ↔ profiles "Profile". Read the
definition back after creation; never assume sides (`resolveAssociationDef`).

Option keys shared with Resources:
programs `local`, `sales_and_marketing_accelerator`, `manutech_incubator`, `industry_40_accelerator`;
collectives `lean_startup`, `mainstreet`, `manufacturing`.

## Ranking (phase 3)
One NUMERICAL field per placement, on BOTH Profiles and Resources: `rank_our_team`, `rank_local`,
`rank_sama`, `rank_manutech`, `rank_i40`, `rank_lean_startup`, `rank_mainstreet`, `rank_manufacturing`.
Lower = earlier; blank = after all ranked items, alphabetical. GHL stays the source of truth; the
proxy sorts by the placement's field. A new page = one new field on each object. The app gets a
drag-and-drop page per placement that writes ranks (diffed, only changed records written). Resources'
legacy `rank_local__mainstreet` seeds `rank_local` + `rank_mainstreet`.
Wix Team `localDisplayRanking` (100 = unranked) seeds Profiles `rank_local`. `localDisplayRanking1`
differs on 4 rows; its page is unknown (ask Zach).

## Migration (phase 2) — `scripts-ts/profiles-migrate.ts`
Population: every contact with `contact.status` set (44 on 2026-10-20: 43 Published, 1 Pending).
Dry-run → review → apply. Idempotent on `source_contact_id` plus a local ledger. Per contact:
GET the contact (search omits FILE_UPLOAD), map, create the record (options as keys), attach files via
the rehost path, create the `profile_contact` relation, read back and verify every field.
Contact fields are NOT touched or deleted.

## Cutover (later phases, in order)
1. Intake: Become-an-Expert form stays on the contact; a webhook upserts the Profile (contact → profile,
   one owner, one direction). Readiness tagger re-pointed to profiles.
2. Wix Team sync re-pointed from contact to profile (only while Wix still serves pages).
3. AI Studio directory proxy reads Profiles + Resources objects only.
4. ⬜ **OWED: delete the contact profile folder + fields** (tracked in PROJECT_STATE.md with every field id and
   the dependencies that must be re-pointed first). Intake is now a native GHL form that creates the Profile
   directly (Zach 2026-10-21), so no contact → profile sync is planned.
