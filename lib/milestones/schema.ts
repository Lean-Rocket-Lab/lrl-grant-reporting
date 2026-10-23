// lib/milestones/schema.ts — the Milestones custom object, as built live 2026-09-29.
// Spec: docs/sprints/milestone-suggester.md §1. Option lists are the KEYS (writes need keys, not labels).

export const MILESTONES_OBJECT = 'custom_objects.milestones';

export const MILESTONE_STATUS = ['proposed', 'active', 'completed', 'dropped'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUS)[number];

export const READINESS_DIMENSION = ['trl', 'mrl', 'crl', 'business_msrl', 'other'] as const;
export type ReadinessDimension = (typeof READINESS_DIMENSION)[number];

// Field key is `milestone_category` — NOT `category` (a deleted text field; one orphan value remains).
export const MILESTONE_CATEGORY = [
  'customer_discovery', 'marketing_brand', 'sales_revenue', 'product_design', 'prototyping_testing',
  'manufacturing_supply_chain', 'operations_systems', 'financial_management', 'funding_capital',
  'legal_ip_compliance', 'team_hiring', 'other',
] as const;
export type MilestoneCategory = (typeof MILESTONE_CATEGORY)[number];

export const MILESTONE_SOURCE = ['staff', 'ai_intake', 'ai_session'] as const;

/** Spec §4a. Max ACTIVE milestones per company; also the max NEW proposals per run. Config, not code. */
export const DEFAULT_ACTIVE_CAP = Number(process.env.MILESTONE_ACTIVE_CAP) || 3;

export interface ExistingMilestone {
  id: string;
  milestone: string;
  status: string;
  definitionOfDone?: string;
  category?: string;
}

export type EvidenceSource = 'zoom_summary' | 'staff_note' | 'activity' | 'email' | 'call_transcript';

export interface MilestoneProposal {
  kind: 'new' | 'completion';
  milestone: string;
  definitionOfDone: string;
  readinessDimension: ReadinessDimension;
  category: MilestoneCategory;
  targetDate: string | null;          // ONLY when a source states it (rule 5)
  confidence: 'high' | 'medium';
  inferred: boolean;                  // rule 7
  priority: number;                   // model's own rank, 1 = most important (cap ordering, §4a)
  rankReason: string;
  evidence: Array<{ source: EvidenceSource; ref: string; date: string; note: string }>;
  relatedExistingMilestoneId: string | null; // rule 4 / completion target
}

export interface SkippedCandidate {
  candidate: string;
  rule: string;   // which rule skipped it, e.g. "rule 2: LRL-owned task"
  reason: string;
}

export interface SuggestResult {
  companyId: string;
  companyName: string;
  activeCount: number;
  cap: number;
  proposals: MilestoneProposal[];      // ≤ (cap − activeCount) new + every completion
  alsoConsidered: MilestoneProposal[]; // over the cap — review screen only, never created
  skipped: SkippedCandidate[];
}
