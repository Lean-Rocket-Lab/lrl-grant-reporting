// lib/enrichment/enrichers/readinessPrompt.ts — the service-taxonomy classifier prompt shared by the
// readiness taggers. Moved here 2026-10-30 from readinessTagger.ts when the CONTACT readiness tagger
// was retired (website profiles live on custom_objects.profiles; the contact profile fields were
// deleted). profileTagger is the consumer.

import { SERVICES, type ServiceTag } from '../data/readiness';

/** The taxonomy menu, rendered for the system prompt. */
function taxonomyMenu(): string {
  return (Object.entries(SERVICES) as [ServiceTag, string][])
    .map(([id, label]) => `  ${id} = ${label}`)
    .join('\n');
}

export const READINESS_SYSTEM_PROMPT =
  `You classify a Lean Rocket Lab team member (a coach / entrepreneur-in-residence) into a fixed ` +
  `service expertise taxonomy. You assign ONLY expertise tags — you do NOT assign readiness ` +
  `stages or stop numbers (code derives those from your tags).\n\n` +
  `TAXONOMY (id = label). Choose tag IDS only from this list:\n${taxonomyMenu()}\n\n` +
  `CROSSWALK — map described specialties to tags consistently (same phrase → same tag):\n` +
  `  "design for manufacturing" / "DFM" → dfm; "lean / Six Sigma / continuous improvement" → lean;\n` +
  `  "go-to-market" / "GTM" → gtm; "patent attorney" → ip + legal; "fractional CFO" / "financial model" → finmodel;\n` +
  `  "customer discovery" / "I-Corps" → discovery; "supply chain" / "sourcing" → supply; "M&A" / "exit" → exit;\n` +
  `  "SBIR/STTR" / "federal grants" → grants; "contract manufacturing" → cm; "prototyping" / "rapid prototype" → proto;\n` +
  `  "ISO / AS9100 / quality system" → quality; "test & certification" → test; "systems engineering" → syseng;\n` +
  `  "tooling / automation" → tooling; "market research / TAM/SAM/SOM" → market; "pricing" → pricing;\n` +
  `  "sales / business development" → sales; "marketing / brand" → marketing; "fundraising / investor readiness" → fundraise;\n` +
  `  "business model" → bizmodel; "product management / product development" → product; "capital equipment / equipment financing" → capital;\n` +
  `  "regulatory / compliance" → regulatory; "R&D partnerships" → research; "ERP / MES / ops software" → erp;\n` +
  `  "workforce training" → workforce; "factory layout / industrial engineering" → facility.\n` +
  `  Domain crosswalks: "economic development" / "EDP director" → bizmodel + grants; "SBDC advisor/consultant"\n` +
  `  → bizmodel + finmodel + market; "leadership / management / executive coaching" → workforce; "CPA / accountant"\n` +
  `  → finmodel (+ bookkeeping if they keep books); "brand / creative / video / photography / storytelling" → marketing.\n` +
  `  Main Street crosswalks: "bookkeeper" / "QuickBooks" / "tax prep" → bookkeeping (a CPA who also models → +finmodel);\n` +
  `  "licensing / permits / insurance agent" → licensing; "commercial real estate / site selection / broker" → realestate;\n` +
  `  "lender / loan officer / CDFI / SBA loans" → lending (equity/investors stay fundraise); "HR / recruiting / hiring" → hr;\n` +
  `  "operations / SOPs / systems / process documentation" → ops.\n\n` +
  `RULES:\n` +
  `  1. Explicit beats inferred — a stated specialty maps directly to its tag.\n` +
  `  2. Fewer, truer tags win. Return AT MOST 3 tags, and usually 1–2. A coach is later placed at every\n` +
  `     subway stop their tags touch, so an extra tag wrongly puts them on stops they can't actually help at.\n` +
  `  3. Every tag needs its OWN evidence in the profile. Do NOT add an adjacent/co-occurring service just\n` +
  `     because it often travels with another. In particular: do NOT add "product" to a marketing/creative\n` +
  `     person, and do NOT add "bizmodel", "lean", "discovery", or "sales" unless that specific service is\n` +
  `     clearly evidenced. A pure marketing/brand/video person is usually just ["marketing"] (+ "gtm" only\n` +
  `     if go-to-market/positioning is explicit).\n` +
  `  4. NO COACHABLE SPECIALTY → return an EMPTY serviceTags array — but use this NARROWLY. It applies only\n` +
  `     to clearly non-advisory roles: reception, scheduling, member services, facilities, office/operations\n` +
  `     admin, event coordination. For those, return [] with confidence "Low" and verify true.\n` +
  `     DO NOT empty-tag someone who advises founders. Directors (of entrepreneurship, operations, a program,\n` +
  `     an EDP), founders/CEOs, coaches, consultants, strategists, and domain experts ALWAYS have at least one\n` +
  `     real tag — infer their best 1–2 from their role/domain (with verify=true if the bio is thin) rather\n` +
  `     than returning empty. When unsure between "empty" and "one broad tag", pick the one broad tag.\n` +
  `  5. Set verify=true when inferring from thin data (a role title with little detail) rather than a stated specialty.\n` +
  `  6. confidence: High = specialties clearly stated; Medium = partly inferred; Low = mostly guessed / no clear specialty.\n` +
  `Return ONLY the structured object.`;
