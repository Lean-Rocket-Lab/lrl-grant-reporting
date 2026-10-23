// lib/milestones/evaluate.ts — score a suggester run against an answer key with a judge model. READ-ONLY.
import { classifyJson, SCORING_MODEL } from '../ai/anthropic';
import type { AnswerKey } from './answerKeys';
import type { SuggestResult } from './schema';

export interface EvalResult {
  label: string;
  matched: Array<{ keyId: string; matchedTo: string | null; placement: 'proposal' | 'alsoConsidered' | null; why: string }>;
  violations: Array<{ mustSkip: string; proposal: string }>;
  recall: number;
  pass: boolean;
}

export async function evaluateAgainstKey(key: AnswerKey, run: SuggestResult): Promise<EvalResult> {
  const listed = [
    ...run.proposals.map((p, i) => ({ ref: `P${i + 1}`, placement: 'proposal' as const, p })),
    ...run.alsoConsidered.map((p, i) => ({ ref: `A${i + 1}`, placement: 'alsoConsidered' as const, p })),
  ];
  const user = `ANSWER KEY (what a human expert expects):
${key.expected.map((k) => `- ${k.id}: ${k.milestone}${k.note ? ` [${k.note}]` : ''}`).join('\n')}

MUST-SKIP (proposing any of these is a violation):
${key.mustSkip.map((s) => `- ${s}`).join('\n')}

SUGGESTER OUTPUT:
${listed.map((l) => `- ${l.ref} (${l.p.kind}): ${l.p.milestone} — done when: ${l.p.definitionOfDone}`).join('\n') || '(nothing)'}

For EVERY key item, give the ref of the suggester item that expresses the same outcome (wording may differ;
scope may be a bit broader or narrower), or null. For each must-skip item, report any suggester item that
proposes it.`;
  const out = await classifyJson<{ matches: Array<{ keyId: string; ref: string | null; why: string }>; violations: Array<{ mustSkip: string; ref: string }> }>({
    system: 'You grade a milestone suggester against an expert answer key. Be fair and literal about outcomes, not wording.',
    user,
    model: SCORING_MODEL,
    maxTokens: 3000,
    schema: {
      type: 'object', additionalProperties: false, required: ['matches', 'violations'],
      properties: {
        matches: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['keyId', 'ref', 'why'],
          properties: { keyId: { type: 'string' }, ref: { type: ['string', 'null'] }, why: { type: 'string' } } } },
        violations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['mustSkip', 'ref'],
          properties: { mustSkip: { type: 'string' }, ref: { type: 'string' } } } },
      },
    },
  });
  if (!out) throw new Error(`judge returned nothing for ${key.label}`);
  const byRef = new Map(listed.map((l) => [l.ref, l]));
  const matched = key.expected.map((k) => {
    const m = out.matches.find((x) => x.keyId === k.id);
    const hit = m?.ref ? byRef.get(m.ref) : undefined;
    return { keyId: k.id, matchedTo: hit ? `${hit.ref} ${hit.p.milestone}` : null, placement: hit?.placement ?? null, why: m?.why ?? '' };
  });
  const violations = out.violations.map((v) => ({ mustSkip: v.mustSkip, proposal: byRef.get(v.ref)?.p.milestone ?? v.ref }));
  const recall = matched.filter((m) => m.matchedTo).length / key.expected.length;
  return { label: key.label, matched, violations, recall, pass: recall >= 0.8 && violations.length === 0 };
}
