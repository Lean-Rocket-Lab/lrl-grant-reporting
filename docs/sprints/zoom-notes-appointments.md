# Brief — Zoom AI Companion notes → GHL appointment → Activity

> **Written 2026-09-03**, from **live probes of both APIs on the same day**, not from docs alone.
> Parent sprint: `sprint-d-capture-completeness.md` (item 7).
> Zach's ask: *"grab those notes, get them on the appointment, update the appointment status (Attended
> or no showed), before we create the actual activity."*
> Requirement added by Zach 2026-09-03: **"it needs to work for anyone on the team with a Zoom account
> connected to GHL"** — not just his own meetings. §3 is that requirement, and it is the whole risk.

## 0. Scope, and how to prove it out

**Scope (Zach, 2026-09-03):** *"get meeting notes/summary for all zoom meetings scheduled with GHL
Appointment links."* So **the GHL appointment list is the driver, not the Zoom meeting list.** We already
fetch appointments; each one that carries a Zoom id in `address` is a row to enrich. Meetings with no GHL
appointment are out of scope entirely. That simplifies things — no Zoom-side sweep, no reconciliation of
two lists, and the unit of work is one we already have an id for.

**Also settled:** the summary is what decides `showed` / `noshow` (§2).

### A — Zach's hands: the Zoom app (~30 min, needs Zoom account admin)

> ✅ **CLEARED 2026-09-09 — the app exists, the admin credential works, and §0.A step 3 PASSED.**
> The 9/03 blocker (S2S greyed out, needing the **"Zoom for developers"** role privilege from the account
> OWNER) is retired. `ZOOM_ACCOUNT_ID` / `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` /
> `ZOOM_WEBHOOK_SECRET_TOKEN` are in `.env.local`.
> ⬜ Still owed in **Vercel** and **GitHub Actions secrets**.
> **Measured results are in §1b. Read that before §3 — §3's risk did not materialise.**

1. Zoom Marketplace → **Develop → Build App → Server-to-Server OAuth**. Note **Account ID**, **Client
   ID**, **Client Secret**.
2. **Add scopes.** Ask for these, in this order — the first two are the ones reported missing:
   - `meeting_summary:read:admin` *(or the newer `meeting:read:summary:admin`)* — the summary body
   - `meeting:read:admin` — meeting + past-instance lookup
   - `report:read:admin` *(or `dashboard_meetings:read:admin`)* — participants, the attendance fallback
3. 🔴 **The one assertion that decides the design.** Call
   `GET /v2/meetings/meeting_summaries?from=2026-08-01&to=2026-09-03` and check the response contains a
   meeting **hosted by someone other than Zach**. That is the whole team-coverage test from §3.
   - **Passes** → build as specified.
   - **Fails, or the scopes aren't in the picker** → stop and pick a fallback from §3 before writing code.
     Do not quietly ship a Zach-only version.

### B — One read-only spike script, zero writes (`scripts-ts/zoom-probe.ts`)

Everything here is measurement. It must not write to GHL or Zoom.

| # | Measure | Pass bar |
|---|---|---|
| 1 | **Coverage** — of past GHL appointments in the last 90 days, how many carry a Zoom id, and how many resolve to a real Zoom occurrence? | ≥90% of Zoom-linked appointments resolve. Below that, find out why before building |
| 2 | **Host spread** — how many resolve for hosts *other than Zach* | >0, or §3 has failed |
| 3 | **Attendance signal** — for each match, does `GET /past_meetings/{uuid}/participants` return real participants, and does the summary footer list an `(External)` attendee? | pick whichever is present ≥95% of the time |
| 4 | **Note length** — distribution of `summary_plain_text` and of `recap + next steps` alone | confirms the §4 truncation rule holds across real meetings, not just the two probed |

**The resolver, with the traps:** `address` → meeting number → `GET /v2/past_meetings/{number}/instances`
(returns every ended instance with its UUID) → pick the instance whose start time matches the
appointment's date → use that **UUID** for everything downstream.
⚠️ **A UUID that starts with `/` or contains `//` must be DOUBLE URL-encoded**, or Zoom answers
*"Meeting does not exist"* — a wrong-looking error for a right-looking id.

