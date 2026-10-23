// lib/stage/msrl.ts — Main Street Readiness Level (MSRL): the rubric text the scorer sees, and the
// PURE math the scorer must never be trusted with.
//
// Source: "Main Street Readiness Level (MSRL)", Lean Rocket Lab, Draft v2, October 2026. Replaced the
// Churchill & Lewis service-path scale on 2026-10-21 (Zach). Spec: docs/sprints/msrl-migration.md.
//
// Division of labor (Zach chose an LLM rubric scorer over a deterministic checklist, 2026-10-21):
//   the MODEL judges each dimension (D, M, O) on its own ladder, the path/lens when the owner left
//   them blank, and the status of each place-based flag;
//   CODE takes the lowest dimension, applies the flag cap, formats "MSRL 4-S (D7 / M4 / O6)" and picks
//   the bottleneck dimension whose next rung becomes the 90-day milestone.
// The headline is therefore never a number the model typed, which keeps the framework's one hard rule
// ("no averaging, the lowest dimension wins") exact even when the model wobbles on a dimension.

export type MsrlPath = 'S' | 'G';
export type MsrlDimension = 'demand' | 'model' | 'operations';
export const MSRL_DIMENSIONS: MsrlDimension[] = ['demand', 'model', 'operations'];
export const MSRL_DIM_LETTER: Record<MsrlDimension, 'D' | 'M' | 'O'> = { demand: 'D', model: 'M', operations: 'O' };
export const MSRL_MIN = 1;
export const MSRL_MAX = 9;

/** The six business lenses (option labels; GHL stores the snake_case key). */
export const MSRL_LENSES = [
  'Appointment services',
  'Projects and trades',
  'Creative and event',
  'Makers and products',
  'Retail storefront',
  'Food and beverage',
] as const;
export type MsrlLens = (typeof MSRL_LENSES)[number];

/** Place-based flags. `clearsAt` = the level the flag must be cleared to reach; an OPEN flag caps the
 *  headline one below it. P9 applies on the Grow path only ("Level 9 G"). */
export interface PlaceFlag { id: string; name: string; clearedWhen: string; clearsAt: number; growOnly?: boolean }
export const PLACE_FLAGS: PlaceFlag[] = [
  { id: 'P1', name: 'Trade area', clearedWhen: 'Customers, competitors and traffic in the area are documented', clearsAt: 2 },
  { id: 'P2', name: 'Site criteria', clearedWhen: 'Written must-haves: size, parking, visibility, utilities, venting, access', clearsAt: 2 },
  { id: 'P3', name: 'Zoning', clearedWhen: 'The use is confirmed as allowed at the address with the city or township', clearsAt: 3 },
  { id: 'P4', name: 'LOI or lease', clearedWhen: 'Terms reviewed by the coach or an attorney before signing', clearsAt: 3 },
  { id: 'P5', name: 'Financing', clearedWhen: 'Buildout, equipment and opening costs funded, with a contingency', clearsAt: 3 },
  { id: 'P6', name: 'Certificate of occupancy', clearedWhen: 'Building, fire and health inspections passed', clearsAt: 3 },
  { id: 'P7', name: 'Occupancy cost', clearedWhen: 'Rent, utilities and CAM fit a sustainable share of revenue', clearsAt: 5 },
  { id: 'P8', name: 'Site profitability', clearedWhen: 'The location itself covers its costs, owner pay included', clearsAt: 6 },
  { id: 'P9', name: 'Replicable site', clearedWhen: 'The site model is documented well enough to repeat', clearsAt: 9, growOnly: true },
];
export const PLACE_FLAG_IDS = PLACE_FLAGS.map((f) => f.id);

/** Footprints that count as "operates from, or is about to commit to, a commercial site". Home-based,
 *  mobile, market and at-the-customer businesses are not capped (framework, "Place-based flags"). */
export function isCommercialSite(footprint: unknown): boolean {
  const v = String(footprint ?? '').toLowerCase().replace(/[_\s-]+/g, ' ').trim();
  return v.includes('brick and mortar') || v.includes('office location') || v.includes('storefront') || v.includes('commercial');
}

// ── Pure math ────────────────────────────────────────────────────────────────

export interface MsrlInput {
  demand: number;
  model: number;
  operations: number;
  path: MsrlPath;
  /** Flags the scorer judged OPEN on evidence. Unknown flags do not cap (see spec, decision 6). */
  openFlags: string[];
  /** Whether place flags apply at all (commercial site). */
  commercialSite: boolean;
}

