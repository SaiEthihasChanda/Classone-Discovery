/**
 * Which research domain a person belongs to, and whether the roster keeps it.
 *
 * Decided from a department name when one is known (ORCID employment, faculty
 * page) and from OpenAlex topic fields/subfields otherwise. Chemistry,
 * biology, biotechnology, chemical and biochemical engineering, materials/
 * metallurgy and energy are kept outright. Civil and mechanical engineering
 * are kept only when the person's own keywords or topics mention corrosion or
 * a neighbouring electrochemical subject — a structural engineer working on
 * bridge dynamics is not a potentiostat buyer; one working on rebar corrosion is.
 */
import type { FacultyDomain } from '../../types/domain.js';

export const KEPT_DOMAINS: ReadonlySet<FacultyDomain> = new Set([
  'chemistry',
  'biology',
  'biotechnology',
  'chemical_engineering',
  'biochemical_engineering',
  'materials',
  'energy',
]);

/** Domains kept only past the corrosion gate. */
export const GATED_DOMAINS: ReadonlySet<FacultyDomain> = new Set(['civil', 'mechanical']);

export const DOMAIN_LABELS: Record<FacultyDomain, string> = {
  chemistry: 'Chemistry',
  biology: 'Biology',
  biotechnology: 'Biotechnology',
  chemical_engineering: 'Chemical Engineering',
  biochemical_engineering: 'Biochemical Engineering',
  materials: 'Materials / Metallurgy',
  energy: 'Energy',
  civil: 'Civil Engineering (corrosion)',
  mechanical: 'Mechanical Engineering (corrosion)',
  other: 'Other',
};

/**
 * Department-name rules, most specific first. "Chemical Engineering" must be
 * tested before "Chemistry"-ish patterns or it would land in chemistry;
 * "Biochemical Engineering" before "Chemical Engineering" for the same reason.
 */
const DEPARTMENT_RULES: Array<[RegExp, FacultyDomain]> = [
  [/\bbio-?chemical\s+eng/i, 'biochemical_engineering'],
  [/\bchemical\s+(and\s+bio\w*\s+)?eng/i, 'chemical_engineering'],
  [/\bchemical\s+(sciences?|technology)\b/i, 'chemistry'],
  [/\bchemistry\b/i, 'chemistry'],
  [/\bbio-?technolog/i, 'biotechnology'],
  [/\bbio-?(medical|engineering|sciences?\s+and\s+bio-?engineering)\b/i, 'biotechnology'],
  [/\bbio-?engineering\b/i, 'biotechnology'],
  [/\bbio-?chemistry\b/i, 'biology'],
  [/\b(biolog|bio-?sciences?|life\s+sciences?|biological\s+sciences?|microbiolog|zoolog|botan|neuroscience|genetics|molecular)/i, 'biology'],
  [/\b(metallurg|materials?\b|nano-?(science|technology|materials?)|ceramic|polymer\s+(science|engineering|technology))/i, 'materials'],
  [/\b(energy|solar|photovoltaic|battery|hydrogen|fuel\s+cell|electrochem)/i, 'energy'],
  [/\b(civil|structural|construction|infrastructure|ocean\s+eng|coastal)\b/i, 'civil'],
  [/\b(mechanical|manufactur|production\s+eng|industrial\s+eng|automobile)\b/i, 'mechanical'],
];

/** OpenAlex topic fields and subfields, mapped the same way. */
const TOPIC_RULES: Array<[RegExp, FacultyDomain]> = [
  [/\bbiochemical\s+engineering\b/i, 'biochemical_engineering'],
  [/\bchemical\s+engineering\b/i, 'chemical_engineering'],
  [/\belectrochemistry\b/i, 'chemistry'],
  [/\bchemistry\b/i, 'chemistry'],
  [/\bbiotechnology\b/i, 'biotechnology'],
  [/\bbiomedical\s+engineering\b/i, 'biotechnology'],
  [/\bbioengineering\b/i, 'biotechnology'],
  [/\b(biochemistry|genetics|molecular\s+biology|immunology|microbiology|biological\s+sciences|agricultural\s+and\s+biological|neuroscience|cell\s+biology|pharmacolog)/i, 'biology'],
  [/\b(materials?\s+(science|chemistry)|metals?\s+and\s+alloys|ceramics|polymers|nanotechnology|surfaces|electronic,?\s+optical)/i, 'materials'],
  [/\b(energy|fuel\s+technology|renewable|electrochemical\s+energy)\b/i, 'energy'],
  [/\b(civil\s+and\s+structural|building\s+and\s+construction|geotechnical|ocean\s+engineering)\b/i, 'civil'],
  [/\b(mechanical\s+engineering|mechanics\s+of\s+materials|industrial\s+and\s+manufacturing|automotive)\b/i, 'mechanical'],
];

