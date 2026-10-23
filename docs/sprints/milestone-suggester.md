# Spec — Milestones + the AI milestone suggester

> **Written 2026-09-30**, from a session that BUILT the Milestones object live (2026-09-29) and then ran
> two read-only dry runs of the suggester by hand against real GHL data (Scott Labs, Blue Entity).
> Nothing in §6 was created in GHL — the proposals exist only in this file.
> Zach's framing: *"What is currently missing in our process is the ability to define milestones for
> companies and keep track of milestone completions. This will help us understand if we are actually
> identifying the right things for companies to accomplish to advance in readiness."*

## 0. The question this whole feature exists to answer

**Which kinds of milestones precede real readiness gains?** Every design choice below serves that:
milestones must be comparable across companies (Category + Readiness Dimension), dated (so they can be
lined up against `Client Stage Update` snapshots), and honest about where they came from (Source).

⚠️ **Read before trusting any "milestone → readiness lift" result:** the Readiness Map work (09-17)
found the portfolio's apparent advancement is mostly **scorer variance**, not growth. Until a rescore of
an unchanged company returns the same score, correlation between milestones and score deltas is noise.

## 1. What exists in GHL today (built + verified by read-back 2026-09-29)

Object **`custom_objects.milestones`** (Lean Rocket Lab location `FgnVVv4smxyBNJKFZgJv`), one folder
"Milestone Info" (`QT3aJTZu5x6jGPgTZPKC`).

| Field key (bare, as written in `properties`) | Type | Options (KEYS) |
|---|---|---|
| `milestone` (primary) | TEXT | — |
| `status` | SINGLE_OPTIONS | `proposed` `active` `completed` `dropped` |
| `definition_of_done` | LARGE_TEXT | — (write as verb + deliverable) |
| `readiness_dimension` | SINGLE_OPTIONS | `trl` `mrl` `crl` `business_msrl` `other` |
| `milestone_category` | SINGLE_OPTIONS | `customer_discovery` `marketing_brand` `sales_revenue` `product_design` `prototyping_testing` `manufacturing_supply_chain` `operations_systems` `financial_management` `funding_capital` `legal_ip_compliance` `team_hiring` `other` |
| `target_date` / `completed_date` | DATE | — |
| `evidence_link` | TEXT | — |
| `source` | SINGLE_OPTIONS | `staff` `ai_intake` `ai_session` |
| **owner** | GHL built-in record owner | *(no custom field — Zach: records are already assignable to GHL users)* |

- The field key is **`milestone_category`, not `category`.** A TEXT `category` field existed for ~1 hour
  and was deleted after migration; Scott Labs' record still carries an orphan `category: "Marketing"`
  property that the UI does not show. Ignore it.
- **Picklist edits REPLACE the whole option list** — adding a Category means read → append → write →
  read back (`scripts-ts/add-field-options.ts`). The list is Zach-approved; "Other" > ~10% of records,
  or one category > ~50%, is the signal the list needs to change.

**Associations** (definitions are permanent):

| key | id | Stored direction |
|---|---|---|
| `company_milestone` | `6abbe67770afb881290a9f62` | business → milestone |
| `milestone_resource` | `6abbe6794a1d8ced9dbe2f0e` | milestone → resource |
| `milestone_activity` | `6abbe67cca9bca2f3967638c` | ⚠️ **activity → milestone — GHL SWAPPED IT.** Posted as milestone-first; came back activity-first. Use `resolveAssociationDef`. |

First real record: *Scott Lab's Video Creation* (`6abbe6dfdfb29cefd3c99230`), created by Zach in the UI,
linked to Scott Labs + a Resource + two referral Activities.

## 2. Process decision — intake proposes, the EIR kickoff commits

Zach's concern (09-29): intake → triage → EIR POC → milestones; milestones defined at intake may not
match how the EIR wants to work. Resolution:

1. **Intake proposes** — AI drafts, `source = ai_intake`, `status = proposed`. Never `active`.
2. **The EIR kickoff commits** — EIR accepts / edits / drops, adds their own, owns the Active ones.
3. **Every drop is recorded.** High intake-drop rates mean either intake is misreading clients or EIRs
   are drifting from the proven process — the platform should make that visible, not hide it.

What is templatized is the *process* (when and how milestones are set), not the milestones themselves.

## 3. Sources — ALL readable from GHL, no Claude-side connector needed

Measured 2026-09-29/30 via the GHL API. The app needs only its existing GHL credentials.

