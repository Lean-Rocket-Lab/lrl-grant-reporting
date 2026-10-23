# LRL Directory Widget: Build Prompt for GHL AI Studio

Paste everything below the line into the AI Studio chat. Section 0 is the short version; the rest is the reference it will need as it builds. Replace the two `<<...>>` placeholders before pasting.

---

## 0. What I want you to build

Build a single embeddable **Directory Widget** for the Lean Rocket Lab website (this GHL site). It replaces three Wix CMS displays (Team/EIRs, Resources, Events) with one component that reads from the Lean Rocket Lab GHL CRM through a small read-only JSON endpoint I will host.

Phase 1 is **Team/EIRs** and **Resources**. Events is a third tab that should exist in the UI and in the data model now but can show an empty state until Phase 2.

The widget is placed on program and collective pages. Each placement is **scoped** by a data attribute so the same widget shows ManuTech people and resources on the ManuTech page, Sales and Marketing Accelerator content on that page, Mainstreet Collective content on that page, and everything on an unscoped page.

Non-negotiables:

1. The browser never calls `services.leadconnectorhq.com` and never holds a GHL token. It calls one public, cached, read-only endpoint that returns only the whitelisted public fields listed in section 4.
2. Only records whose publish status is `Published` are shown. Status is controlled by LRL staff in the CRM, not by the website.
3. Filtering by program and collective uses the **canonical slugs** in section 3, never raw GHL labels or option keys, because contacts and the Resources object spell them differently.
4. Brand: background `#171717`, gold `#F8B932`, teal `#05998C`, Helvetica Neue / Arial, dark editorial feel. No em dashes anywhere in copy.

## 1. Architecture

```
GHL site page
  <div data-lrl-directory data-scope="program:manutech" data-tabs="team,resources,events"></div>
  <script src=".../lrl-directory.js"></script>
        |
        |  GET https://<<PROXY_HOST>>/directory?scope=program:manutech   (public, cached, no auth)
        v
Read-only proxy (serverless function; see section 6)
        |  Bearer <GHL private integration token>  (server side only)
        v
GHL API  POST /contacts/search          -> Team/EIRs
         POST /objects/custom_objects.resources/records/search -> Resources
```

The proxy does four things: fetch, filter to `Published`, map to the normalized shape in section 4, and cache (10 to 15 minutes is fine; a nightly sync already runs against this CRM, freshness in minutes is not required). It returns one JSON document per scope. The widget does all tab and chip filtering client side from that one document.

Location id: `FgnVVv4smxyBNJKFZgJv`. API version header: `Version: 2021-07-28`.

## 2. Data sources, exactly as GHL returns them

### 2a. Team / EIRs = GHL **contacts**

Call:

```http
POST https://services.leadconnectorhq.com/contacts/search
Authorization: Bearer <token>
Version: 2021-07-28
Content-Type: application/json

{
  "locationId": "FgnVVv4smxyBNJKFZgJv",
  "page": 1,
  "pageLimit": 100,
  "filters": [
    { "field": "customFields.uhMXVvv2sWa15VUwnxdi", "operator": "eq", "value": "Published" }
  ]
}
```

`uhMXVvv2sWa15VUwnxdi` is the id of `contact.status` (label "Website Profile Status"). Today this returns 42 contacts. Paginate with `page` until `contacts.length < pageLimit`.

Response shape (trimmed to what matters; real sample):

```json
{
  "contacts": [
    {
      "id": "jY6HclP5baPhadMZF0IB",
      "firstName": "Tom",
      "lastName": "McFadden",
      "companyName": null,
      "website": null,
      "email": "...",            // DO NOT expose
      "phone": "...",            // DO NOT expose
      "customFields": [
        { "id": "uhMXVvv2sWa15VUwnxdi", "value": "Published" },
        { "id": "TCCMGrG6Pv9Lfhga0Fi0", "value": ["EIR"] },
        { "id": "58YNmbkHWahxdwn9yb9f", "value": ["Local"] },
        { "id": "lW17fW7GSnbfvugy7CLR", "value": ["Mainstreet", "Lean Startup"] },
        { "id": "5DsGtcbAWOR2cNLYFQf2", "value": "Tom McFadden is an experienced ..." },
        { "id": "YSS7z08zleBB2Hy1J5VD", "value": "https://www.linkedin.com/in/..." },
        { "id": "4cwXyHXVmKae5hWrZLCT", "value": ["Financial Modeling", "Fundraising & Investor Readiness"] }
      ]
    }
  ],
  "total": 42
}
```

