// lib/profiles/pipeline.ts — what happens when a Profile record changes (GHL "Profile Changed"
// workflow → /api/profile-sync, and the nightly backstop).
//
// One object, two kinds of profile (docs/sprints/profiles-resources-merge.md, 2026-10-23):
//   profile_type = person   → profile-tagger  (a person's expertise; gate also needs Team/EIR)
//   profile_type = resource → resource-tagger (what an ORGANIZATION provides) + the company link
//                             guarantee (lib/ghl/resourceRelations.ts — the form can't make it)
// Each enricher keeps its own editable gate (/enrichment). A profile with no profile_type runs
// nothing and says so — guessing the type would run the wrong classifier.
//
// Wix is deliberately NOT here: Zach froze the Wix Resources/Team collections on 2026-10-23 until the
// new website launches, so profile edits no longer reach Wix.

import { GhlClient, ghl } from '../ghl/client';
import { readRecordFields } from '../ghl/records';
import { enrichRecord } from '../enrichment/recordEngine';
import { resolveEnricherConfig } from '../enrichment/configStore';
import { evaluateGate } from '../enrichment/gate';
import { hasAnthropic } from '../ai/anthropic';
import { profileTagger, PROFILES_OBJECT } from '../enrichment/enrichers/profileTagger';
import { resourceTagger } from '../enrichment/enrichers/resourceTagger';
import { ensureResourceCompanyLink, type ResourceCompanyLinkResult } from '../ghl/resourceRelations';
import type { CustomFieldCatalog } from '../ghl/types';
import type { RecordEnricher } from '../enrichment/types';

export type ProfileKind = 'person' | 'resource';

export interface ProfilePipelineResult {
  status: string;
  kind: ProfileKind | null;
  enrich: { enricher?: string; ran: boolean; applied?: string[]; note?: string };
  companyLink?: ResourceCompanyLinkResult;
}

/** profile_type → kind. Accepts the option key or label, any case. */
export function profileKind(value: unknown): ProfileKind | null {
  const v = String(Array.isArray(value) ? value[0] ?? '' : value ?? '').trim().toLowerCase();
  return v === 'person' || v === 'resource' ? v : null;
}

const ENRICHER_FOR: Record<ProfileKind, RecordEnricher> = { person: profileTagger, resource: resourceTagger };

export async function runProfilePipeline(
  recordId: string,
  catalog: CustomFieldCatalog,
  opts: { apply: boolean; ghlClient?: GhlClient },
): Promise<ProfilePipelineResult> {
  const client = opts.ghlClient ?? ghl();
  let fields: Awaited<ReturnType<typeof readRecordFields>> | null = null;
  try { fields = await readRecordFields(PROFILES_OBJECT, recordId, client); } catch { /* reported below */ }
  if (!fields) return { status: 'not-found', kind: null, enrich: { ran: false, note: 'profile not found' } };

  const status = String(fields.get(`${PROFILES_OBJECT}.profile_status`) ?? '');
  const kind = profileKind(fields.get(`${PROFILES_OBJECT}.profile_type`));
  if (!kind) return { status, kind, enrich: { ran: false, note: 'profile_type not set — nothing to run' } };

  const enricher = ENRICHER_FOR[kind];
  const enrich: ProfilePipelineResult['enrich'] = { enricher: enricher.name, ran: false };
  if (!hasAnthropic) {
    enrich.note = 'ANTHROPIC_API_KEY not set';
  } else {
    const config = await resolveEnricherConfig(enricher.name, PROFILES_OBJECT);
    const decision = evaluateGate((k) => fields!.get(k), config);
    if (decision.run) {
      const er = await enrichRecord(PROFILES_OBJECT, recordId, [enricher], catalog, { mode: 'overwrite' }, { apply: opts.apply, client });
      enrich.ran = true;
      enrich.applied = er.applied.map((a) => a.fieldKey);
    } else {
      enrich.note = decision.reason;
    }
  }

  let companyLink: ResourceCompanyLinkResult | undefined;
  if (kind === 'resource') {
    try {
      companyLink = await ensureResourceCompanyLink(recordId, { apply: opts.apply, client });
    } catch (e: any) {
      companyLink = { status: 'error', applied: false, note: e?.message ?? String(e) };
    }
  }
  return { status, kind, enrich, companyLink };
}