| # | Source | Endpoint | Notes |
|---|---|---|---|
| 1 | Zoom AI summaries | `GET /contacts/{contactId}/notes` | Marker `<!-- lrl:zoom-summary -->`. **Each note carries `businessId` and `relations: [{objectKey:'appointment'}]`** — ONE call per contact returns the whole meeting history already attributed. Prefer this over per-appointment `GET /calendars/appointments/{id}/notes`. |
| 2 | Staff-written notes | same endpoint (no marker) **and** `activities.activity_notes` | Scott Labs' 01-08 note (manual, no Zoom) supplied a proposal. Activity notes hold agendas ("Phase 2 & 3 discussion", "GHL Support / BAF Update"). |
| 3 | Activities | object search, company relation | Grants, referrals, program acceptance. **Required**: notes alone would have re-proposed a BAF application already `closed_won` on 09-19. |
| 4 | 1:1 email | `GET /conversations/messages/export?channel=Email&contactId=` | 203 messages for Melissa DiVietri. See §3a. |
| 5 | Call transcripts | `GET /conversations/locations/{loc}/messages/{id}/transcription` | Only for calls on GHL (LC Phone) numbers. Not yet tested on a real call. This is the path for EIR phone calls if EIRs call from the GHL mobile app. |

### 3a. Email — the rules

- **Filter `source = campaign`.** 35 of the first 50 messages on one contact were LRL newsletters.
- **Strip quoted history.** Reply bodies carry the whole thread (15k → 50k chars across one thread);
  dedupe so each message is read once.
- **Only mailboxes synced to GHL are visible.** Zach's is. Leland writes from a personal Gmail — his
  threads appear only where Zach is cc'd. Anyone doing client work should sync an LRL mailbox.
- **Email is status evidence, never milestone content about the person.** Client emails contain
  personal details (e.g. medical appointments). The suggester must never quote or summarise them.
- Email changed 3 of 6 Blue Entity answers (website in progress, CRM setup already done, ATIA as the
  concrete event) and added 2 milestones. It is the freshest status signal we have.

## 4. The rules — learned from the two dry runs

1. **Zoom "next steps" are tasks, not milestones.** Roll several tasks up into one outcome.
2. **Only client-owned work becomes a milestone.** LRL-owned tasks ("Zach: connect Tyler with…") are
   Activities — and are usually already logged as referrals.
3. **Read the whole company history, not one meeting.** 3 of 5 Scott Labs proposals recurred across calls.
4. **Dedupe against existing milestones** in any status, including `dropped` — never re-suggest a drop.
5. **Never invent target dates.** Only use one stated in the source ("October").
6. **Read manual notes too**, not just Zoom summaries.
7. **Label inferences.** A milestone implied but never said (e.g. "first paying Jackson customer") is
   flagged as inferred so the reviewer knows.
8. **Later sources override earlier ones.** Discovery bootcamp: debated in July, completed by Sept.
9. **Don't propose what the LRL advisor argued against** (July: Zach told Melissa to stop over-validating).
10. **Cross-check Activities** before proposing grant/program milestones.
11. **"Consider" / "explore" are weak signals** — propose only if they recur in a later source.
12. **Propose COMPLETED milestones too.** Blue Entity's CRM setup was finished and never logged. An
    evidence-backed completion is free signal for §0 and for grant narrative. Always with `evidence_link`
    and always reviewed — never auto-completed.
13. **Never write `active` or `completed` without a human.** The suggester writes `proposed` only.
14. **Fold enabling tasks into the milestone they enable.** B8 (finalize the pitch) is a step of B3
    (exhibit at ATIA), not a separate outcome.

### 4a. The cap — focus is part of the method

Zach (09-30): *"we do want to have a maximum number of active milestones from an AI perspective."*

- **Default 3 Active milestones per company** (applies to staff too; number is config, not code).
- **AI proposes at most 3 new per company per run**, ranked; and **none** if the company already has
  3 Active. The rest are returned as `alsoConsidered` for the review screen — never created as records.
- **Completions are outside the cap** — an evidence-backed completion always gets through.
- **Ranking:** time-bound first → already funded / in progress → enables other milestones.

## 5. Output contract (per company, per run)

