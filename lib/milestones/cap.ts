// lib/milestones/cap.ts — spec §4a, enforced in code (never trusted to the model).
import type { MilestoneProposal } from './schema';

/**
 * Split the model's proposals into what fits under the active cap and what is only "also considered".
 * - Completions are outside the cap — always kept.
 * - New proposals fill the free slots (cap − currently active), best-ranked first.
 */
export function applyCap(
  all: MilestoneProposal[],
  activeCount: number,
  cap: number,
): { proposals: MilestoneProposal[]; alsoConsidered: MilestoneProposal[] } {
  const completions = all.filter((p) => p.kind === 'completion');
  const fresh = all
    .filter((p) => p.kind !== 'completion')
    .slice()
    .sort((a, b) => a.priority - b.priority || (a.confidence === b.confidence ? 0 : a.confidence === 'high' ? -1 : 1));
  const slots = Math.max(0, cap - activeCount);
  return {
    proposals: [...fresh.slice(0, slots), ...completions],
    alsoConsidered: fresh.slice(slots),
  };
}