export interface MsrlHeadline {
  /** Headline after the flag cap. */
  level: number;
  /** min(D, M, O) before the cap. */
  uncapped: number;
  /** The flag that set the cap, if one did. */
  cappedBy: string | null;
  /** Dimension whose next rung is the 90-day milestone. */
  bottleneck: MsrlDimension;
  /** "MSRL 4-S (D7 / M4 / O6)", with " · capped by P6" appended when a flag capped it. */
  label: string;
}

const clamp = (n: number) => Math.min(MSRL_MAX, Math.max(MSRL_MIN, Math.trunc(n)));

/**
 * Headline = lowest of D/M/O, capped one below the lowest open flag. Bottleneck = the lowest dimension;
 * ties go Demand first through level 3, then Model, then Operations (framework, "Milestones").
 */
export function computeMsrl(input: MsrlInput): MsrlHeadline {
  const d = clamp(input.demand), m = clamp(input.model), o = clamp(input.operations);
  const uncapped = Math.min(d, m, o);

  let level = uncapped;
  let cappedBy: string | null = null;
  if (input.commercialSite) {
    for (const flag of PLACE_FLAGS) {
      if (!input.openFlags.includes(flag.id)) continue;
      if (flag.growOnly && input.path !== 'G') continue;
      const cap = flag.clearsAt - 1;
      if (cap < level) { level = Math.max(MSRL_MIN, cap); cappedBy = flag.id; }
    }
  }

  const tied = MSRL_DIMENSIONS.filter((dim) => ({ demand: d, model: m, operations: o })[dim] === uncapped);
  const order: MsrlDimension[] = uncapped <= 3 ? ['demand', 'model', 'operations'] : ['model', 'demand', 'operations'];
  const bottleneck = order.find((dim) => tied.includes(dim)) ?? 'demand';

  const label = `MSRL ${level}-${input.path} (D${d} / M${m} / O${o})${cappedBy ? ` · capped by ${cappedBy}` : ''}`;
  return { level, uncapped, cappedBy, bottleneck, label };
}

/** Normalize a stored path value ("Sustain", "sustain", "S", "Grow (team...)") to S/G, else null. */
export function normalizePath(v: unknown): MsrlPath | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s === 's' || s.startsWith('sustain')) return 'S';
  if (s === 'g' || s.startsWith('grow')) return 'G';
  return null;
}

// ── Rubric text (the model's half) ──────────────────────────────────────────