```ts
type MilestoneProposal = {
  companyId: string
  kind: 'new' | 'completion' | 'status_note'     // completion = propose flipping an existing or new milestone to completed
  milestone: string                               // verb + deliverable
  definitionOfDone: string
  readinessDimension: 'trl'|'mrl'|'crl'|'business_msrl'|'other'
  category: MilestoneCategoryKey
  targetDate?: string                             // ONLY if stated in a source
  confidence: 'high'|'medium'
  inferred: boolean                               // rule 7
  evidence: { source: 1|2|3|4|5; recordId: string; date: string; quote?: string }[]  // quote never from personal content
  dedupeOf?: string                               // existing milestone id it is related to
  skipped?: { reason: string }                    // emitted for transparency in dry-run output
  rank?: number                                   // 1..cap for proposals inside the cap
}
// per run: { proposals: MilestoneProposal[] /* ≤ cap new + any completions */, alsoConsidered: MilestoneProposal[], skipped: MilestoneProposal[] }
```

Dry-run output must list **skipped candidates with the rule that skipped them** — that is how the
rules were found, and how new ones will be.

## 6. Answer keys (the acceptance test)

### 6a. Scott Labs — `692619a5d2662264a9623554` — **graded by Zach 09-29: all 7 keep**

Sources: appt notes 01-08 (manual), 08-25 + 09-24 (Zoom); SitSense intake 04-22 (Alex, Zoom).

| # | Milestone | Category · Dim | Conf |
|---|---|---|---|
| S1 | Deliver AMTC Lunch & Learn with a live Uno demo on a CNC machine | marketing_brand · crl | high |
| S2 | Secure 2 manufacturer letters of support (Danfoss, Knox Metals) | customer_discovery · crl | high |
| S3 | Submit the BAF application for the video marketing campaign | funding_capital · crl | high |
| S4 | Install a leave-behind Uno demo unit at AMTC | sales_revenue · crl | medium |
| S5 | Sign the first paying Jackson-area manufacturer | sales_revenue · crl | medium, **inferred** |
| I1 | *(SitSense)* Select a metal fabrication partner for the chair frame parts | manufacturing_supply_chain · mrl | high |
| I2 | *(SitSense)* Build a pilot batch of a few dozen units for testing | prototyping_testing · mrl | medium |

Must skip: the video milestone (exists), all Zach-owned intros (Activities), "send a title by tomorrow".

### 6b. Blue Entity — `697ec612cc889674ef485676` — **graded by Zach 09-30: all 8 keep**

> *"Those are all good milestones. It would just depend on whether she ends up going to ATIA. We would
> manually update them if not."* ATIA-dependent items (B3, B8, partly B2) are expected to be edited by
> hand if she does not go — the suggester does not need to model the contingency.

Sources: contact notes (07-07, 07-20, 09-14 Zoom), activity notes, grant Activities, ~40 email threads.

| # | Milestone | Category · Dim | Kind / Conf |
|---|---|---|---|
| B1 | Launch the redesigned accessible website | marketing_brand · crl | new, high (BAF approved 09-01, in progress) |
| B2 | Produce an event marketing kit (banner, tablecloth, brochures) | marketing_brand · crl | new, high |
| B3 | Exhibit at ATIA in January | sales_revenue · crl | new, high |
| B4 | Run a first direct outreach campaign (mailers + calls) | sales_revenue · crl | new, medium |
| B5 | Finish GHL CRM setup (intake form, calendar, pipeline) | operations_systems · business_msrl | **completion** (email 09-16) |
| B6 | Settle government contracting eligibility (SAM.gov + disability certification) | legal_ip_compliance · business_msrl | new, medium |
| B7 | Earn the ADA Coordinator certification | legal_ip_compliance · business_msrl | new, high |
| B8 | Finalize the pitch for ATIA | sales_revenue · crl | new, medium (coaching booked 10-06) |

Must skip: customer discovery bootcamp (done by 09-14; also rule 9), BAF Phase 2 (won 09-19, rule 10),
personal branding / AI lead-gen / disability awareness event (rule 11), van signage (superseded 09-14).

**Under the cap (§4a)** the Blue Entity run should emit, ranked:
1. B3 Exhibit at ATIA — **with B8's pitch folded into its Definition of Done** (rule 14)
2. B1 Launch the website (funded, in progress)
3. B2 Event marketing kit (B3 depends on it)
- plus B5 as a **completion** (outside the cap)
- B4, B6, B7 as **"also considered"** — surfaced in review, never created as records

**Acceptance bar:** on these two companies the suggester reproduces ≥80% of the keys, proposes nothing
the "must skip" lists forbid, and never emits a personal detail from email.

## 7. Build order

1. **Read-only dry-run script** `scripts-ts/milestone-suggest.ts --company <id>` — gathers §3 sources,
   emits §5 JSON + skipped list. Zero writes. Run it against §6 until it passes.