/**
 * Terms that let a civil/mechanical member through: corrosion itself and the
 * techniques and failure modes that go with an electrochemical study of it.
 */
export const CORROSION_GATE_TERMS: string[] = [
  'corrosion',
  'corrosive',
  'anti-corrosion',
  'anticorrosion',
  'cathodic protection',
  'anodic protection',
  'rebar',
  'reinforcement corrosion',
  'chloride ingress',
  'chloride penetration',
  'carbonation',
  'concrete durability',
  'durability of concrete',
  'passivation',
  'passive film',
  'pitting',
  'galvanic',
  'coating degradation',
  'protective coating',
  'inhibitor',
  'electrochemical',
  'impedance spectroscopy',
  'polarization',
  'polarisation',
  'biofouling',
  'microbiologically influenced',
  'stress corrosion',
  'hydrogen embrittlement',
  'erosion-corrosion',
  'tribocorrosion',
];

export function domainFromDepartment(department?: string | null): FacultyDomain {
  const d = (department ?? '').trim();
  if (!d) return 'other';
  for (const [re, domain] of DEPARTMENT_RULES) if (re.test(d)) return domain;
  return 'other';
}

/**
 * The dominant domain across a researcher's OpenAlex topics. Each topic votes
 * with its work count (or 1); "other" never wins over a kept domain with any
 * votes at all, since a chemist also publishes in "Engineering".
 */
export function domainFromTopics(
  topics: Array<{ field?: string; subfield?: string; name?: string; count?: number }>,
): FacultyDomain {
  const votes = new Map<FacultyDomain, number>();
  for (const t of topics) {
    const weight = t.count && t.count > 0 ? t.count : 1;
    // Subfield first: "Electrochemistry" is more telling than its field.
    let domain: FacultyDomain = 'other';
    for (const text of [t.subfield, t.field, t.name]) {
      if (!text) continue;
      const hit = TOPIC_RULES.find(([re]) => re.test(text));
      if (hit) {
        domain = hit[1];
        break;
      }
    }
    votes.set(domain, (votes.get(domain) ?? 0) + weight);
  }
  let best: FacultyDomain = 'other';
  let bestVotes = 0;
  for (const [domain, n] of votes) {
    if (domain === 'other') continue;
    if (n > bestVotes) {
      best = domain;
      bestVotes = n;
    }
  }
  return best;
}

/** Corrosion-gate terms present in the text, lowercase, deduplicated. */
export function corrosionGateTerms(text: string): string[] {
  const hay = text.toLowerCase();
  return CORROSION_GATE_TERMS.filter((term) => hay.includes(term));
}

export interface DomainDecision {
  domain: FacultyDomain;
  kept: boolean;
  gateTerms?: string[];
  reason?: string;
}

/**
 * The roster decision for one person: their domain and whether it is kept.
 * `text` is everything known about their research (keywords, topics, bio),
 * consulted only for the gated domains.
 */
export function decideDomain(params: {
  department?: string | null;
  topics?: Array<{ field?: string; subfield?: string; name?: string; count?: number }>;
  text?: string;
}): DomainDecision {
  let domain = domainFromDepartment(params.department);
  if (domain === 'other' && params.topics?.length) domain = domainFromTopics(params.topics);

  if (KEPT_DOMAINS.has(domain)) return { domain, kept: true };

  if (GATED_DOMAINS.has(domain)) {
    const terms = corrosionGateTerms(params.text ?? '');
    if (terms.length > 0) return { domain, kept: true, gateTerms: terms };
    return { domain, kept: false, reason: `domain: ${DOMAIN_LABELS[domain]} without corrosion-related work` };
  }

  return {
    domain,
    kept: false,
    reason: params.department ? `domain: ${params.department}` : 'domain: outside the kept departments',
  };
}
