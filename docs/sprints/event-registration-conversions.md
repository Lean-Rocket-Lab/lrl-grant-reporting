# GHL Events registrations → Activities + server-side conversions

> **Status 2026-10-19 20:43: LIVE.** Steps 1–6 below done and verified on a real RSVP; GA4 sending.
> Step 7 (LinkedIn token) and 8 (backfill) open. See PROJECT_STATE for the three live-payload facts.

## Why

LRL moved ticketing/RSVPs from Wix Events to **GHL Events** (`go.leanrocketlab.org/events/...`).
Two gaps followed:

1. **Grant reporting.** Nothing ingested GHL registrations, so they never became Activities. TC KPI 3
   (tech/innovation event attendees) and KPI 8 (small-group TA = workshops) read Workshop / Event
   activities. Wix phase 6 was going to fill this; it is blocked on Wix permissions and now moot for
   new events.
2. **Ad attribution.** GHL Events pages accept **no tracking code** (Link & tracking settings take only
   a Meta Pixel ID — Zach, 10/19). Verified on a live event page 10/19: no GA4, no LinkedIn Insight
   Tag, no Script B. So event registrations reach no ad platform from the browser.

One webhook fixes both: the app records the ticket AND reports the conversion server-side.

## What was built

| File | Role |
|---|---|
| `lib/activities/sources/eventRegistration.ts` | Adapter: payload → `workshop_event` activity + GA4 + LinkedIn |
| `pages/api/event-registration-sync.ts` | Webhook receiver (same auth/echo/dryRun/fast-ack pattern as form-sync) |
| `lib/conversions/ga4.ts` | GA4 Measurement Protocol sender |
| `lib/conversions/linkedin.ts` | LinkedIn Conversions API sender |
| `lib/conversions/ledger.ts` | At-most-once sends via the claims ledger (`conversion:<channel>`) |
| `lib/ghl/contacts.ts` / `types.ts` | `getContact` now carries `firstAttribution` / `lastAttribution` |
| `middleware.ts` | Route added to SELF_ENFORCING |
| `scripts-ts/add-field-options.ts` | Plan now adds `activity_source` option **GHL Event** |

## Decisions (and why)

- **Identity `(GHL Event, <eventId>:<contactId>)`** — one ticket per person per event. The same key is
  the conversion id on every channel, so a re-delivery is a `noop` activity and `already-sent`
  conversions. Never change it.
- **`registered = Yes`, `attended` blank** (phase-6 rule: unknown ≠ No). **`activity_date` = event date**
  in America/Detroit, `onlyIfAbsent`. Falls back to registration date with a note if the webhook omits it.
- **`event_type` only from an explicit label or an unambiguous title word** (Workshop / Webinar /
  Roundtable). Otherwise blank + a note. Workshop vs Tech/Innovation Event are different TC KPIs; a
  guess is a mis-filed funder number. ⬜ Zach: a fuller rule, or send `eventType` as Custom Data.
- **No company → attached to the contact, flagged in notes.** Ingest mode allows contact-only; event
  registrants are often not yet linked to a company, and dropping them would undercount attendance.
- **GA4 uses `lastAttributionSource.gaClientId`** from the contact (GHL stores the raw cookie
  `GA1.1.x.y`; the sender strips to `x.y`). **No client id → GA4 skipped, never invented.** No PII in
  GA4 params. Dry run validates against GA4's `/debug/mp/collect`.
- **LinkedIn matches on SHA-256(email)** plus `li_fat_id` parsed from the attribution URL. Site-side
  conversions (`/submitted`, `/booked`) stay on the Insight Tag — do not duplicate them via CAPI.
- **Attribution source of truth for events is GHL's own contact attribution.** Server-side GA4 hits
  often lose the session's channel; GA4 is the cross-check, not the record.

## Measured facts this rests on (2026-10-19)

- `GET /contacts/{id}` returns `lastAttributionSource` with `gaClientId`, `gaSessionId` (often null),
  `url`, `utm*`. The duplicate-search endpoint does **not**.
- Activities object: `event_type` options Tech/Innovation Event, Webinar, Roundtable, Workshop, Other;
  `registered` / `attended` Yes/No; `event_id`, `event_name` TEXT. `activity_source` had no option for
  GHL Events (hence the add).
- GHL webhooks deliver the STANDARD payload (09-02 gotcha); Custom Data arrives under `customData`.
  The trigger's exact event merge-field names are **unconfirmed** — the route logs the payload's
  event-ish keys on every delivery so the first one answers it.

## Go-live checklist (in order)

1. **Add the `GHL Event` source option** (live picklist; read → append → write → read back):
   `npx vite-node scripts-ts/add-field-options.ts` → review → `--apply`. Must precede step 3, or the
   first registrations land with no `activity_source` and the search fallback cannot find them.
2. **GA4:** create the Measurement Protocol API secret (Admin › Data streams › LRL Website) and the key
   event `event_registration`. Set `GA4_MEASUREMENT_ID=G-4WMKNE5XEZ` and `GA4_API_SECRET` in
   `.env.local` and Vercel.
3. **Commit + push** (deploys). Commit from the Mac, not the VM (mounted-folder git lock hazard).
4. **Dry run against a real contact + event** (writes nothing, validates the GA4 hit):
   `curl -X POST '<app>/api/event-registration-sync?dryRun=1&sync=1' -H 'x-webhook-secret: …'
   -H 'content-type: application/json' -d '{"contact_id":"<id>","customData":{"eventId":"<id>","eventName":"<name>","eventStart":"2026-11-09"}}'`
5. **Wire the workflow "Event Conversion Tracking":** Webhook action, URL above, header
   `x-webhook-secret`, Custom Data `eventId` / `eventName` / `eventStart` mapped to the trigger's
   event merge fields. Publish.
6. **One real test RSVP** on a hidden test event → check Vercel log line `[event-registration-sync]
   payload`, the new activity, and GA4 Realtime for `event_registration`.
7. **LinkedIn (later):** create the "Event Registration" conversion as **Conversions API**, get a token
   with `rw_conversions`, set `LINKEDIN_CAPI_TOKEN` + `LINKEDIN_EVENT_CONVERSION_ID`. Tokens expire
   (~60 days) — a 401 surfaces as `failed / unauthorized`.
8. **Backfill (optional):** past registrations can be replayed with `?noConversions=1` (GA4 drops hits
   older than 72h anyway).
