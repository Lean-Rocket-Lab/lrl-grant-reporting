# Form + booking conversions, server-side (GA4 · LinkedIn · Meta)

**Built 2026-10-20, shipped in shadow mode; LIVE the same evening** (Zach: nothing to protect — no campaigns, no reporting period — so the comparison window was skipped; old LinkedIn Insight-Tag conversions deleted). Form submissions and meeting bookings are reported to
GA4, LinkedIn and Meta from the app, keyed to one dedupe id per conversion, instead of (eventually)
from GTM URL rules on `/submitted` and `/booked`. Event registrations already work this way
(`docs/sprints/event-registration-conversions.md`); this is the same pipeline for the other two.

## Why (decided with Zach, 10-20)

- GTM URL rules count only browsers that run the tags. Safari's cookie limits and ad blockers remove
  a share that only grows; Meta in particular matches poorly on cookies alone.
- GHL knows a submission happened for certain and holds email + phone, which is what the platforms'
  server APIs match on. It is the better-informed reporter.
- GTM keeps what only a browser can do: cookie the visitor (GA4, Meta Pixel PageView, LinkedIn
  Insight, Google Ads Conversion Linker) and send page views. Base tags stay; conversion tags go.
- **No Activities are created** — "only ad conversions for now" (Zach). Easy to add later.

## Architecture

```
GHL workflow (Form Submitted)            ─┐
GHL workflow (Customer Booked Appointment)─┼─► POST /api/conversion-sync?type=…  ─► lib/conversions/site.ts
                                          │     getContact → attribution URL → ids            │
                                          │                                                   ├─► GA4  MP   form_submitted / meeting_booked (+ session_id)
                                          │                                                   ├─► LinkedIn CAPI  (per-type conversion id)
                                          │                                                   └─► Meta  CAPI   Lead / Schedule
                                          └─ (Event Registration Status Succeeded → /api/event-registration-sync, unchanged)
```

