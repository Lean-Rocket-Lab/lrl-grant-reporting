# Domain switch + company-field forms — findings 2026-10-13

Context: GHL shipped "Automatic Company Creation & Association by Email Domain" (Labs). Zach enabled it
2026-10-13 ~10:00 ET. Goal: move form answers onto Company records directly and retire the
contact⇄company sync. Audit artefacts: `docs/audits/2026-10-13-domain-switch/`.

## What was verified LIVE (three clean-browser tests, all records deleted afterwards)

| Test | Setup | Result |
|---|---|---|
| B | New contact, new domain, Company fields on form | ✅ contact created with **0** contact custom fields; company created `createdBy: FORM`, all values on the company, contact associated (`businessId` + `BUSINESSES_CONTACTS_ASSOCIATION`); scorer created a `business_stage` record within 30s. ❌ `domainname` NOT filled by the domain automation. |
| A | **Existing** contact (already linked to "Lean Rocket Lab"), exact company name typed | ❌ GHL created a **duplicate "Lean Rocket Lab"** with no associations; the real company untouched. |
| C | Contact that test B created, resubmits with the identical name | ❌ **Another** duplicate, no association. |

**Rule learned: a GHL form with Company fields creates a NEW company on every submission from an
existing contact.** It only matches/associates when the contact is new. There is no "match existing
company" option on the form, on the company Name field (only `Hidden` + query key `company_name`),
or in form Settings. The domain dedupe cannot help because form-created companies get no domain.

Consequence for the six forms:
- **Intake Form, SAMA Application, LOCAL Fellows Application** (first-contact): Company fields are
  SAFE. Rebuild these.
- **Client Stage Re-Scoring, Client Reporting Form, LOCAL Milestone Form** (returning clients):
  Company fields are UNSAFE as-is. Keep contact fields + a one-way contact→company copy for these,
  OR find a GHL mechanism that targets the existing company (open question: does adding
  `business.domainname`/`website` to the form make GHL match the existing company? untested).

The Re-Scoring form was rebuilt with company fields (v5), tested, and **restored to v4 as v6**. It is
live in its original shape. `zach+intaketest@leanrocketlab.org` was overwritten by a sticky-contact
submission and restored from the baseline snapshot.

## Builder mechanics learned (saves hours next time)
- The builder is a cross-origin iframe: screenshot-driven only.
- Drag-reorder on the canvas does NOT work under automation (leaves a stuck ghost; reload to discard).
  Panel→canvas drag DOES work (Text, Submit). Clicking a Quick Add tile does nothing.
- "Add Object Fields" inserts **right after the selected element**; with a field selected, successive
  adds chain in order; with a Text element selected they insert in REVERSE. The "+" under a selected
  element opens the panel with that insert point.
- Adding any company field auto-appends a required `business.name` ("Company Name") field.
- Deleting a field with a condition prompts; the condition is deleted with it. Conditions use
  **"Hide Fields"** (plural) for multi-select; "Hide Field" replaces instead of adding.
- Public form has Cloudflare Turnstile: headless Playwright cannot submit. Test from Zach's Chrome
  after clearing `localStorage`/cookies on go.leanrocketlab.org (sticky contact lives there), and
  ALWAYS verify via API that the contact `dateAdded` is today.
- Company `domainname` is writable via legacy `PUT /businesses/{id}` and is UNIQUE (409 on clash).

## Sync-engine observation
A `company-to-contacts` batch (trigger null, 264 writes) ran 14:43–14:49 UTC, ~40 min after the GHL
backfill touched 1,032 companies. Several writes moved contact dates to values the company holds
(e.g. Jacob Cross `date_of_incorporation 2016-09-28 → 2026-09-14`, `lara_id → 0`) — the company
records hold worse data than the contacts for those fields. Not caused today; surfaced today.

## Addendum 2026-10-13 PM — the domain-field experiment (scratch form, deleted after)
Form = email + `business.domainname` + `business.name` + `business.where_are_you_today`.
| Test | Result |
|---|---|
| New contact, domain `lrldomtest.com` | ✅ company created WITH the domain, associated. |
| Same contact resubmits, same domain, new value | ❌ **Form silently refuses to submit** — no network request, no error, client sees nothing. Existing company untouched. |
| Same contact, different domain | ❌ duplicate company created (as before). |
**Verdict: putting Domain on the form does NOT make GHL update the existing company. It converts
the duplicate into a silent submit failure.** Worst of the three outcomes for returning clients.
Domain on first-contact forms IS worthwhile (company gets its match key at creation).

## Re-test 2026-10-19 — after GHL support's "forms aren't submitting" fix
Scratch form `ZZ Domain Test (delete me)` (`xemiR2eqbDzP8NIgeU2a`, deleted after), same shape as 10/13:
email + `business.domainname` + `business.name` + `business.where_are_you_today`. Cleared storage first.
| Test | Result |
|---|---|
| New contact `zach+domtest2@`, domain `lrldomtest2.com` | ✅ company created with domain, associated, `where` written. Same as 10/13. |
| Same contact resubmits, same domain, new `where` value (tried twice, incl. after hard reload) | ❌ **Still a silent submit failure** — only the Turnstile ping fires, no `/forms/submit` request, no console error, no submission recorded, company unchanged. |
| Same contact, different domain `lrldomtest3.com` | ❌ submits, but creates a **duplicate company** (no association); existing company unchanged. |
**Verdict: GHL's fix did not change the behaviour we care about.** The "fix" at most covers something
else; a form still cannot update an existing company for a returning contact. **No-go** for putting
Company fields on returning-client forms (Re-Scoring, Client Reporting, Milestone). Proceed with the
agreed fallback: Company fields + hidden Domain on first-contact forms only (Intake, SAMA, Fellows);
contact fields + slim one-way contact→company copy on returning-client forms; retire the
company→contacts down-sync; weekly dedupe runner.
Cleanup done: contact `fiUqPBFxqLLnNp25Y12Q`, companies `6ad65155…4d28` and `6ad6520e…5afb`, scratch
form, and the leftover `Form 22 - TEST` from 10/13 all deleted. No stage records were created.