### C — One GHL write probe, on a throwaway appointment (`scripts-ts/ghl-appointment-write-probe.ts`)

Create a test appointment on a test calendar, then, reading back after every step:

1. `POST /calendars/appointments/{id}/notes` → does it persist; capture `note.id`.
2. `Update Note` with that id → does it update in place rather than adding a second note.
3. `PUT /calendars/events/appointments/{id}` sending **only** `{appointmentStatus:'showed', toNotify:false}`
   → **then GET the appointment and confirm `title`, `startTime`, `endTime`, `address` and `calendarId`
   all survived.** This is the `writeRecordFields` lesson: assume nothing about partial updates.
4. Confirm `toNotify:false` really suppressed automations — no appointment webhook delivery, no
   `change_log` row from a re-ingest.
5. Re-run 1–3 unchanged → everything reports **`noop`**.

### D — What "proven" means

All of: the team assertion in A passes · ≥90% appointment→meeting resolution · one attendance signal is
reliably present · a partial `PUT` preserves the other fields · `toNotify:false` fires no automation ·
and a second identical run writes nothing. **Only then** wire it into the nightly ahead of the
appointment adapter.

---

## 1. What was measured live today

**The summaries are real, rich, and already being generated.** Pulled the actual AI Companion summary
for *"Zach Kraabel <> Aveek Das | i4.0 Accelerator"* (2026-09-02, meeting `92190173241`). It contains a
quick recap, **next steps with owners**, six sectioned summary paragraphs, both `summary_markdown` and
`summary_plain_text`, a `summary_doc_url`, and a trailing attendee line with roles
(*"Zach Kraabel (Organizer), Aveek Das (External)"*).

**Three findings that change the design:**

1. **No cloud recording and no transcript are involved.** Across 15 meetings in Aug–Sep, every one has
   `has_recording: false` and `has_transcript: false`, and almost every one has `has_summary: true`.
   `recordings_list` for the whole month returns **0 records** — that is *expected*, not a problem, and
   anyone who checks recordings first will wrongly conclude this is dead. **The summary is the asset.**
2. **The join key is confirmed on both sides.** Zoom returns `meeting_number: 92190173241`; that is the
   same numeric id `zoomMeetingId()` already parses out of the GHL appointment `address`, and it is
   already stored — `zoom_meeting_id` is **15/15** on TA activities.
3. ⚠️ **`meeting_number` is NOT unique per occurrence.** The recurring *"S&MA LVL10 Meeting"* returns
   `99387743679` for **both** 8/21 and 8/28, with different `meeting_uuid`s. So the join must be
   **`meeting_number` + the appointment's date**, resolved to a **`meeting_uuid`**, and every downstream
   read must use the UUID. Joining on the number alone will attach the wrong week's notes to a meeting
   and it will look completely plausible.

## 1b. Measured live 2026-09-09 on the S2S ADMIN credential — the gate is passed

Every number here came from the real app credential, not a Claude-session connector, so it speaks to what
the deployed app can do.

**Scopes granted (8):** `meeting:read:summary:admin` · `meeting:read:list_summaries:admin` ·
`meeting:read:list_past_instances:admin` · `meeting:read:past_meeting:admin` · `meeting:read:meeting:admin` ·
`meeting:read:list_past_participants:admin` · `dashboard:read:list_meeting_participants:admin` (+`:master`).

⚠️ **The classic scope names in §0.A no longer exist in the picker.** `meeting:read:admin` and
`report:read:admin` are **classic**; new apps get **granular** scopes, one per endpoint. Anyone re-reading
§0.A will hunt for names that are gone.
⚠️ **Listing summaries is its OWN scope.** `meeting:read:summary:admin` reads a summary body but the list
endpoint 400s with `does not contain scopes:[meeting:read:list_summaries:admin]`. Two scopes, not one.
❌ **`report:read:list_meeting_participants:admin` was NOT available** (needs the Reports role privilege).
Not needed — the `meeting:read:list_past_participants:admin` variant covers it.