- Identity = dedupe key on every channel (ledger `conversion:<channel>` + the platform's own event id):
  `appt:<appointmentId>` · `form:<contactId>:<formId|formName|form>:<UTC hour>` · or `customData.conversionKey`.
- Identifiers come from GHL's stored attribution record, not the browser: GA client id **and session
  id** from the `_gl` linker (`gaSessionIdFromLinker`, new), `li_fat_id`, `fbclid` → `fbc`, IP + UA,
  and the contact's email/phone (hashed before sending).

## Modes — the safe cutover

| `CONVERSION_SYNC_MODE` | GA4 | LinkedIn | Meta | Ledger |
|---|---|---|---|---|
| `shadow` (default) | validated on `/debug/mp/collect` | planned | planned (or Test Event if `META_TEST_EVENT_CODE`) | no claims |
| `live` | sent | sent | sent | claims per channel |

Shadow logs `[conversion-sync] shadow {…}` once per conversion. **That count vs the GTM-based platform
counts over the same two weeks is the comparison**, with zero double counting. Flip to `live` and
pause the two GTM tags (`GA4 Event - form_submitted`, `GA4 Event - meeting_booked`) on the same day,
and switch the two LinkedIn conversions from Insight-Tag URL rules to Conversions API ids.
`CONVERSION_SYNC_CHANNELS=ga4,linkedin` turns a channel off entirely (e.g. until Meta is configured).

## Env vars (add to .env.local + Vercel; redeploy after Vercel changes)

| Var | Value | Needed for |
|---|---|---|
| `CONVERSION_SYNC_MODE` | `live` (set 2026-10-20 evening; `shadow` to fall back) | gate |
| `CONVERSION_SYNC_CHANNELS` | optional, e.g. `ga4,linkedin` | per-channel switch |
| `LINKEDIN_FORM_CONVERSION_ID` | numeric id of a **Conversions API** conversion "Lead: Form Submitted" | LinkedIn form |
| `LINKEDIN_BOOKING_CONVERSION_ID` | same for "Lead: Booked Appointment" | LinkedIn booking |
| `META_PIXEL_ID` | Dataset id (Events Manager > Data sources > Settings) | Meta |
| `META_CAPI_TOKEN` | CAPI access token from that page | Meta |
| `META_TEST_EVENT_CODE` | optional; dry runs then land in Test Events | Meta verification only |
| `META_API_VERSION` | optional, default `v21.0` | Meta |
| (existing) `GA4_MEASUREMENT_ID`, `GA4_API_SECRET`, `LINKEDIN_CAPI_TOKEN`, `WIX_SYNC_WEBHOOK_SECRET` | already set | |

## Go-live checklist (in order)

1. **Commit + push from the Mac** (this doc, `lib/conversions/{site,meta,ga4}.ts`,
   `pages/api/conversion-sync.ts`, `middleware.ts`, tests). Deploys with `CONVERSION_SYNC_MODE` unset = shadow.
2. **Wire two GHL workflows** (Automation > Workflows), each: trigger → Webhook action:
   - **"Conversion – Form Submitted"**: TWO triggers on one workflow — *Form Submitted* (all forms)
     and *Survey Submitted* (all surveys). Webhook
     `POST https://lrl-grant-reporting.vercel.app/api/conversion-sync?type=form_submitted`,
     header `x-webhook-secret` = `WIX_SYNC_WEBHOOK_SECRET`. **No Custom Data needed** — the form id comes
     from the contact's attribution record (`mediumId`).
   - **"Conversion – Meeting Booked"**: trigger *Customer Booked Appointment*. Webhook
     `…/api/conversion-sync?type=meeting_booked`, same header, Custom Data **`appointmentId` = `{{appointment.id}}`** (required — without it the key can't be derived and the delivery is skipped with `no-key`).
   Publish both. Check the Vercel log for `[conversion-sync] shadow` on the next real submission.
3. **Dry run against a real contact** (nothing recorded; GA4 hit validated):
   `curl -X POST '<app>/api/conversion-sync?type=form_submitted&dryRun=1&sync=1' -H 'x-webhook-secret: …' -H 'content-type: application/json' -d '{"contact_id":"<id>","customData":{"formName":"Join a Collective"}}'`
   Expect `ga4: validated` with `client_id` and `session_id` populated in `identifiers`.
4. **LinkedIn:** Campaign Manager > Conversion tracking > create two conversions of type **Conversions API**
   (or edit the existing two to add the API source). Put their ids in the two env vars.
5. **Meta (when access lands):** Dataset id + CAPI token → env. Set `META_TEST_EVENT_CODE`, run step 3
   again, confirm the Lead appears under Events Manager > Test Events as *Server*. Remove the test code.
   Separately, add the Pixel **base code (PageView only)** to GTM, All Pages. No `Lead` tag in GTM.
6. **Two weeks of shadow.** Compare: count of shadow log lines per type vs GA4 `form_submitted` /
   `meeting_booked` key events vs LinkedIn's URL-rule conversions vs GHL's own submission count.
7. **Cutover (one day):** `CONVERSION_SYNC_MODE=live` + redeploy; pause the two GTM GA4 event tags
   and publish the container; switch the LinkedIn conversions' source to the API ones. Watch the
   Vercel log for `unauthorized` (LinkedIn/Meta token expiry) — that is the operational risk.

## Known limits / open items

- GHL's Form Submitted payload has no submission id OR form id (measured 10-20: `triggerData` is `{}`,
  no form merge fields in the builder). The form id is read instead from the contact's Latest
  Attribution (`medium: form`, `mediumId: <form id>`) → key `form:<contact>:<formId>:<UTC hour>`. Same
  contact, same form, twice within an hour = one conversion. Acceptable (double submits). No Custom
  Data is needed on the form workflow.
- GA4 MP events report `lrl_reporter: server` so a server-vs-browser split is one custom dimension away.
- Meta `fbp` (browser cookie) is not stored by GHL; `fbc` from `fbclid` + email/phone carry matching.
- Google Ads: link to GA4 and import `form_submitted` / `meeting_booked` / `event_registration` as
  conversions; add the Conversion Linker tag in GTM. No app change needed.
- Event registrations stay on GHL Events' native Meta Pixel setting (richer funnel events); the app
  does NOT send Meta for them, so no double count.
- ⬜ Token expiry alerting is log-level only (`failed / unauthorized`). A daily check or a Vercel log
  drain alert is the next step if the team won't be reading logs.