export const MSRL_SCALE = `MSRL (Main Street Readiness Level). Score THREE dimensions separately, each 1-9:
  Demand (D): do enough of the right people want this, at this price, again?
  Model (M): does the money work per sale, per month, and across a full year?
  Operations (O): can it be delivered consistently without the owner doing everything?
A dimension is scored at the HIGHEST level whose criteria are fully met, with EVERY level below it also met. When torn between two, the LOWER one is correct. Score each dimension on its own: a business cannot pass one by being strong at another. Do NOT compute a headline; code takes the lowest dimension.

Ladder (levels 1-6 are the same for everyone; 7-9 depend on the owner's path, S = Sustain, G = Grow):
  1  D: customer and problem named specifically | M: price and costs guessed on paper, owner income goal stated | O: owner capacity, skills and available hours assessed
  2  D: offer and price stated, 15+ prospect conversations, trade area scanned | M: one-page revenue model, startup cost and direct cost per unit estimated | O: delivery method sketched; licenses, permits and insurance identified
  3  D: 10 paid customers outside the inner circle (or lens equivalent) | M: entity, separate bank account, price list, books started | O: licensed, insured, delivering acceptably; any staff needed to open hired legally
  4  D: 90 in-season days of revenue, one repeatable channel named | M: monthly P&L produced, revenue predictable in a range | O: consistent quality; intake, scheduling or production tracking exist
  5  D: conversion and repeat or referral rate measured, price held or raised without losing demand | M: direct cost per unit reconciled to the books, gross margin positive on every core offer | O: core procedures drafted, vendors and supply stable
  6  D: demand fills breakeven capacity, seasonality mapped with an off-season plan | M: breakeven including owner wage on a trailing 12 months, 13-week cash flow | O: capacity matched to demand across seasons (staff, subs, hours or waitlist)
  7S D: most work arrives by referral, repeat or reputation | M: net profit positive, owner pay near stated goal | O: systems documented, admin runs without owner, backup or referral partner, two-week absence with no lost clients
  7G D: customers arrive without the owner selling each job | M: net profit positive, labor percentage managed | O: trained non-owner delivers the core service, owner can leave two weeks
  8S D: retention measured, pricing power shown (waitlist, premium tier or raised rates) | M: 12 months clean financials, reserve covers slowest season (2 months minimum), credit ready | O: owner hours within stated goal, monthly metric review, key-person risk covered
  8G D: multiple channels, retention measured, pricing power shown | M: 12 months clean financials, reserve covers slowest season (2 months minimum), credit ready | O: lead or manager role, monthly metric review, risk reviewed
  9S D: demand tied to the business, not only the owner's name | M: owner pay at goal for 2+ years, valuation supportable | O: succession or sale file, another provider could step in
  9G D: demand proven beyond one unit, location or segment | M: profit independent of owner labor, valuation supportable | O: replication playbook used by someone else

Business lenses (same ladder, different evidence; a blended business uses the lens of its main revenue line):
  Appointment services (chiropractor, massage, salon, personal training): unit = visit/session; D3 = 10 paying clients outside the inner circle; usual bottleneck O: owner is the only licensed provider, M: slow insurance payments.
  Projects and trades (construction, mitigation, remodeling, landscaping): unit = job; D3 = 3 to 5 paid jobs outside the inner circle, set by job size; usual bottleneck M: cash gap between job costs and payment, D: one insurer or GC sends most work.
  Creative and event (photography, video, events, design): unit = booking; D3 = 10 paid bookings; usual bottleneck D: winter cliff, O: editing backlog at peak.
  Makers and products (candles, jewelry, baked goods, crafts): unit = unit/SKU; D3 = 10 buyers outside the inner circle, or 1 store reorder; usual bottleneck M: wholesale price below true cost, O: holiday production capacity.
  Retail storefront (boutique, gift shop, bookstore): unit = transaction; D3 = pop-up or market sales to 10+ strangers before a lease; usual bottleneck M: dead inventory, P-flags: occupancy cost.
  Food and beverage (restaurant, coffee shop, food truck, catering): unit = ticket/cover; D3 = pop-up, catering or market sales to 10+ strangers before a lease; usual bottleneck M: prime cost, O: staffing and inspections at open.

Seasonality (Michigan businesses move with the seasons):
  Anything measured in months is measured on a trailing 12 months, or against the same season last year.
  "90 days of revenue" means 90 IN-SEASON days. An off-season dip is NOT a level drop; a level drops only when a criterion stops being true or this season is clearly worse than the same season last year.
  Reserves are sized to the slowest season, 2 months minimum. Count thresholds (10 paid customers, 15 conversations) are cumulative and don't reset.

Place-based flags apply ONLY when the business operates from, or is about to commit to, a commercial site (not home-based, mobile, market or pop-up). For each flag report "cleared", "open" or "unknown":
${PLACE_FLAGS.map((f) => `  ${f.id} ${f.name}: cleared when ${f.clearedWhen} (needed to clear level ${f.clearsAt}${f.growOnly ? ' G' : ''})`).join('\n')}`;

export const MSRL_GUIDANCE =
  `MSRL: Score D, M and O each from DEMONSTRATED evidence in the inputs, never from plans, adjectives or ` +
  `aspirations. Climb each ladder rung by rung and stop at the first rung whose criteria are not clearly met; ` +
  `missing evidence means NOT met. A self-reported "profitable" does not prove M5+ without books that show it; a ` +
  `planned hire does not prove any O rung. Use the business lens to read the evidence (what "10 paid customers" ` +
  `looks like for that kind of business). Use the owner's stated path for levels 7-9; if the owner's path is ` +
  `blank, infer it from their goals (default S when unclear) and say so. Infer the lens from the description, ` +
  `NAICS code and footprint (a blended business uses its main revenue line). Many rung criteria have no direct ` +
  `intake question: read them from the description, "where they are today", revenue, customers, statements, ` +
  `staffing and owner involvement, and stay conservative when the evidence is thin. Flags: mark "open" only on evidence that the step is NOT done ` +
  `(e.g. signed a lease with no zoning check); with no evidence either way mark "unknown". For EACH dimension, ` +
  `name the unmet criteria of its next rung in one short, concrete line (this becomes the 90-day plan).`;
