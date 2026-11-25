# Sprint: Marketing list triggers (ops app)

- **Owner:** Zach Kraabel · **Written:** 2026-11-25 · **Status:** Forms + events deployed 2026-11-25; opportunity + coworking triggers built but OFF
- **Rules source of truth:** `claude/email-playbook.md` (LRL Marketing project). This doc is the build record.
- **Code:** `lib/lists/` + three handler hooks. Tests: `lib/lists/__tests__/` (29).

## 1. What it does

Keeps every GHL contact on the right marketing lists automatically, using the webhooks GHL already sends the app. **No new GHL workflows.** Lists are the "List - X" CHECKBOX contact fields (folder "Marketing Lists", single option "Subscribed"); smart lists filter on them.

Self-service (ticking and unticking lists) is NOT in this app: it is the `/email-preferences` page on the AI Studio website, which loads and saves through the site's own server functions. Email footer link: `https://leanrocketlab.org/email-preferences#id={{contact.id}}`.

## 2. Decisions (Zach, 2026-11-25)

1. All trigger logic lives in the ops app, hooked into existing handlers.
2. **Add-only.** Triggers never remove a list.
3. **Re-add is intended.** A contact who unticks a list and later registers for that program's event, applies, or submits a matching form is put back on it. No opt-out ledger.
4. Optix members are covered by the Co-Working Space pipeline rule.
5. Opportunity-created is covered by the form triggers that create most opportunities, plus the 48h "new opportunity" rule below.
6. Welcome-email trigger links dropped (email scanners would auto-subscribe).
7. Fields are the only source of truth for membership. No tags.

## 3. Trigger map (live ids measured 2026-11-25)

| # | Trigger (existing webhook) | Lists | Rule |
|---|---|---|---|
| 1 | Event registration (`/api/event-registration-sync`) | From the event's Tags in **Event_list_db** | Match GHL event id (parsed from the Embed Code / URL `event-details/<id>`), then exact name. Tags: lean-startup, mainstreet, local, sama, manutech, i40 + manufacturing-tech (= ManuTech), coworking, exit-readiness. Unknown tags logged, not guessed. Event with no tags = no change |
| 2 | Intake survey `IJqdyjwPnCbeiEb0wsat` (`/api/conversion-sync`) | Lean Startup / Mainstreet / ManuTech | **Lean Startup:** "Where are you today?" is idea / researching or prototyping / early product, OR Annual Revenue = 0, OR hobby-to-grow = Yes, OR Date of Incorporation 2025+ (except: 2025+ is the only signal and Mainstreet fits → Mainstreet only). **Mainstreet:** Business Model = service or Both. **ManuTech:** manufactured anything but "Software Only", OR wants Prototyping or Engineering / Manufacturing Resources, OR program interest Industry 4.0 |
| 3 | SAMA Cohort Application form `mWU9Z0cDIii1pz33WK0E` + SAMA Application survey `PKhp7NVOdeXlWI3WHnEx` | SAMA | Always |
| 4 | LOCAL Fellows Application `UXZGE7hDYludF7ZgjE2P` | LOCAL + Mainstreet | Always; LOCAL always implies Mainstreet everywhere |
| 5 | Join a Collective `TzYr5INmfN4QfOQVCk97` | Picked collectives | Lean Startup, Mainstreet, Manufacturing Tech (= ManuTech) |
| 6 | Opportunity stage/status change (`/api/opportunity-sync`) | **OFF for now** (Zach 11-25: deals are created by forms/surveys, which already trigger; re-enable with coworking). When on: by pipeline | Only when the opportunity was **created within 48h** (playbook says "created"; this stops staff cleanups from re-subscribing people). Client Journey `cVtiFjiPXoIqPEkmYG7j` by LRL Program Affiliation: LOCAL → LOCAL + Mainstreet, Sales and Marketing Accelerator → SAMA, ManuTech → ManuTech, Co-Working → Coworking, Gateway → none. LOCAL Fellows Bootcamp `Ewioq7ycVmNpJ9oCM3JC` → LOCAL + Mainstreet. S&MA Cohort `nRK4xQsQ9V4jmXbmz5YO` → SAMA. ManuTech `UFM2Q21TZZYxQCBjcGgt` → ManuTech. Co-Working Space `J7q7yXiSL14Vts7FWJqe` → Coworking |
| 7 | Coffee + Connect | Lean Startup | Via #1 (tagged lean-startup in Event_list_db) |
| 8 | Optix | Coworking | Via #6 |
| 9 | Web Subscribe `nr9JGaC6pYXWMDjp55ly` | None | General only; the contact picks lists on `/email-preferences` |

Rules live in `lib/lists/rules.ts` (form ids, field ids, pipeline ids, tag map in one file).

## 4. Write contract

- **Which form?** GHL's Form Submitted webhook has no form id, and the contact's Latest Attribution is overwritten the moment an Intake submitter books their meeting (every recent Intake submitter reads `medium: calendar`, measured 11-25). The form trigger therefore takes the attributed form PLUS the contact's own submissions from the last 2 hours (`GET /forms/submissions` and `/surveys/submissions` with `q=<contactId>`), and applies every one that has a rule.

- Read the contact; write only missing lists; re-delivery = `noop`, zero writes.
- `PUT /contacts/{id}` with `customFields: [{ id, value: ["Subscribed"] }]` (the app's contact rule; not the handoff's `field_value`).
- Read back; a list not seen on read-back is `unverified` and the result is `error`, never `added`.
- Never removes a list.
- change_log: actorKind `sync`, actorName `lists:form|event|opportunity`, one row per contact write; dry runs log `applied:false`.
- Fault-isolated: each trigger runs after the handler's existing work, catches everything, and returns its result under `lists` in the handler JSON.

## 5. Verification (2026-11-25)

- `tsc --noEmit` clean. 29 vitest tests pass (rules, Event_list_db parsing/matching, writer: add-only, noop, LOCAL→Mainstreet, read-back mismatch, dry run, GHL error).
- Live dry run (no writes): 12 recent Intake submissions + 3 Join a Collective: 14 noop (rules match the 11-25 backfill), 1 would add Lean Startup + ManuTech (submitted after the backfill). Event registrations: 12 of 12 recent registrants matched by event id, all noop. Co-Working Space opportunities from 11-23: 4 would add Coworking. ManuTech pipeline: all noop. Recent Client Journey records carry no Program Affiliation yet (no change).

## 6. Before go-live

| Item | Owner |
|---|---|
| ~~Share Event_list_db with the service account~~ Done 11-25; app reads it | Zach |
| Confirm "Room Booking" opportunities in Co-Working Space belong on the Coworking list | Zach |
| Tag "Old School Tactics: Tried + True with Brandon Bartel" in Event_list_db (it has no tags; playbook says sales/marketing workshops = SAMA) | Zach |
| Commit + deploy | Zach approves |
| After deploy: one real form, one event, one new opportunity; check change_log `lists:%` and read the contacts back | Claude session |

## 7. Not in scope

- Self-service page (AI Studio site). Email-only saves there must be add-only; Zach checking.
- Coworking Waitlist form `TGpvbAtQgrcCB8UXDz3b`: not mapped (not in the playbook). One row in `rules.ts` if wanted.
- Optix one-time backfill of current members without an opportunity.
- Exit Readiness: field exists (`mPvI7CxivJ8e8mbVMpe1`); only the event tag `exit-readiness` maps to it today.
