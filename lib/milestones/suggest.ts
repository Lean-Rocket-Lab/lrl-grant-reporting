// lib/milestones/suggest.ts — company history → milestone proposals. READ-ONLY: returns data, writes nothing.
// Spec: docs/sprints/milestone-suggester.md §4 (rules), §4a (cap), §5 (output contract).

import { getAnthropic, SCORING_MODEL } from '../ai/anthropic';
import type { CompanyHistory } from './gather';
import { applyCap } from './cap';
import {
  DEFAULT_ACTIVE_CAP, MILESTONE_CATEGORY, READINESS_DIMENSION,
  type MilestoneProposal, type SkippedCandidate, type SuggestResult,
} from './schema';

export const SYSTEM_PROMPT = `You are the milestone suggester for Lean Rocket Lab (LRL), a Michigan nonprofit accelerator.
You read ONE client company's history (meeting summaries, staff notes, LRL activity records, emails) and propose
MILESTONES: client-owned outcomes that move the company's readiness. A human reviews everything you propose.

Readiness dimensions: trl (technology), mrl (manufacturing), crl (commercialization: customers, sales, marketing,
market validation), business_msrl (running the business: operations, systems, finance basics, compliance for
Main Street / service businesses), other.

THE RULES — follow every one:
1. Meeting "next steps" are TASKS, not milestones. Roll several tasks up into ONE outcome.
2. Only CLIENT-OWNED work becomes a milestone. Tasks owned by LRL staff (Zach, Alex, Leland, any EIR) — intros,
   follow-ups, connecting people — are LRL activities, not client milestones. Skip them.
3. Read the WHOLE history as one picture. An outcome mentioned in several sources is ONE milestone.
4. Never propose something that duplicates an EXISTING milestone in any status, including dropped ones.
   If a candidate is close to an existing one, skip it and name the existing id.
5. NEVER invent a target date. targetDate is null unless a source states a date or month for that outcome.
6. Staff-written notes are as important as Zoom summaries.
7. If a milestone is implied but never actually said, set inferred=true.
8. Later sources override earlier ones. If something was later completed, abandoned or replaced, do not propose
   the earlier version.
9. Do not propose something an LRL advisor argued AGAINST.
10. Check the Activity records: if a grant/program/application is already won or accepted there, do not propose
    applying for it.
11. "Consider" / "explore" / "maybe" are WEAK signals. Propose them only if they recur in a later source;
    otherwise list them as skipped.
12. Also propose COMPLETED milestones: client outcomes the sources show are already DONE but are not recorded as
    an existing milestone. kind="completion", with the evidence that shows completion. Only completions from the
    last 6 months, and only the client's OWN business outcomes.
15. LRL's own services are NOT milestones, new or completed: a grant awarded by LRL, acceptance into an LRL
    program or cohort, coaching received, an LRL event attended. Those are already recorded as Activities.
    (Using the grant money to DO something is a client milestone; receiving it is not.)
13. You only ever propose. Never imply anything is already accepted.
14. Fold enabling tasks into the milestone they enable (e.g. "finalize the pitch for event X" belongs in the
    definition of done of "exhibit at event X", not as its own milestone).

WRITING:
- milestone: verb + deliverable, short, specific ("Exhibit at ATIA in January", not "Trade shows").
- definitionOfDone: how ANYONE could tell it is complete; concrete and checkable.
- priority: rank ALL your kind="new" proposals 1..N (1 = do first). Rank by: time-bound first, then already
  funded or in progress, then outcomes other milestones depend on. Completions get priority 0.
- confidence: high = stated plainly and current; medium = weaker, older, or depends on something uncertain.
- evidence: cite the source refs you relied on, with a short factual note.

PRIVACY (hard rule): emails and notes can contain personal details (health, medical appointments, family,
travel, finances of the person). NEVER put personal details into any field. Use email ONLY as evidence of a
business outcome's status. Evidence notes must be about the business, never about the person.

Also list notable candidates you SKIPPED with the rule number that skipped them.

LENGTH LIMITS (the output is reviewed by busy people): at most 8 candidates and at most 10 skipped items;
at most 3 evidence entries per candidate; every note, reason and rankReason under 25 words.`;

const proposalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'milestone', 'definitionOfDone', 'readinessDimension', 'category', 'targetDate', 'confidence',
    'inferred', 'priority', 'rankReason', 'evidence', 'relatedExistingMilestoneId'],
  properties: {
    kind: { type: 'string', enum: ['new', 'completion'] },
    milestone: { type: 'string' },
    definitionOfDone: { type: 'string' },
    readinessDimension: { type: 'string', enum: [...READINESS_DIMENSION] },
    category: { type: 'string', enum: [...MILESTONE_CATEGORY] },
    targetDate: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium'] },
    inferred: { type: 'boolean' },
    priority: { type: 'integer' },
    rankReason: { type: 'string' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'ref', 'date', 'note'],
        properties: {
          source: { type: 'string', enum: ['zoom_summary', 'staff_note', 'activity', 'email', 'call_transcript'] },
          ref: { type: 'string' },
          date: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
    relatedExistingMilestoneId: { type: ['string', 'null'] },
  },
} as const;

export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates', 'skipped'],
  properties: {
    candidates: { type: 'array', items: proposalSchema },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidate', 'rule', 'reason'],
        properties: { candidate: { type: 'string' }, rule: { type: 'string' }, reason: { type: 'string' } },
      },
    },
  },
} as const;

/** The user message: the company's history, rendered oldest → newest with refs the model must cite. */
export function renderHistory(h: CompanyHistory, today: string): string {
  const existing = h.existing.length
    ? h.existing.map((m) => `- [${m.id}] (${m.status || 'no status'}) ${m.milestone}${m.definitionOfDone ? ` — done when: ${m.definitionOfDone}` : ''}`).join('\n')
    : '(none)';
  const items = h.items
    .map((i) => `### ${i.date} · ${i.title}\nref: ${i.ref} · source: ${i.source}\n${i.text}`)
    .join('\n\n');
  return `Today is ${today}.

# Company: ${h.companyName}
${h.companyDescription || '(no description)'}

# Existing milestones (do not duplicate — rule 4)
${existing}

# History, oldest first (${h.items.length} items)
${items}`;
}

/** One structured call, with the failure reason surfaced (truncation is the usual one) and one retry. */
async function callModel(history: CompanyHistory, today: string, model: string) {
  let lastWhy = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res: any = await getAnthropic().messages.create({
      model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: renderHistory(history, today) }],
      output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    } as any);
    const block = res.content?.find((b: any) => b.type === 'text');
    try {
      if (block?.text) return JSON.parse(block.text) as { candidates: MilestoneProposal[]; skipped: SkippedCandidate[] };
    } catch { /* fall through */ }
    lastWhy = `stop_reason=${res.stop_reason} output_tokens=${res.usage?.output_tokens} input_tokens=${res.usage?.input_tokens}`;
    console.warn(`[milestones] attempt ${attempt} unparseable (${lastWhy})`);
  }
  throw new Error(`suggester returned no parseable output (${lastWhy})`);
}

export async function suggestMilestones(
  history: CompanyHistory,
  opts: { cap?: number; today?: string; model?: string } = {},
): Promise<SuggestResult & { raw: { candidates: MilestoneProposal[]; skipped: SkippedCandidate[] } }> {
  const cap = opts.cap ?? DEFAULT_ACTIVE_CAP;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const out = await callModel(history, today, opts.model ?? SCORING_MODEL);
  const activeCount = history.existing.filter((m) => m.status === 'active').length;
  const { proposals, alsoConsidered } = applyCap(out.candidates, activeCount, cap);
  return {
    companyId: history.companyId,
    companyName: history.companyName,
    activeCount,
    cap,
    proposals,
    alsoConsidered,
    skipped: out.skipped,
    raw: out,
  };
}
