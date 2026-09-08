# GHL Scoring Form — build spec

Generated from the LIVE company field definitions on 2026-09-08. Do not retype the
answer options. **Copy them exactly.** GHL stores a single-select as an option KEY derived from the label,
and a label that differs by one character matches nothing and fails **silently** — that has cost this
project data three times.

## How the form connects up

```
Scoring Form submitted  ->  answers land on the CONTACT (GHL forms are contact-scoped)
  ->  GHL workflow: Webhook  POST  https://lrl-grant-reporting.vercel.app/api/sync/up
        header  x-webhook-secret: <SYNC_WEBHOOK_SECRET>
  ->  app syncs the answers UP to the company
  ->  stage scorer fires, writes a Client Stage record with rationale
  ->  scores propagate to the company, then DOWN to the contact
  ->  GHL workflow: Wait, then send the results email
```

**Email timing.** The scorer is one Claude call plus several GHL writes. Use a **10 minute wait** — far
longer than it needs, and costs nothing. Add one condition before the send: **only send if
`{{contact.trl_current}}` (or `churchill_current`) is not empty.** Without it, a failed score sends a
client an email full of blanks.


---

## Everyone answers these

*Context — feeds every scale*

### Business Model

| | |
|---|---|
| Field type | `SINGLE_OPTIONS` (3 options) |
| Company field | `business.business_model` |
| Contact field | **does not exist — the setup script creates it** |

**Answer options — copy exactly:**

- Developing a new product, technology, or invention to bring to market. Most of my work is building, prototyping, validating, or commercializing something new. Examples: hardware startup, software product, biotech, novel device, climate tech, deep tech.
- Delivering or operating a service based business. Most of my work is serving customers today through a service, location, or established offering. Examples: restaurant, retail, contractor, consultant, event business, professional services, fitness studio.
- Both — I'm developing a new product AND running an ongoing service or location-based business.

> ⚠️ **Use radio buttons, not a dropdown.** These three options are full paragraphs and a dropdown makes them unreadable. This is also the single most valuable question on the form: **38% of client companies have no business model on file**, which is the only reason the scorer cannot score them.

### Description

| | |
|---|---|
| Field type | `LARGE_TEXT` |
| Company field | `business.description` |
| Contact field | **does not exist — the setup script creates it** |

### Where are you today?

| | |
|---|---|
| Field type | `SINGLE_OPTIONS` (7 options) |
| Company field | `business.where_are_you_today` |
| Contact field | `contact.where_are_you_today` — **already exists**, reuse it |

**Answer options — copy exactly:**

- I have an idea, no product or customers yet
- I'm researching or prototyping a new product or technology
- I have an early product or service and a few first customers
- I'm operating with consistent customers but it's not yet stable
- I have a stable, profitable business
- I'm growing rapidly and scaling up
- I have an established mature business

### Annual Revenue

| | |
|---|---|
| Field type | `NUMERICAL` |
| Company field | `business.annual_revenue` |
| Contact field | `contact.annual_revenue` — **already exists**, reuse it |

### Date of Incorporation

| | |
|---|---|
| Field type | `DATE` |
| Company field | `business.date_of_incorporation` |
| Contact field | `contact.date_of_incorporation` — **already exists**, reuse it |

---

## Product / technology companies

*Feeds TRL and MRL. Skip for pure service businesses.*

### Current state of your technology / product

| | |
|---|---|
| Field type | `SINGLE_OPTIONS` (8 options) |
| Company field | `business.tech_product_state` |
| Contact field | **does not exist — the setup script creates it** |

**Answer options — copy exactly:**

- Idea / hypothesis only
- Lab proof of concept
- Lab-validated component or subsystem
- Working prototype tested in lab
- Working prototype tested in real-world conditions
- Pilot deployment with real customers
- Production-ready system, completed and qualified
- Commercially deployed and proven

### Patents

| | |
|---|---|
| Field type | `SINGLE_OPTIONS` (4 options) |
| Company field | `business.patents` |
| Contact field | `contact.patents` — **already exists**, reuse it |

**Answer options — copy exactly:**

- None
- In progress
- Filed
- Granted

### Independent validation

| | |
|---|---|
| Field type | `MULTIPLE_OPTIONS` (5 options) |
| Company field | `business.independent_validation_company` |
| Contact field | **does not exist — the setup script creates it** |

**Answer options — copy exactly:**

- None
- Third-party testing
- Industry certification
- Regulatory clearance
- Other

> Multi-select. The client can pick more than one.

### How is your product manufactured today?

