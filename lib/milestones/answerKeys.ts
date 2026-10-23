// lib/milestones/answerKeys.ts — the acceptance test (spec §6). Graded by Zach: Scott Labs 7/7 keep (09-29),
// Blue Entity 8/8 keep (09-30). The suggester must reproduce ≥80% of each key (counting proposals AND
// alsoConsidered — the cap decides placement, not recall) and must not propose anything in mustSkip.

export interface KeyItem { id: string; milestone: string; note?: string }
export interface AnswerKey {
  companyId: string;
  label: string;
  expected: KeyItem[];
  mustSkip: string[];
}

export const ANSWER_KEYS: AnswerKey[] = [
  {
    companyId: '692619a5d2662264a9623554',
    label: 'Scott Labs',
    expected: [
      { id: 'S1', milestone: 'Deliver AMTC Lunch & Learn with a live Uno demo on a CNC machine' },
      { id: 'S2', milestone: 'Secure 2 manufacturer letters of support (Danfoss, Knox Metals)' },
      { id: 'S3', milestone: 'Submit the BAF application for the video marketing campaign' },
      { id: 'S4', milestone: 'Install a leave-behind Uno demo unit at AMTC' },
      { id: 'S5', milestone: 'Sign the first paying Jackson-area manufacturer', note: 'inferred' },
    ],
    mustSkip: [
      'Explainer / marketing video creation (already an existing milestone)',
      'LRL staff introductions to videographers or agencies (LRL-owned tasks)',
      'Send the event title and description to Zach (a one-day task)',
    ],
  },
  {
    companyId: '69d96088d093e3a54117093d',
    label: 'SitSense (intake)',
    expected: [
      { id: 'I1', milestone: 'Select a metal fabrication partner for the chair frame parts' },
      { id: 'I2', milestone: 'Build a pilot batch of a few dozen units for testing' },
    ],
    mustSkip: ['Send Alex a paragraph describing the parts (a task feeding I1)'],
  },
  {
    companyId: '697ec612cc889674ef485676',
    label: 'Blue Entity',
    expected: [
      { id: 'B1', milestone: 'Launch the redesigned accessible website' },
      { id: 'B2', milestone: 'Produce an event marketing kit (banner, tablecloth, brochures)' },
      { id: 'B3', milestone: 'Exhibit at ATIA in January' },
      { id: 'B4', milestone: 'Run a first direct outreach campaign (mailers + calls)' },
      { id: 'B5', milestone: 'Finish GHL CRM setup (intake form, calendar, pipeline)', note: 'kind=completion' },
      { id: 'B6', milestone: 'Settle government contracting eligibility (SAM.gov + disability certification)' },
      { id: 'B7', milestone: 'Earn the ADA Coordinator certification' },
      { id: 'B8', milestone: 'Finalize the pitch for ATIA', note: 'may be folded into B3 (rule 14) — counts as matched if B3 includes the pitch' },
    ],
    mustSkip: [
      'Customer discovery bootcamp / more customer discovery (done; advisor argued against)',
      'Apply for BAF Phase 2 (already won 09-19)',
      'Vehicle / van wrap signage (superseded)',
    ],
  },
];
