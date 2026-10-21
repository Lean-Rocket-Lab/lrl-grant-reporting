# Event registrations in GA4 without a tag on the Events page (decided 2026-10-20)

**The gap.** GHL Events pages (`go.leanrocketlab.org/events/event-details/<id>`) accept no tracking
tag, so a registrant's browser never gets a GA4 cookie and GHL stores `gaClientId: null`. LinkedIn
and Meta match on email and are unaffected; GA4 files conversions by browser id and had nothing to
file under. Measured 10-20: Cameron V.'s registration reached LinkedIn but not GA4.

**Rejected: a doorway page** (`apply.leanrocketlab.org/e?ev=<id>` that runs GTM, stamps the GA ids
onto the event URL, redirects). It gives native GA4 attribution but requires every event link to use
the doorway base URL. Zach: "that isn't going to work" — too easy to forget, one more thing per
event. The unpublished funnel "Event Doorway (GA tracking redirect)" and the GTM workspace changes
(tag + trigger) were discarded.

**Shipped instead (app only, no link changes):**
- `resolveEventGaIds()` — stored client id → `_gl` linker from a Wix click → otherwise a **stable
  per-contact fallback id** (`fallbackGaClientId`, sha256 of the contact id formatted like a GA id)
  so the registration is COUNTED. Fallback hits carry `lrl_reporter: server-fallback`.
  `GA4_EVENT_FALLBACK=0` turns the fallback off.
- The link's UTMs, as GHL captured them on the contact, ride along as event params
  `lrl_utm_source / lrl_utm_medium / lrl_utm_campaign / lrl_utm_content / lrl_utm_term`.

**Experiment (same day): synthetic session.** For fallback registrations the app first sends a
`campaign_details` event (source / medium / campaign / term / content / campaign_id from the landing
URL's UTMs — the shape Google's own MP docs use to set session campaign data), then a
`page_view` whose `page_location` is the landing URL GHL stored (UTMs included), then the
`event_registration`, both under the fallback client id and one fresh `session_id`. GA4 derives a
session's source from its first page_view URL, so this may attribute natively — unsupported by
Google's docs, hence an experiment. `GA4_EVENT_SYNTHETIC_PAGEVIEW=0` turns it off. Verify with one
test registration from a UTM'd raw event link: GA4 Realtime "first user source" / Acquisition
should show the UTM source instead of "(not set)".

Why `lrl_utm_*` and not `utm_*`: GA4 only reads `utm_*` out of a page URL at session start; as
event parameters they are just unknown custom params. The `lrl_` names say what they are.

**What this means in GA4:** `event_registration` counts are complete. Registrations that came from
a Wix click attribute natively. The rest show source/medium "(not set)" in standard Acquisition
reports — GA4 cannot be told a traffic source for a server-sent event — but report by campaign in
Explorations once the `lrl_utm_*` params are registered as **custom dimensions** (Admin > Custom
definitions; event-scoped; do this once). GHL's Attribution Report shows events by source natively
either way, so UTMs on every event link remain the rule.


**Zach (10-20 night): no custom definitions if avoidable** — the goal is events appearing in the SAME
standard GA4 reports (Traffic acquisition, source/medium, campaign) as forms and bookings. The
`lrl_utm_*` params stay as a free fallback but are not the plan. Test #1 (Coffee + Connect, no
campaign_details) and test #2 (with campaign_details) decide it.