Contact custom fields come back as a flat array of `{id, value}`. Build a lookup by id. **Multi-select values on contacts are arrays of LABELS** (e.g. `"Sales and Marketing"`), not option keys. A field with no value is simply absent from the array.

Contact fields the widget uses (these are the exact rows of the existing Contact to Wix Team sync):

| Purpose | Field key | Field id | Type | Values / notes |
|---|---|---|---|---|
| Publish gate | `contact.status` | `uhMXVvv2sWa15VUwnxdi` | SINGLE_OPTIONS | `Pending` / `Approved` / `Published` / `Hidden`. Show only `Published`. |
| Role tags | `contact.website_team_tags` | `TCCMGrG6Pv9Lfhga0Fi0` | MULTIPLE_OPTIONS | `Team` / `Board` / `EIR`. Drives the Team vs EIR sub-filter. |
| Programs | `contact.programs` | `58YNmbkHWahxdwn9yb9f` | MULTIPLE_OPTIONS | `Local` / `Sales and Marketing` / `ManuTech Incubator` / `i4.0 Accelerator` |
| Collectives | `contact.collectives` | `lW17fW7GSnbfvugy7CLR` | MULTIPLE_OPTIONS | `Lean Startup` / `Mainstreet` / `Manufacturing Tech` |
| Name | standard `firstName` + `lastName` | | | Wix used `fullName`. |
| Title | `contact.job_title` | `sLbLkuB3uO7cW5Egkpti` | TEXT | |
| Company | standard `companyName` | | | |
| Company website | standard `website` | | | |
| Bio | `contact.biowho_you_are` | `5DsGtcbAWOR2cNLYFQf2` | TEXT | Plain text, can be long. |
| LinkedIn | `contact.linkedin` | `YSS7z08zleBB2Hy1J5VD` | TEXT | URL string. |
| Headshot | `contact.headshot` | `fb3uZjhMTAGK80wEC61t` | FILE_UPLOAD | See file shape note below. |
| Company logo | `contact.company_logo` | `3yf1JeXP7GCWkonJ3KAi` | FILE_UPLOAD | See file shape note below. |
| Service areas | `contact.service_areas` | `4cwXyHXVmKae5hWrZLCT` | MULTIPLE_OPTIONS | 29 labels such as `Go-to-Market Strategy`, `Design for Manufacturing`. Shown as chips (max 3 on the card, all on expand). |
| Readiness stops | `contact.mrl_stops` `uDrHbARvMAQttKxnKiCl`, `contact.trl_stops` `jmZaR2m6t64l6XeWHgHA`, `contact.crl_stops` `UhG8N7Nq5HN5AMtySbq4`, `contact.investor_readiness_stops` `RTxPQGQbqX5dIlMaRTpf` | | MULTIPLE_OPTIONS | Arrays of `"1"`..`"10"`. Pass through for the Readiness Map; not a filter in this widget. |

Not for the website: `email`, `phone`, `dndSettings`, `attributionSource`, `readiness_rationale`, `readiness_confidence`, `wix_team_row_id`, and every other field not listed above. The proxy must drop them.

### 2b. Resources = **Profiles** with `profile_type = resource` (changed 2026-10-23)

> **Updated 2026-10-23.** The old `custom_objects.resources` object is a frozen archive. Every
> resource (94) now lives on `custom_objects.profiles` with `profile_type = resource`; people are
> the same object with `profile_type = person` (see `docs/sprints/profiles-resources-merge.md`).
> **One search returns both tabs** — split on `profile_type`. Section 2a (contacts) is also
> superseded: people come from this same Profiles search, never from `/contacts/search`.

```http
POST https://services.leadconnectorhq.com/objects/custom_objects.profiles/records/search
Authorization: Bearer <token>
Version: 2021-07-28
Content-Type: application/json

{
  "locationId": "FgnVVv4smxyBNJKFZgJv",
  "page": 1,
  "pageLimit": 500,
  "query": "",
  "filters": [
    { "field": "properties.profile_status", "operator": "eq", "value": "published" }
  ]
}
```