### ✅ 1. TEAM COVERAGE — the assertion in §0.A step 3, PASSED
`GET /v2/meetings/meeting_summaries?from=2026-08-10&to=2026-09-09`, fully paginated: **571 summaries**
across 2 pages, hosted by **four** LRL staff.

| Host | Summaries (trailing 30d) |
|---|---|
| zach@leanrocketlab.org | 289 |
| alex@leanrocketlab.org | 228 |
| sierra@leanrocketlab.org | 53 |
| ken@leanrocketlab.org | 1 |

**This is the whole design fork, resolved. Build as specified.** Alex's 228 are largely
*"Zoom Meeting with <name> | Lean Rocket Lab Intake Meeting"* — exactly the grant-reportable appointments
a Zach-only credential would have silently returned nothing for.

⚠️ **`page_size=300` is the cap, and `total_records` reported 300 on page 1 when the true count was 571.**
Anything that reads page 1 only under-reports by ~half and looks entirely plausible. Always follow
`next_page_token`.

### ✅ 2. The full chain works for a NON-ZACH host
`"Zoom Meeting with Vihar Patel | Lean Rocket Lab Intake Meeting"` (Alex, 9/09, id `94283456971`):
`past_meetings/{number}/instances` → UUID → `meetings/{uuid}/meeting_summary` → **200**.

### ✅ 3. ATTENDANCE IS STRUCTURED — do NOT parse the prose
`GET /v2/past_meetings/{uuid}/participants` → **200**, 3 records:
`Alex Masten <alex@leanrocketlab.org>`, `Vihar Patel <no-email>`, `Vihar Patel <no-email>`.

**This overturns the ⬜ in §2.** The 9/03 finding that participants "did not come back" was measured on the
Claude-session connector; on the app's own S2S credential the endpoint the adapter's header always assumed
**does** return real participants. The fragile attendee-footer parse is **abandoned**.

⚠️ Two traps in that payload:
- **External guests have an empty `user_email`.** So "external" = email absent OR not `@leanrocketlab.org`.
  Never key off email domain alone — every external attendee would be invisible.
- **A rejoin produces a duplicate row** (Vihar appears twice). **Dedupe by name before counting**, or a
  solo host who dropped and rejoined reads as two attendees and scores a false `showed`.

❌ **Dashboard participants is a DEAD END — plan-gated, not scope-gated.**
`GET /v2/metrics/meetings/{uuid}/participants` returns *"only available for ZMP and Business or higher
accounts that have enabled the Dashboard feature."* The scope grants fine and the data never comes.

### ✅ 4. The summary is STRUCTURED — §4's truncation rule is largely obsolete
Discrete fields, not one markdown blob: `summary_overview` · `summary_details` (array) ·
**`next_steps` (its own array)** · `summary_doc_url` · `summary_title` · `meeting_host_email` ·
`meeting_uuid` · `meeting_id` · start/end times.
Vihar/Alex: 8 next steps, 851-char overview, 8 detail sections. Aveek/Zach: 3,240 chars total.

**The GHL note is ASSEMBLED from fields, not sliced out of prose** — `summary_overview` + `next_steps`
verbatim, then the `summary_doc_url`. The 5,000-char cap stops being the normal case. §6b still applies to
`summary_details` prose: human context, never a source of structured facts.

### Scope call from Zach, 2026-09-09
> *"On attendance I mostly care about being able to say yes this meeting happened or no this meeting did
> not happen so we can mark it correctly in the GHL appointment."*

"Did it happen" is answered by whether a Zoom occurrence exists — `past_instances`, already proven for a
non-Zach host. Participants are the **upgrade**: they separate "the meeting ran" from "the client was in
it," and a session where only the host dialled in is not service delivered.
⚠️ **The three-way rule in §2 still stands and must not collapse into two** — see the table there. Row 3
(no occurrence → leave the status alone) is the safety rule.

## 2. The sequence, and why the order is the point