| | |
|---|---|
| Field type | `SINGLE_OPTIONS` (7 options) |
| Company field | `business.mfg_method` |
| Contact field | **does not exist — the setup script creates it** |

**Answer options — copy exactly:**

- Not yet manufactured / Software Only
- Hand-built one-offs
- Prototype shop / small batches in a lab
- Contract manufacturer pilot run
- Pilot line in production-relevant environment
- Low-rate production
- Full-rate production

### Manufacturing partner status

| | |
|---|---|
| Field type | `SINGLE_OPTIONS` (4 options) |
| Company field | `business.mfg_partner_status` |
| Contact field | **does not exist — the setup script creates it** |

**Answer options — copy exactly:**

- None
- Talking to potential partners
- Signed an agreement
- Actively producing with us

---

## Selling and customers

*Feeds CRL*

### Number of paying customers today

| | |
|---|---|
| Field type | `SINGLE_OPTIONS` (5 options) |
| Company field | `business.paying_customers` |
| Contact field | **does not exist — the setup script creates it** |

**Answer options — copy exactly:**

- 0
- 1-5
- 6-25
- 26-100
- 100+

### Where you are with selling

| | |
|---|---|
| Field type | `SINGLE_OPTIONS` (8 options) |
| Company field | `business.selling_stage` |
| Contact field | **does not exist — the setup script creates it** |

**Answer options — copy exactly:**

- Pre-product, no selling activity
- Customer discovery interviews only
- Letters of intent or design partners, no paid usage
- First paid pilots / trials
- Repeating paid usage with early adopters
- Repeatable sales motion, multiple paying customers
- Scaling — proven channels, growing revenue
- Established market presence

### Have you found product market fit

| | |
|---|---|
| Field type | `SINGLE_OPTIONS` (2 options) |
| Company field | `business.product_market_fit` |
| Contact field | **does not exist — the setup script creates it** |

**Answer options — copy exactly:**

- Yes
- No

---

## Business operations

*Feeds the Churchill stage*

### Number of Full Time Equivalents (FTE)

| | |
|---|---|
| Field type | `NUMERICAL` |
| Company field | `business.fte_current` |
| Contact field | **does not exist — the setup script creates it** |

### Number of FTE you anticipate hiring in the next 12 months.

| | |
|---|---|
| Field type | `NUMERICAL` |
| Company field | `business.fte_hiring_next_12mo` |
| Contact field | **does not exist — the setup script creates it** |

### Owner involvement

| | |
|---|---|
| Field type | `SINGLE_OPTIONS` (4 options) |
| Company field | `business.owner_involvement` |
| Contact field | `contact.owner_involvement` — **already exists**, reuse it |

**Answer options — copy exactly:**

- Owner does almost everything personally
- Owner does most things with a small team
- Owner manages but doesn't do the day-to-day work
- Owner has stepped back; professional management runs day-to-day

### Cash flow today

| | |
|---|---|
| Field type | `SINGLE_OPTIONS` (4 options) |
| Company field | `business.cash_flow_today` |
| Contact field | `contact.cash_flow_today` — **already exists**, reuse it |

**Answer options — copy exactly:**

- Struggling to cover costs
- Breaking even
- Consistently profitable
- Profitable and growing

### Locations / sites of operation

| | |
|---|---|
| Field type | `SINGLE_OPTIONS` (3 options) |
| Company field | `business.locations_sites` |
| Contact field | **does not exist — the setup script creates it** |

**Answer options — copy exactly:**

- One location or solo
- Multiple locations or crews
- Mobile or job-site only

### Management team

| | |
|---|---|
| Field type | `SINGLE_OPTIONS` (3 options) |
| Company field | `business.management_team` |
| Contact field | `contact.management_team` — **already exists**, reuse it |

**Answer options — copy exactly:**

- Owner-only
- Owner plus a few supervisors
- Established management team

---

## Notes

- **Nothing on this form is two-way synced.** The form owns the 19 answers (contact -> company, up only);
  the scorer owns the 5 score fields (company -> contact, down only). No field has two owners, which is
  the 2026-08-27 loop incident's lesson applied.
- **Sticky contact prefill is a bonus, with a sharp edge.** If a client is shown their last submitted
  answer and a staff member has since corrected that value on the company record, submitting the form
  overwrites the correction. Acceptable for a bonus, worth knowing.
- 7 of the 19 contact fields already exist and hold **stale orphan values** from the original intake form
  (`date_of_incorporation` 88% filled, `annual_revenue` 79%, `where_are_you_today` 40%). Nothing has been
  keeping them in sync with the company. After this build they become live inputs.