Filter field is `properties.<key>` (a bare key 422s) and the value is the option KEY (`published`,
`resource`, `person`), never the label. Add `{ "field": "properties.profile_type", "operator": "eq",
"value": "resource" }` to fetch resources only. Multi-selects come back as arrays of option KEYS.

Resource-profile fields the widget uses:

| Purpose | Property key | Type | Values / notes |
|---|---|---|---|
| Kind | `profile_type` | SINGLE_OPTIONS | `person` / `resource` |
| Publish gate | `profile_status` | SINGLE_OPTIONS | `pending` / `approved` / `published` / `hidden`. Show only `published`. |
| Name | `display_name` | TEXT | Primary display property (was `resources`). |
| Category / Sub category | `category`, `sub_category` | TEXT | Chips / secondary filter. |
| Short description | `short_description` | TEXT | Card text. |
| Full description | `bio` | LARGE_TEXT | Label "Bio / Description" (was `full_description`). |
| Website | `website` | TEXT | Primary CTA. |
| Email | `public_email` | TEXT | Shared inbox only (was `email`). |
| Programs / Collectives | `programs`, `collectives` | MULTIPLE_OPTIONS | Same keys as before; programs now also `exit_readiness_accelerator`. |
| Logo | `company_logo` | FILE_UPLOAD | Label "Logo" (was `resource_logo`). |
| Service areas | `service_areas` | MULTIPLE_OPTIONS | Option KEYS now (was a `;`-joined TEXT label string). Map key → label from the field's options. |
| Rank | `rank_local`, `rank_mainstreet`, … | NUMERICAL | One rank field per page; resources' old `rank_local__mainstreet` was copied to both LOCAL and Mainstreet. |
| Readiness stops | `mrl_stops`, `trl_stops`, `crl_stops`, `investor_readiness_stops`, `msrl_stops` | MULTIPLE_OPTIONS | Pass through, not a filter. |

Not for the website: `readiness_rationale`, `readiness_confidence`, `source_resource_id`,
`wix_resource_row_id`, `source_contact_id`, `wix_team_row_id`, `relations`.

### 2c. FILE_UPLOAD values (headshot, company logo, resource logo)

GHL stores a file field in **three** shapes depending on how the file arrived. Handle all three with one extractor and take the first URL:

```js
function firstFileUrl(v) {
  if (!v) return null;
  if (typeof v === 'string') return /^https?:\/\//.test(v) ? v : null;         // 1. bare url
  if (Array.isArray(v)) return v.map(e => typeof e === 'string' ? e : e?.url).find(Boolean) ?? null; // 2. array
  if (typeof v === 'object') return Object.values(v).map(e => e?.url).find(Boolean) ?? null;        // 3. uuid-keyed map (form uploads)
}
```

Both URL hosts GHL hands back (`msgsndr-private.storage.googleapis.com/...` and `services.leadconnectorhq.com/documents/download/...`) are publicly fetchable without auth (verified today with a 200 and `image/png`), so the widget can use them directly in `<img src>`. If an image is missing or fails to load, fall back to an initials avatar (people) or a neutral tile with the first letter of the name (resources).

### 2d. Events (Phase 2, design for it now)

Leave a `events: []` array in the payload and an Events tab with an empty state. The likely source is GHL calendar events (`GET /calendars/events` for the public program calendars) filtered to upcoming, with program/collective derived from the calendar id. Do not build it yet; just keep the normalized shape (section 4) ready for `type: "event"` items with `startsAt`, `endsAt`, `location`, `registerUrl`.

## 3. Canonical filter taxonomy

The same program is spelled three ways across GHL. Normalize everything to these slugs in the proxy and filter only on slugs.

**Programs**

| Canonical slug | Display name | Contact label (`contact.programs`) | Resources key (`programs`) | Page scope value |
|---|---|---|---|---|
| `local` | LOCAL | `Local` | `local` | `program:local` |
| `sama` | Sales and Marketing Accelerator | `Sales and Marketing` | `sales_and_marketing_accelerator` | `program:sama` |
| `manutech` | ManuTech Incubator | `ManuTech Incubator` | `manutech_incubator` | `program:manutech` |
| `i40` | Industry 4.0 Accelerator | `i4.0 Accelerator` | `industry_40_accelerator` | `program:i40` |