1. Resolve the appointment's `zoom_meeting_id` + date → the Zoom `meeting_uuid` for that occurrence.
2. Fetch the summary and the participant list for that UUID.
3. **Write the note onto the GHL appointment** (`POST /calendars/appointments/:id/notes`).
4. **Set `appointmentStatus` to `showed` or `noshow`** (`PUT /calendars/events/appointments/:id`).
5. **Then** run the appointment adapter, which ingests the activity from the now-correct appointment.

**Step 4 before step 5 is not cosmetic — it fixes a live over-count.** The adapter's measured reality is
that `showed` is set on only **2 of 140** appointments, so it treats *"confirmed and the start time has
passed"* as held. **Every unmarked no-show is currently ingested as a held TA activity.**
`NON_EVENT_STATUSES` already excludes `noshow`, so the moment Zoom truth sets that status, those records
stop being created. **This is a D2 label-correctness fix, not just enrichment** — it makes TC KPIs 7/8
count meetings that actually happened.

**Attendance rule.** The adapter's own header already reasoned this out: *"`past_meetings/{id}` exists
only if the meeting actually happened, which is a far better attendance signal than the status field."*
Concretely:

**Zach's call: the summary decides it.** A summary only exists for a meeting that actually ran, and its
footer names who was in it — so summary-plus-external-attendee is direct evidence the client showed.

| Zoom evidence | Write |
|---|---|
| occurrence exists **and** a non-host / `(External)` attendee is present | `showed` |
| occurrence exists but **only the host** appears | `noshow` |
| **no Zoom occurrence at all** for that id + date | **leave the status alone** |

**The third row is the safety rule and it should not be softened.** No Zoom occurrence can mean the
client no-showed — or that the meeting moved to a phone call, ran in person, or used someone's personal
room. Writing `noshow` on absence of evidence would push the activity into `NON_EVENT_STATUSES` and
**silently delete a real, funder-reportable meeting from the grant count.** Wrong `showed` is a bad row
someone can spot; wrong `noshow` is a row that never appears. Leave those for a human, and surface them
to `sync_review` rather than letting them sit invisible.

⚠️ **`participants` did NOT come back on either meeting probed** (Aveek Das 9/02, Joe Marr 8/31). The
tool advertises the field; two for two, it is absent on these non-recorded meetings. **Both** summaries
did, however, end with a reliable attendee line:

```
**Attendees:** Zach Kraabel (Organizer), Joe Marr (External)
```

So today the only observed attendance signal is **prose at the end of the markdown**, which is a fragile
thing to parse and a bad thing to depend on. ⬜ **Before building attendance, establish a real source:**
try `GET /past_meetings/{uuid}/participants` on the app's own S2S credential (a different endpoint from
what this connector exposes, and the one the adapter's header always assumed). If that returns real
participants, use it and ignore the prose. **If neither yields structured participants, ship notes
without attendance** rather than parsing an AI-written sentence into a `noshow` that suppresses a
funder-reportable activity. Wrong `noshow` = a real meeting silently deleted from the grant count.

## 3. ~~🔴 THE RISK~~ ✅ RESOLVED 2026-09-09: team coverage WORKS on the admin credential

> **Kept for the reasoning; its conclusion is superseded by §1b.** The fear was that the summary admin
> scopes would be missing from the S2S picker. They were present, they were granted, and the list endpoint
> returns meetings hosted by Alex, Sierra and Ken as well as Zach. **The per-user OAuth fallback is NOT
> needed.** What follows is the 9/03 user-token measurement that motivated the worry.


**Measured today, and it is exactly the constraint Zach named.** In the same result set:

| Meeting | Host | `has_summary_permission` |
|---|---|---|
| S&MA LVL10, i4.0 Touch Base, Aveek Das, Joe Marr, Signal-Wise … | **Zach** | ✅ `true` |
| "Brandon Marken's Zoom Meeting" | Brandon | ❌ **`false`** |
| "AGS><Harvest Solar Updated" | Sierra Sibson | ❌ **`false`** |

