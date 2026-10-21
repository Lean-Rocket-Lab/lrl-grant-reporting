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

**What this means in GA4:** `event_registration` counts are complete. Registrations that came from
a Wix click attribute natively. The rest show source/medium "(not set)" in standard Acquisition
reports — GA4 cannot be told a traffic source for a server-sent event — but report by campaign in
Explorations once the `lrl_utm_*` params are registered as **custom dimensions** (Admin > Custom
definitions; event-scoped; do this once). GHL's Attribution Report shows events by source natively
either way, so UTMs on every event link remain the rule.
