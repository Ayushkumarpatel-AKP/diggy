/**
 * Heuristic field → profile mapping.
 *
 * A deterministic, offline fallback the side panel can use when no LLM brain is
 * configured: it matches a field's label/aria-label/placeholder/name against a
 * small rule table and produces {@link FillInstruction}s. The real (LLM) mapping
 * lives in the model + `fillForm` tool; this just keeps "Fill form" useful
 * offline.
 */
import type { FieldDescriptor, FillInstruction, Profile } from '@diggy/shared';

interface Rule {
  path: string;
  test: RegExp;
  value: (profile: Profile) => string | undefined;
}

const RULES: Rule[] = [
  { path: 'identity.fullName', test: /(full[\s_-]?name|^name$|your name|applicant name)/i, value: (p) => p.identity.fullName },
  { path: 'identity.firstName', test: /(first[\s_-]?name|given[\s_-]?name)/i, value: (p) => p.identity.firstName },
  { path: 'identity.lastName', test: /(last[\s_-]?name|surname|family[\s_-]?name)/i, value: (p) => p.identity.lastName },
  { path: 'identity.email', test: /(e-?mail)/i, value: (p) => p.identity.email },
  { path: 'identity.phone', test: /(phone|mobile|contact[\s_-]?no|whatsapp)/i, value: (p) => p.identity.phone },
  { path: 'identity.dob', test: /(dob|birth)/i, value: (p) => p.identity.dob },
  { path: 'identity.address', test: /(address|street|residence)/i, value: (p) => p.identity.address },
  { path: 'identity.city', test: /(city|town|locality)/i, value: (p) => p.identity.city },
  { path: 'identity.state', test: /(state|province|region)/i, value: (p) => p.identity.state },
  { path: 'identity.country', test: /(country|nationality)/i, value: (p) => p.identity.country },
  { path: 'identity.postalCode', test: /(postal|zip|pin[\s_-]?code|pincode)/i, value: (p) => p.identity.postalCode },
  { path: 'identity.links.github', test: /(github)/i, value: (p) => p.identity.links.github },
  { path: 'identity.links.linkedin', test: /(linked[\s_-]?in)/i, value: (p) => p.identity.links.linkedin },
  { path: 'identity.links.portfolio', test: /(portfolio|website|personal[\s_-]?site|homepage)/i, value: (p) => p.identity.links.portfolio },
  { path: 'identity.links.leetcode', test: /(leetcode)/i, value: (p) => p.identity.links.leetcode },
  { path: 'preferences.workType', test: /(work[\s_-]?type|remote|hybrid|onsite)/i, value: (p) => p.preferences.workType },
  { path: 'preferences.noticePeriod', test: /(notice[\s_-]?period)/i, value: (p) => p.preferences.noticePeriod },
  { path: 'preferences.expectedCtc', test: /(expected[\s_-]?ctc|expected[\s_-]?salary|current[\s_-]?ctc)/i, value: (p) => p.preferences.expectedCtc },
];

function fieldText(field: FieldDescriptor): string {
  return `${field.label ?? ''} ${field.ariaLabel ?? ''} ${field.placeholder ?? ''} ${field.name ?? ''}`.trim();
}

/** Produce best-effort fill instructions for the given fields + profile. */
export function buildHeuristicPlan(fields: FieldDescriptor[], profile: Profile): FillInstruction[] {
  const instructions: FillInstruction[] = [];
  const used = new Set<string>();

  for (const field of fields) {
    if (field.tag === 'select') continue; // textual best-effort only
    const text = fieldText(field);
    if (!text) continue;

    for (const rule of RULES) {
      if (used.has(rule.path) || !rule.test.test(text)) continue;
      const value = rule.value(profile);
      if (!value) continue;
      instructions.push({ fieldId: field.id, value, confidence: 0.5, profilePath: rule.path });
      used.add(rule.path);
      break;
    }
  }

  return instructions;
}