**A user-level token only reaches meetings that user hosted.** When a team member's GHL calendar link
books a meeting, *that member* is the Zoom host — so a Zach-scoped credential would silently return
nothing for their meetings. Not an error; just no notes and no attendance, on exactly the appointments
the grants care about.

**Team coverage therefore requires an account-level (admin) credential** — and this is where it may
snag. Zoom's own developer forum has open threads **into 2026** reporting that the summary admin scopes
(`meeting_summary:read:admin`, `meeting:read:summary:admin`) **do not appear in the Server-to-Server
OAuth scope picker**, and that requesting them yields *"Invalid access token, does not contain scopes"*.
Reported workarounds: `GET /v2/meetings/meeting_summaries` (list) works, and the summary body reads from
the endpoint **without** the `/accounts/{accountId}` master segment.

> ### ⬜ DO THIS FIRST — a 30-minute spike, before any code
> 1. In LRL's Zoom account, create a **Server-to-Server OAuth** app.
> 2. **Look for the summary admin scopes in the picker.** Whether they are there decides the whole design.
> 3. Call `GET /v2/meetings/meeting_summaries` for a date range and check it returns meetings hosted by
>    **someone other than Zach** — that single assertion is the team-coverage test.
> 4. Then fetch one summary body by UUID.
>
> **If the admin scope is unavailable, say so plainly rather than building a Zach-only version.** The
> fallbacks, in preference order: (a) a Zoom **Marketplace/user-level OAuth app that each staff member
> authorizes once**, storing a per-user refresh token keyed to their GHL user id — more setup, but it is
> genuinely per-team-member and does not depend on the missing admin scope; (b) Zoom support/admin
> enablement of the scope on the account; (c) ship it Zach-only and declare the coverage gap in
> `capture-coverage.ts` rather than leaving it invisible.
>
> **Note which account is being tested.** The connector used for today's probe is a Claude-session
> connector on Zach's identity. It proves the *data* exists and is good; it proves **nothing** about
> team-wide API access, and it is not something the deployed app can call (§5).

## 4. The GHL write side — endpoints confirmed, with three traps

**Notes** — `POST /calendars/appointments/:appointmentId/notes`, body `{ userId, body }`, response 201
with `note.id`.

- 🔴 **`body` is capped at 5,000 characters, and real summaries already exceed it.** Measured on two
  meetings: Aveek Das (2 people, 15 min) ≈ **3.9k — fits**; **Joe Marr (2 people, 28 min) ≈ 8k — does
  not**, at roughly 1.6× the cap, with a recap, 4 next steps and 8 sections. A one-hour group session
  will be worse. **So truncation is the normal case, not the edge case.**
  **Rule: write `## Quick recap` + `## Next steps` verbatim, then a link to `summary_doc_url`** for the
  sectioned body. Those two blocks are the part a staffer actually re-reads, they are first in the
  document, and they fit comfortably. Never hard-cut at 5,000 — it would sever a next step mid-sentence.
- ⚠️ **A note is its own resource with its own id, and `Create` appends.** Running this twice creates a
  second note, forever — the same shape as the multi-select bug that rewrote 57 referral records on
  every run. **There must be a `noop` path:** record the note id (claims ledger, keyed like every other
  source) and use `Update Note` on re-run. A write path that cannot report `noop` is broken.
- `userId` should be the **assigned GHL user**, so the note is attributed to the staffer who ran the
  meeting rather than to a service account.

**Status** — `PUT /calendars/events/appointments/:eventId`, `appointmentStatus` ∈
`new · confirmed · cancelled · showed · noshow · invalid · completed · active`.

- 🔴 **`toNotify` defaults to `true` — "if set to false, the automations will not run."** Updating a
  status with the default therefore **fires GHL workflows**, including the appointment webhook, which
  re-ingests the activity. That is the 8/27 incident's shape in miniature. **Always send
  `toNotify: false`.**