**Collectives**

| Canonical slug | Display name | Contact label (`contact.collectives`) | Resources key (`collectives`) | Page scope value |
|---|---|---|---|---|
| `lean-startup` | Lean Startup Collective | `Lean Startup` | `lean_startup` | `collective:lean-startup` |
| `mainstreet` | Mainstreet Collective | `Mainstreet` | `mainstreet` | `collective:mainstreet` |
| `manufacturing` | Manufacturing Collective | `Manufacturing Tech` | `manufacturing` | `collective:manufacturing` |

**Role (people only)**: `team`, `eir`, `board` from `contact.website_team_tags` labels `Team`, `EIR`, `Board`. Default view shows `team` and `eir`; `board` is hidden unless the placement sets `data-roles="team,eir,board"`.

Match case-insensitively and trim whitespace. If a value does not match any row, keep the record but log the unmapped value to the console in the proxy so I can fix the CRM.

## 4. Normalized payload the widget consumes

The proxy returns this and nothing else. Every field is public by construction.

```ts
type DirectoryPayload = {
  generatedAt: string;          // ISO
  scope: string | null;         // echo of ?scope
  people: Person[];
  resources: Resource[];
  events: Event[];              // [] in Phase 1
};

type Person = {
  type: 'person';
  id: string;                   // GHL contact id
  name: string;                 // firstName + ' ' + lastName
  title: string | null;         // job_title
  company: string | null;       // companyName
  companyUrl: string | null;    // website (standard)
  bio: string | null;
  linkedinUrl: string | null;
  photoUrl: string | null;      // headshot
  logoUrl: string | null;       // company_logo
  roles: ('team'|'eir'|'board')[];
  programs: ('local'|'sama'|'manutech'|'i40')[];
  collectives: ('lean-startup'|'mainstreet'|'manufacturing')[];
  serviceAreas: string[];
  stops: { mrl: string[]; trl: string[]; crl: string[]; irl: string[] };
};

type Resource = {
  type: 'resource';
  id: string;                   // GHL record id
  name: string;                 // resources
  category: string | null;
  subCategory: string | null;
  shortDescription: string | null;
  fullDescription: string | null;
  websiteUrl: string | null;
  contactEmail: string | null;
  logoUrl: string | null;
  programs: Person['programs'];
  collectives: Person['collectives'];
  serviceAreas: string[];       // split on ';'
  rank: number | null;          // rank_local__mainstreet
  stops: Person['stops'];
};

type Event = {
  type: 'event';
  id: string; name: string; startsAt: string; endsAt: string | null;
  location: string | null; registerUrl: string | null; description: string | null;
  programs: Person['programs']; collectives: Person['collectives'];
};
```

Scope filtering (`?scope=program:manutech`) can happen in the proxy or in the widget; do it in the proxy so the payload is small, and let the widget still filter client side for the chips.

## 5. Widget behavior and UI

**Placement**

```html
<div data-lrl-directory
     data-scope="program:sama"          
     data-tabs="team,resources,events"   
     data-default-tab="team"
     data-roles="team,eir"></div>
```

Omit `data-scope` on the main Team page and the main Resources page to show everything. Multiple scopes are allowed as a comma list (`collective:mainstreet,program:local`), matched as OR.

**Layout**

- Top row: three pill tabs (Team and EIRs, Resources, Events) with live counts, in gold on charcoal; active tab filled gold with `#171717` text.
- Second row: filter chips. For people: role (Team / EIR). For both: program and collective chips, but only the ones that still have at least one item in the current scope, so a ManuTech page does not show a Mainstreet chip with zero results. A text search box filters on name, company, category, and service areas.
- Grid of cards, 3 across on desktop, 2 on tablet, 1 on mobile. Cards use `#1f1f1f` surfaces on the `#171717` page, 1px `#2a2a2a` borders, gold accents, teal for links and hover states.
- Person card: square headshot (fallback initials), name, title, company, up to three service area chips, LinkedIn and website icon links. Click opens a panel with the full bio.
- Resource card: logo tile (fallback letter tile), name, category / sub category line, short description, up to three service area chips, "Visit" CTA to the website, optional "Contact" mailto. Click expands to the full description.
- Sorting: people alphabetically by last name with EIRs first when both roles are shown; resources by `rank` ascending (nulls last) then name.
- States: skeleton cards while loading, a friendly empty state per tab ("No ManuTech resources yet"), and a quiet error state that never shows a stack trace.
- Accessibility: tabs and chips are real buttons with `aria-pressed`, cards are focusable, images have alt text (the person or resource name), color contrast at least 4.5:1 against `#171717`.
- Performance: one fetch per page load, rendered with vanilla JS (no framework), under 30 KB of JS and CSS combined, no external fonts beyond the system Helvetica Neue / Arial stack.
- Copy rules: sentence case, no em dashes. Use a comma, a colon, or a period instead.

