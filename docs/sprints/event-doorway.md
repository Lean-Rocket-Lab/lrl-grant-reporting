# Event Doorway — GA4 attribution for GHL Events registrations

**Built 2026-10-20 (evening).** GHL Events pages (`go.leanrocketlab.org/events/event-details/<id>`)
accept no tracking tag, so a registrant has no GA4 identity unless they arrived with one already
stamped on the URL. Measured 10-20: Cameron V.'s registration reached LinkedIn (email match) but not
GA4 (`no-client-id`). GHL's own attribution showed "Direct traffic" too — a bare link, no UTMs.

## The doorway

`https://apply.leanrocketlab.org/e?ev=<event id>&utm_source=…&utm_medium=…&utm_campaign=…`

- A one-section GHL funnel page ("Event Doorway (GA tracking redirect)", funnel `NgsfLYh1j2K4V8QIdtA2`,
  step path `/e`) on **apply.** (go. is bound to the Events product and cannot host a funnel page).
- GTM tag **LRL Event Doorway - stamp GA ids and redirect** (trigger: Page URL matches
  `^https://apply\.leanrocketlab\.org/e(/|\?|$)`): the Google tag records a page_view carrying the
  link's UTMs, the tag reads `_ga` / `_ga_4WMKNE5XEZ` cookies (polling up to 1.5 s), and
  `location.replace`s to `go.leanrocketlab.org/events/event-details/<ev>?<utms>&lrl_ga=<cid>&lrl_gs=<sid>`.
  Only a 24-hex `ev` is accepted — no open redirect. GA's cookie is on `.leanrocketlab.org`, so the
  session continues from apply. to go.
- GHL stores that landing URL on the contact (UTMs → Attribution Report; `lrl_ga`/`lrl_gs` → us).
- App: `gaIdsFromDoorway()` in `lib/conversions/ga4.ts`; `resolveEventGaIds()` in
  `lib/activities/sources/eventRegistration.ts` prefers doorway ids, then the `_gl` linker from a Wix
  click, then **a stable per-contact fallback id** (`fallbackGaClientId`) so the registration is at
  least counted. Fallback hits carry `lrl_reporter: server-fallback` (source shows "(not set)");
  `GA4_EVENT_FALLBACK=0` disables it.

## How to build an event link (the rule that makes this work)

Every event link LRL sends — email, social, ads, GHL's event share link — must be the doorway URL,
not the raw event URL. `ev` is the 24-hex id at the end of the event page URL. Add UTMs as usual
(GHL's link builder output can simply be pointed at the doorway).

A raw event URL still works for the visitor; it just lands in GA4 as a counted, unattributed
registration (fallback) instead of an attributed one.

## Verification

1. Open the doorway URL in a fresh incognito window with test UTMs → lands on the event page with
   `lrl_ga` + `lrl_gs` appended.
2. Register → Vercel log `[event-registration-sync]` / ledger `conversion:ga4` row → GA4 Realtime
   `event_registration` key event with the test source.