- ⚠️ **The PUT body also carries `calendarId`, `startTime`, `endTime`, `title`, `address`.** Whether
  omitted fields are preserved or cleared is **unverified**, and this is precisely the class of bug that
  `writeRecordFields` taught: *the caller must diff.* **Probe on a throwaway appointment** — send only
  `{appointmentStatus, toNotify:false}`, then read the appointment back and confirm the time, title and
  address survived. Do not run this against a real client booking until that is proven.
- **Verify by reading back**, and report `skipped` rather than `applied` if the value did not persist.
  Several GHL fields accept a write, return 200 and store nothing.

## 4b. ✅ §0.C GHL WRITE PROBE — RUN 2026-09-10 IN SANDBOX, all four questions answered

> Run against **SANDBOX - Lean Rocket Lab** (`Dw6bZusRZr3K71z5STe7`). All artifacts deleted afterwards
> (probe appointment, probe calendar, probe contact).

**Setup trap, budget a few minutes for it:** every calendar in the sandbox snapshot is `isActive:false`
**and has an empty `teamMembers` array**, so `create-appointment` → `400 Calendar is inactive`, and
`update-calendar {isActive:true}` → `400 No team member found` (you cannot activate your way out). The
sandbox has exactly **one** user (`LSSCwaIxE5roQLc6mk1L`) and `search-users` requires `companyId`
(`eRXQp1ekNvK2YCINcdJg`, from `get-location`). Working path: create a throwaway `personal` calendar with
that user as its single team member, probe on it, delete it.

### ✅ Notes persist and the note id is stable
`POST /calendars/appointments/{id}/notes` → **201** with `note.id`; `GET` reads it back verbatim. The
5,000-char `body` cap is confirmed in the operation schema.

### ✅ `Update Note` edits IN PLACE — the noop path is viable
`PUT .../notes/{noteId}` → **200**, and a follow-up `GET` returns **exactly one note**, new body, original
`dateAdded`. §4's plan holds: **store `note.id` in the claims ledger and update it on re-run.** No
duplicate-note failure mode, provided the id is persisted.

### ✅ THE BIG ONE — a partial PUT does NOT clear omitted fields
Sent **only** `{appointmentStatus:'showed', toNotify:false}`; read back afterwards:

| Field | Before | After |
|---|---|---|
| appointmentStatus | confirmed | **showed** |
| title | PROBE - Zoom Meeting with… | unchanged |
| startTime | 2026-09-09T10:00:00-04:00 | unchanged |
| endTime | 2026-09-09T10:25:00-04:00 | unchanged |
| address | https://us02web.zoom.us/j/92190173241 | unchanged |
| calendarId / contactId / assignedUserId | — | unchanged |

**§4's warning is retired: the status writer does not need to echo back the whole appointment.** Send the
two fields and nothing else. (The API returns BOTH `appointmentStatus` and the misspelled
`appoinmentStatus` — read the correctly spelled one, but do not be surprised by the twin.)

### 🔴 GHL does NOT no-op an unchanged status — the CALLER must diff
Re-sent the byte-identical PUT: 200, and **`dateUpdated` moved 12:07:15 → 12:07:25**. This is the
`writeRecordFields` lesson on a new endpoint: **an unchanged re-delivery still rewrites the record.** The
status writer must read the appointment first and skip the PUT when `appointmentStatus` already equals the
target, or the nightly churns every Zoom-linked appointment every night and `noop` is unreachable. Same
rule for the note body.

### ⬜ What the sandbox could NOT answer
**Whether `toNotify:false` actually suppresses LRL's LIVE automations.** The sandbox has none of the live
workflows, so a clean run there proves nothing. The flag was accepted on every call, but the real test is
**one live appointment, watched for a webhook delivery and a `change_log` row** — done deliberately,
before any backfill.

**Verdict: §0.D is met except the `toNotify` live check. Build-order steps 3 and 4 are unblocked**, both
with an explicit read-before-write diff.

## 5. Where this runs — the app needs its own Zoom credentials

`.env.local` currently holds no `ZOOM_*` anything. The connector used for today's probe is a
Claude-session tool and **the deployed Vercel app cannot call it**. Sprint D's bar requires *"a live
source that has ingested a real record in the trailing 30 days"*, so a human running a Claude session
does not clear it.

