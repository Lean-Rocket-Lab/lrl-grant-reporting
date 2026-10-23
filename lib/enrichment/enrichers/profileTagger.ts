// lib/enrichment/enrichers/profileTagger.ts — the readiness tagger for PROFILE records
// (custom_objects.profiles, the Team / EIR / Board website profiles that moved off the contact on
// 2026-10-20; docs/sprints/profiles-object.md).
//
// Same classifier as the contact readiness tagger (same system prompt, same taxonomy, same "LLM picks
// service tags, code derives the stops" split) and therefore the same MSRL behavior: the Main Street
// services land the profile on the MSRL line through STOP_SERVICES. Only the I/O differs:
//   • reads the profile's own fields (display_name, job_title, company_name, bio, …)
//   • writes custom_objects.profiles fields, where service_areas is a TRUE multi-select whose option
//     KEYS were minted by scripts-ts/profiles-setup.ts. Tags are converted to those keys here rather
//     than trusting label matching: SERVICES.quality is "Quality Systems (ISO/AS)" but the option is
//     "Quality Systems", which would silently drop.
// Gating (profile_status + roles) is config, see DEFAULT_ENRICHER_CONFIGS in configStore.ts.

import type { Provenance, RecordEnricher, RecordEnricherInput, RecordEnrichmentProposal } from '../types';
import { hasAnthropic, classifyJson, CLASSIFIER_MODEL } from '../../ai/anthropic';
import { SERVICES, SERVICE_KEYS, LINE_KEYS, LINE_STOP_BARE, deriveStops, normalizeTags, type ServiceTag } from '../data/readiness';
import { READINESS_SYSTEM_PROMPT } from './readinessTagger';

export const PROFILES_OBJECT = 'custom_objects.profiles';

/** Profile fields (bare) that describe who the person is and what they do. */
const PROFILE_FIELDS: Array<[key: string, label: string]> = [
  ['display_name', 'Name'],
  ['job_title', 'Job title'],
  ['company_name', 'Company'],
  ['bio', 'Bio'],
  ['linkedin', 'LinkedIn'],
  ['website', 'Website/social'],
];

/** Service tag → the profiles.service_areas option KEY (slug of the option label). */
const OPTION_LABEL_OVERRIDE: Partial<Record<ServiceTag, string>> = { quality: 'Quality Systems' };
export function profileServiceKey(tag: ServiceTag): string {
  const label = OPTION_LABEL_OVERRIDE[tag] ?? SERVICES[tag];
  return label.toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

const CONFIDENCE_LEVELS = ['High', 'Medium', 'Low'] as const;
const CONFIDENCE_SCORE: Record<string, number> = { High: 0.9, Medium: 0.6, Low: 0.3 };
interface Classification { serviceTags: string[]; confidence: 'High' | 'Medium' | 'Low'; verify: boolean; rationale: string }

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    serviceTags: { type: 'array', items: { type: 'string', enum: Object.keys(SERVICES) }, description: 'The 1–3 service-tag ids that best capture this person’s expertise.' },
    confidence: { type: 'string', enum: [...CONFIDENCE_LEVELS] },
    verify: { type: 'boolean', description: 'True when tags were inferred from thin/role-only data and a human should confirm.' },
    rationale: { type: 'string', description: 'One line: why these tags.' },
  },
  required: ['serviceTags', 'confidence', 'verify', 'rationale'],
};

export function deriveProfileRecordText(field: (key: string) => unknown): string {
  const parts: string[] = [];
  for (const [key, label] of PROFILE_FIELDS) {
    const v = field(key);
    const text = Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
    if (text.trim()) parts.push(`${label}: ${text.trim()}`);
  }
  return parts.join('\n');
}

export function buildProfileProposals(
  objectKey: string,
  tags: ServiceTag[],
  confidence: Classification['confidence'],
  verify: boolean,
  rationale: string,
  method: Provenance['method'],
): RecordEnrichmentProposal[] {
  const provenance: Provenance = {
    source: 'anthropic', method, confidence: CONFIDENCE_SCORE[confidence] ?? 0.3,
    timestamp: new Date().toISOString(), rationale: `${CLASSIFIER_MODEL}: ${rationale}`,
  };
  const rationaleText = (verify ? 'VERIFY — ' : '') + (rationale || 'No coachable specialty identified.');
  if (tags.length === 0) {
    return [
      { fieldKey: `${objectKey}.readiness_confidence`, value: confidence, provenance },
      { fieldKey: `${objectKey}.readiness_rationale`, value: rationaleText, provenance },
    ];
  }
  const stops = deriveStops(tags);
  const out: RecordEnrichmentProposal[] = [
    { fieldKey: `${objectKey}.service_areas`, value: tags.map(profileServiceKey), provenance },
  ];
  for (const line of LINE_KEYS) out.push({ fieldKey: `${objectKey}.${LINE_STOP_BARE[line]}`, value: stops[line].map(String), provenance });
  out.push({ fieldKey: `${objectKey}.readiness_confidence`, value: confidence, provenance });
  out.push({
    fieldKey: `${objectKey}.readiness_rationale`, value: rationaleText, provenance,
    derivedFrom: [
      `${objectKey}.service_areas`,
      ...LINE_KEYS.map((line) => `${objectKey}.${LINE_STOP_BARE[line]}`),
      `${objectKey}.readiness_confidence`,
    ],
  });
  return out;
}

export const profileTagger: RecordEnricher = {
  name: 'profile-tagger',
  description:
    'Classify a website Profile (Team / EIR) into the service taxonomy (Claude) and derive its ' +
    'readiness stops, MSRL included. Gate is configurable (default: published/approved, Team or EIR).',
  produces: [
    `${PROFILES_OBJECT}.service_areas`,
    ...LINE_KEYS.map((line) => `${PROFILES_OBJECT}.${LINE_STOP_BARE[line]}`),
    `${PROFILES_OBJECT}.readiness_confidence`,
    `${PROFILES_OBJECT}.readiness_rationale`,
  ],
  async enrich(input: RecordEnricherInput): Promise<RecordEnrichmentProposal[]> {
    if (!hasAnthropic) return [];
    const text = deriveProfileRecordText(input.field);
    if (!text.trim()) return [];
    const result = await classifyJson<Classification>({ system: READINESS_SYSTEM_PROMPT, user: text, schema: SCHEMA, maxTokens: 400 });
    if (!result) return [];
    const tags = normalizeTags(result.serviceTags).filter((t) => SERVICE_KEYS.has(t));
    const confidence = (CONFIDENCE_LEVELS as readonly string[]).includes(result.confidence) ? result.confidence : 'Low';
    return buildProfileProposals(input.objectKey, tags, confidence, Boolean(result.verify), String(result.rationale ?? ''), 'ai');
  },
};