2. **Widen the test set** — 3–5 more companies, including one EIR-led client and one thin record.
3. **Review screen** in the app (next to the activity logger): per company, Proposed milestones with
   Accept / Edit / Drop; plus the batch-entry form for staff-authored milestones.
4. **Write path** — accepted proposals go through `lib/ghl/objectWrite.ts` + a source claim
   (`milestone:<companyId>:<hash>`) so a re-run is a `noop`. Never bypass the planner.
5. **Triggers** — after an intake/coaching note lands (nightly, after the Zoom notes job), and on demand.

## 8. Open decisions

- **Portfolio-wide email sweep.** Zach (09-30): run the suggester over every company tagged "Client",
  and use email to update readiness-scoring fields and check off milestones. Position: **yes for
  proposals, no for direct writes.** Readiness fields feed funder reports and the scorer is already
  noisy — an email-inferred value must land as a *proposal with evidence*, reviewed like a milestone.
  Confirm the "Client" tag is the right population, and that client agreements / privacy language cover
  using their emails for internal program tracking.
- **Drop reason** — a picklist on drop would make §2's intake-vs-EIR signal measurable. Not built.
- **Client portal view** — GHL client portal does not render custom objects; custom menu links /
  iframes are contested (GHL ideas board open, 450 votes). Options: per-company signed page from the app
  (app is default-deny — needs a signed per-company token), or a generated document snapshot.
- **EIR capture outside LRL Zoom** — notetaker webhook (Fathom/Fireflies/Read.ai) or EIRs on LRL Zoom;
  EIRs book through their own GHL calendar so an appointment exists to attach to; calls via GHL mobile
  app for source 5. Needs Zach's answer on what EIRs use today.

## 9. First script run — 2026-10-01 (§7 step 1 BUILT, read-only)

**Code:** `lib/milestones/{schema,text,cap,gather,suggest,answerKeys,evaluate}.ts`,
`scripts-ts/milestone-suggest.ts`, tests in `lib/milestones/__tests__/text.test.ts` (not run — vitest needs
the darwin rollup binary; run `npm test` on the Mac). Model: `SCORING_MODEL`. No `--apply` exists.

**How to run** (each step must fit a short shell window in the desktop VM — background jobs are killed):
```
tsx scripts-ts/milestone-suggest.ts --company <id> --gather-only        # ~20s, saves reports/milestone-history-<id>.json
tsx scripts-ts/milestone-suggest.ts --company <id> --from-history --grade   # ~80–120s, model + judge
```
On the Mac, `--keys` runs and grades all three answer-key companies in one go.

| Company | Recall | Violations | Result |
|---|---|---|---|
| Scott Labs | 80% (4/5) | 0 | PASS, but generous: the judge matched S2 *and* S3 to one BAF item |
| SitSense | 100% (2/2) | 0 | PASS (I2 landed in alsoConsidered, as the cap intends) |
| Blue Entity | 63% (5/8) | 1 | FAIL, mostly a DATA gap (below) |

**🔴 Finding 1 — GHL's email sync is incomplete for some threads.** Melissa's GHL conversation ends
**09-14**; Zach's Gmail has her threads through **09-30** (ATIA, calendar/branded domain, MRS certification on
08-19). Other contacts sync fine through today (location-wide newest 1:1 email: 10-01). So B3, B5, B7, B8's
best evidence never reached the suggester. Cause not yet known — check the mailbox sync settings in GHL
before trusting email as a source portfolio-wide. **Email coverage must be measured, not assumed.**

**Finding 2 — rule 15 added.** The first Scott Labs run proposed "completions" that were LRL services
(Trusted Connector grant received, SAMA cohort joined). Those are Activities. Rule 15: receiving an LRL grant,
program acceptance, coaching or event attendance is never a milestone; *using* the grant money is.

**Finding 3 — rule 11 is stricter than Zach's key.** B4 (mailers) and B6 (SAM.gov) were skipped as
"explore/consider". Zach kept both. Likely refinement: an LRL advisor's explicit recommendation counts as a
stronger signal than the client musing. Not changed yet.

**Finding 4 — one violation is debatable.** "Complete the Ann Arbor Spark customer discovery course" was
proposed as a completion; the key's must-skip lists "more customer discovery". It is a real completed outcome
(third-party program, not LRL). Zach to rule.

**Finding 5 — runs vary.** Two Scott Labs runs on the same data gave different lists (Nox Metals sale as
new vs also-considered). Grade on ≥2 runs before calling a prompt change an improvement.