So: a Zoom app of our own, with `ZOOM_ACCOUNT_ID` / `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` in
**`.env.local`, Vercel, *and* GitHub Actions secrets** — all three. ⚠️ Two hazards already on record:
the nightly workflows died for two runs on a bare `readFileSync('.env.local')` that does not exist on a
GitHub runner, and a stale `WIX_API_TOKEN` secret broke a nightly on 9/01. Same trap, twice.

**Trigger: extend the existing nightly.** Poll `GET /v2/meetings/meeting_summaries` over a trailing
window inside `nightly-activities.yml`, ahead of the appointment adapter so the ordering in §2 holds.
Zoom does emit a summary-completed webhook, and it is the better long-run answer, but the nightly job
already exists and summaries are not time-critical.

✅ **CLEARED 2026-09-04 — the runner is healthy.** This brief said the workflow had never completed a
green run; that was true when written and is not any more. Checked against the Actions API:

```
nightly-activities   #5 2026-09-04 success   #4 09-03 success   #3 09-02 success (dispatch)
                     #2 09-02 failure        #1 09-01 failure
```

Run #5's own output — `appointments: 2 noop, 2 skip:cancelled` and `opportunity stages: 147 noop,
176 skip:no-route` — is a clean all-noop night, so it is genuinely doing the work rather than exiting
0 early. `nightly-resources` recovered the same way; `square-netsales` failed only its 09-01 scheduled
run, was fixed by dispatch the same day (#5, #6 green) and then hardened with a credentials preflight.
**Nothing is blocking this brief from the runner side.**

⚠️ **But the schedule comments in every workflow are fiction.** GitHub defers scheduled runs on this
repo by a consistent **~4–4.5 hours**:

| Workflow | cron | actually starts |
|---|---|---|
| nightly-score | 06:30 | ~11:33 |
| nightly-reconcile | 07:00 | ~11:54 |
| nightly-enrich | 08:00 | ~12:29 |
| nightly-readiness | 08:30 | ~12:48 |
| nightly-resources | 08:45 | ~12:55 |
| nightly-activities | 09:15 | ~13:31 |

**The relative ORDER survives**, which is what the dependencies actually need — reconcile still
finishes ~1h35m before activities starts, and activities takes ~4 minutes. So this is not a bug to
fix, but do not add a Zoom step on the assumption it runs at 5am EDT: it runs mid-morning, and a
summary generated during a 9am meeting will not be picked up until the next day. If same-day capture
matters, that is the argument for the summary-completed webhook over the nightly.

## 6. Build order

Steps 0–2 are the proof plan in §0; nothing below them starts until §0.D is met.

| # | Step | Output |
|---|---|---|
| 0 | ✅ **DONE 2026-09-09** — Zoom S2S app + team-coverage assertion (§0.A) | **PASSED** — 4 hosts / 571 summaries, see §1b |
| 1 | **`zoom-probe.ts`** — read-only coverage, host spread, attendance signal, note length (§0.B) | the four measurements |
| 2 | ✅ **DONE 2026-09-10** — GHL write probe, run in sandbox (§0.C) | partial-PUT SAFE · note update in place · **no auto-noop, caller must diff** · `toNotify` live check still ⬜ — see §4b |
| 3 | ✅ **COMMITTED 2026-09-10** — note writer (`lib/activities/zoomNotes.ts` + `lib/zoom/*` + `lib/ghl/appointments.ts` + `scripts-ts/zoom-notes-run.ts`) | **24 tests green on macOS, `tsc` clean.** One case failed first and was a bad FAKE, not a bug: it threw a bare `Error` with `.status=404` bolted on, but a real `ZoomClient` throws `ZoomApiError` for every non-OK status, which is exactly what `listPastInstances` narrows its catch to. Fake corrected; the code was right. Ledger table created (`zoom_appointment_notes`, 0 rows). **Dry run `--days 7`: 6 Zoom-linked appointments, occurrence hit rate 6/6 = 100%** (bar was ≥90%) → 5 `would-create` (1,474–1,810 chars, all far inside the 5,000 cap) + 1 `skip:empty-summary`. ⬜ `--apply` still owed, see the note-trigger question in PROJECT_STATE |
| 4 | Status writer with `toNotify:false`, diffed and read back, never on absent evidence | never rewrites an unchanged status |
| 5 | Wire into the nightly **before** the appointment adapter | ordering per §2 |
| 6 | Backfill across the appointments carrying a Zoom id | dry-run → review → apply |

## 6b. 🔴 The summary MISATTRIBUTES SPEAKERS — treat it as prose, not as data

Found in the Joe Marr summary, and it matters more than it looks. Two sections attribute Zach's
statements to Joe:

- *"Joe mentioned that Lean Rocket Lab has been operating for 4-5 years with a background in data
  analytics"* — the 4–5 years is LRL, the data-analytics background is **Joe's company**; two facts
  about two organizations welded into one sentence.
- A whole section titled *"Lean Rocket Lab Market Shift"* opens *"Joe explained that Lean Rocket Lab has
  shifted its target market…"* — **that was Zach explaining LRL's own programs.**
- The *"$30,000 to $150,000"* project range is **Joe's consulting pricing**, sitting in a section whose
  framing invites reading it as LRL's.

**Consequence for the design.** As **human-readable notes on an appointment**, this is excellent and
should ship — a staffer reading it gets the meeting back instantly, and small attribution slips are
obvious to someone who was there. As a **source of structured facts**, it is not trustworthy: any
pipeline that parsed dollar figures, org attributes or program names out of this text would have
recorded Joe's pricing as an LRL fact with full confidence and no error.

**So: notes onto the appointment, yes. Deriving structured fields from summary prose, no** — and that
directly tempers §7 below. It also argues the note should carry a visible provenance line
(*"AI-generated Zoom summary — may misattribute speakers"*) so nobody downstream mistakes it for
staff-authored minutes.

## 6c. ❌ A CORRECTION, and the lesson in it

**An earlier draft of this brief called the Joe Marr meeting a "partner/vendor conversation, not
technical assistance," and said it should not become a funder-reportable row. That was wrong.**
Zach, 2026-09-03: *"This is still an intake meeting with a MI small business. They didn't fill out an
intake form so it isn't perfect."* Joe runs a Michigan data-analytics and AI consulting business; a
first conversation with a Michigan business owner **is an intake**, whether or not a form followed, and
it belongs in the count.

**The mistake is worth recording because of how it happened.** The summary's framing — a consultant
proposing workshops — invited the reading "he is a vendor to LRL." That is precisely the §6b failure
mode: drawing a structured conclusion from AI-written prose that flattens who-was-who. **The check that
was being proposed as a safeguard fell to the exact bias it was meant to catch.**

**So the rule tightens rather than loosens.** The summary is **human context on an appointment**. It is
not a classifier, and it is not evidence for or against an activity's type. A "does this look like real
service delivery?" review pass is **removed from this brief** — the calendar route and the staffer who
booked it are better authorities on what a meeting was than a paragraph written about it afterwards.

**The one place the summary does carry structured weight is attendance** (§2), and that rests on the
Zoom-generated attendee footer, not on the AI's prose.

## 7. The bonus worth naming

`service_topic` is currently a **route default** — inherited from which calendar was booked, identical
for every meeting on that link. A real meeting summary is the natural per-meeting source for it, and
that was always the field's intended eventual source. Once summaries land, `service_topic` could become a
`derivedFrom` value over the summary text (recomputing, individually overridable) exactly like the
readiness tagger.

**⚠️ Tempered by §6b.** The summaries misattribute speakers, so a derived `service_topic` must be
treated as a **suggestion routed to review**, not a fact written straight onto a funder-reportable
record — at least until a batch of them has been checked by hand against meetings someone remembers.
A route default that is bluntly wrong in a known way is safer than a derived value that is subtly wrong
in an unknown one.

**Do not do this in the same pass.** Land notes first, prove `noop`, settle attendance, then derive.