## 6. The proxy (what I will host; generate it for me)

Generate a single serverless function (Vercel `api/directory.js` or a Cloudflare Worker, your choice, say which) that:

1. Reads `GHL_TOKEN` and `GHL_LOCATION_ID` from environment variables. Never from the request.
2. Runs the two searches from section 2 with pagination, at no more than 3 requests per second (GHL returns 429 above roughly that).
3. Maps to section 4 using section 3, dropping every field not in the whitelist.
4. Applies `?scope=` if present.
5. Caches the full payload in memory for 10 minutes and sets `Cache-Control: public, max-age=600, stale-while-revalidate=3600`.
6. Sets `Access-Control-Allow-Origin` to `https://<<SITE_HOST>>` (and the GHL preview domain) only.
7. Returns `503` with `{ error: "upstream" }` and the last cached payload's `generatedAt` when GHL is down, and keeps serving the stale cache.

Also give me the Private Integration scopes the token needs: `contacts.readonly`, `objects/record.readonly`, `objects/schema.readonly`, `locations/customFields.readonly`.

## 7. Acceptance checks before I call it done

- On the ManuTech page the widget shows only people whose `programs` include `manutech` and only resources whose `programs` include `manutech`; the Mainstreet chip is not rendered because nothing in scope carries it.
- A contact with `Website Profile Status = Pending` never appears, even if tagged `EIR`.
- A resource with `resource_status = hidden` never appears.
- The page source and network tab contain no GHL token, no `services.leadconnectorhq.com` request, and no email or phone for any person.
- Bill Webster (contact `xlKPrl2Wf1KHy44NxClf`) appears on the Sales and Marketing Accelerator page, the ManuTech page, and the Industry 4.0 page, with title "Principal, Director of Engineering" and company "Fidelis Engineering Associates".
- "Lean Rocket CRM" (resource `6a983cb02e4fa23a858ff84e`) appears on the LOCAL, ManuTech, and Sales and Marketing Accelerator pages, under Lean Startup and Mainstreet collectives, with its logo rendered.
- Removing the network returns the cached payload and the widget still renders.

## 8. Things you do not need to solve

- Writing anything back to GHL. This is read only.
- The approval workflow (Pending to Approved to Published). Staff do that in the CRM and a separate sync engine already handles it.
- The Readiness Map. It will consume the same payload later; just keep `stops` in the shape.

---

## Notes for Zach (not part of the prompt)

**Why the proxy and not a direct call or a GHL custom values trick.** The raw `/contacts/search` response carries email, phone, DND settings and even visitor IP addresses in `attributionSource`. Anything the browser can fetch, a visitor can fetch, so the whitelist has to live server side. The proxy is 80 lines and sidesteps the whole question.

**Where to host it.** The cleanest option is a tiny standalone Vercel project (or Cloudflare Worker) with its own read-only token, so it never touches `lrl-grant-reporting` and the "zero public routes" posture on that app stays intact. If you would rather fold it into the existing app as a `/api/public/directory` route, that works too, but it means adding a public prefix to the middleware; I would keep them separate.

**Taxonomy drift is the real risk.** Contacts say `Sales and Marketing` and `Manufacturing Tech`; the Resources object says `sales_and_marketing_accelerator` and `manufacturing`; Wix said `Sales and Marketing Accelerator` and `Manufacturing`. The slug table in section 3 is the same mapping the Wix sync's `valueMap` carries today. If someone adds a program option in GHL, the table needs a row or the item silently drops out of filtering, which is why the prompt asks the proxy to log unmapped values.

**Verified live today (2026-10-02):** 42 Published team contacts, 93 published resources, GHL file URLs return 200 without auth, all field ids and option keys above were read from the location schema rather than from docs.
