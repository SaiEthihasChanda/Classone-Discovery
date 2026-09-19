/**
 * Keyword-based enrichment — the free fallback used when no OpenAI key is set.
 *
 * Not a test stub. It keeps discovery fully functional before billing is
 * configured, gives a zero-cost mode for large exploratory runs, and means the
 * whole pipeline can be tested end-to-end without spending anything.
 *
 * It scores by matching a candidate's evidence text against the product
 * catalog's own application areas and tags, so it stays in step with the catalog
 * rather than hardcoding a keyword list.
 */
import type { QualificationSignals } from '../../types/domain.js';
import type { AiProvider, EnrichmentInput, EnrichmentResult } from './types.js';

/**
 * Terms that indicate electrochemistry work, weighted by how specific they are.
 * "potentiostat" is near-conclusive; "electrode" appears in adjacent fields too.
 */
const DOMAIN_TERMS: Array<{ term: string; weight: number }> = [
  { term: 'potentiostat', weight: 30 },
  { term: 'galvanostat', weight: 25 },
  { term: 'voltammetry', weight: 22 },
  { term: 'cyclic voltammetry', weight: 25 },
  { term: 'impedance spectroscopy', weight: 25 },
  { term: 'electrochemical impedance', weight: 25 },
  { term: 'spectroelectrochemistry', weight: 28 },
  { term: 'amperometr', weight: 20 },
  { term: 'chronoamperometry', weight: 22 },
  { term: 'electrocatal', weight: 20 },
  { term: 'electrochemical', weight: 18 },
  { term: 'electrochemistry', weight: 20 },
  { term: 'biosensor', weight: 18 },
  { term: 'screen-printed electrode', weight: 24 },
  { term: 'electrode', weight: 10 },
  { term: 'battery', weight: 12 },
  { term: 'batteries', weight: 12 },
  { term: 'solid-state electrolyte', weight: 15 },
  { term: 'fuel cell', weight: 14 },
  { term: 'corrosion', weight: 14 },
  { term: 'electrolyte', weight: 10 },
  { term: 'redox', weight: 10 },
  { term: 'catalysis', weight: 8 },
  { term: 'photoelectrochemical', weight: 16 },
  // The rest of the range: electrodes, TOB battery equipment, Nano deposition.
  { term: 'glassy carbon', weight: 18 },
  { term: 'reference electrode', weight: 16 },
  { term: 'rotating disk', weight: 18 },
  { term: 'coin cell', weight: 16 },
  { term: 'pouch cell', weight: 16 },
  { term: 'supercapacitor', weight: 16 },
  { term: 'electrodeposition', weight: 16 },
  { term: 'quartz crystal microbalance', weight: 18 },
  { term: 'pulsed laser deposition', weight: 14 },
  { term: 'sputter', weight: 10 },
  { term: 'thin film', weight: 8 },
];

/** Institutions with heavy research funding tend to have equipment budgets. */
const STRONG_INSTITUTION_MARKERS = [
  'institute of technology',
  'university',
  'polytechnic',
  'national laboratory',
  'research council',
  'academy of sciences',
];

function countMatches(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export class HeuristicProvider implements AiProvider {
  /**
   * Deliberately NOT formatted like a model identifier — there is no model here.
   * This is a hand-written scoring function: weighted keyword counts and catalog
   * tag matching, no ML of any kind. The version suffix exists so a stored score
   * can be traced back to the weights that produced it.
   */
  readonly name = 'rule-based-scoring (no AI model) v1';
  readonly billable = false;

  async enrich({ candidate, catalog }: EnrichmentInput): Promise<EnrichmentResult> {
    const haystack = [
      candidate.evidenceText,
      candidate.topics.join(' '),
      candidate.publications.map((p) => p.title).join(' '),
      candidate.grants.map((g) => g.title).join(' '),
      candidate.title ?? '',
    ]
      .join(' ')
      .toLowerCase();

    // --- Product relevance: weighted domain-term hits, saturating ----------
    let rawRelevance = 0;
    const matchedTerms: string[] = [];
    for (const { term, weight } of DOMAIN_TERMS) {
      const hits = countMatches(haystack, term);
      if (hits > 0) {
        matchedTerms.push(term);
        // Diminishing returns: repeating a word does not make a lead better.
        rawRelevance += weight * Math.min(hits, 2) * (hits > 1 ? 0.75 : 1);
      }
    }

    // Owning a potentiostat is the strongest possible evidence of doing
    // potentiostat work — stronger than any keyword. A competitor's unit means
    // a proven buyer of this category; a PalmSens/CorrTest means an existing
    // customer. Either way the lead is real; the sales motion differs.
    const instruments = candidate.instruments ?? [];
    const ownsClassOne = instruments.some((i) => i.vendor === 'classone');
    const ownsCompetitor = instruments.some((i) => i.vendor === 'competitor');
    if (ownsClassOne || ownsCompetitor) rawRelevance += 35;

    const productRelevance = Math.min(100, Math.round(rawRelevance));

    // --- Recency: how recent is their newest publication or grant ----------
    const years = [
      ...candidate.publications.map((p) => p.year),
      ...candidate.grants.map((g) => g.year),
    ].filter((y): y is number => typeof y === 'number');

    const currentYear = new Date().getFullYear();
    const newest = years.length > 0 ? Math.max(...years) : undefined;
    const recency =
      newest === undefined
        ? 50 // Unknown, not zero — absence of a date is not evidence of staleness.
        : Math.max(0, Math.min(100, 100 - (currentYear - newest) * 20));

    // --- Institutional strength -------------------------------------------
    const institution = (candidate.institutionName ?? '').toLowerCase();
    const hasMarker = STRONG_INSTITUTION_MARKERS.some((m) => institution.includes(m));
    const grantMoney = candidate.grants.reduce((sum, g) => sum + (g.amount ?? 0), 0);
    const institutionalStrength = Math.min(
      100,
      (institution ? 40 : 20) + (hasMarker ? 25 : 0) + (grantMoney > 250_000 ? 30 : grantMoney > 0 ? 15 : 0),
    );

    // --- Engagement potential: can we actually reach them? -----------------
    const engagementPotential = Math.min(
      100,
      (candidate.email ? 45 : 10) +
        (candidate.profileUrl ? 15 : 0) +
        (candidate.orcid ? 10 : 0) +
        (candidate.publications.length > 0 ? 15 : 0) +
        (candidate.grants.length > 0 ? 15 : 0),
    );

    const signals: QualificationSignals = {
      productRelevance,
      institutionalStrength,
      recency,
      engagementPotential,
    };

    // Product relevance dominates deliberately: a well-funded, reachable
    // researcher who does not do electrochemistry is still not a lead.
    const relevanceScore = Math.round(
      productRelevance * 0.55 +
        recency * 0.15 +
        institutionalStrength * 0.15 +
        engagementPotential * 0.15,
    );

    // --- Product mapping against the real catalog --------------------------
    const scoredProducts = catalog
      .filter((product) => product.isActive)
      .map((product) => {
        const terms = [...product.applicationAreas, ...product.tags].map((t) => t.toLowerCase());
        const hits = terms.filter((term) => term.length > 3 && haystack.includes(term)).length;
        return { productId: product.productId, hits };
      })
      .filter((entry) => entry.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 3);

    const summary = this.buildSummary(candidate, matchedTerms);

    const instrumentNote =
      instruments.length > 0
        ? ` Uses ${[...new Set(instruments.map((i) => i.model ?? i.brand))].slice(0, 4).join(', ')}` +
          (ownsClassOne ? ' (existing Class One brand user).' : ' (competitor equipment — proven buyer).')
        : '';

    return {
      relevanceScore,
      relevanceReasoning:
        (matchedTerms.length > 0
          ? `Keyword match on: ${matchedTerms.slice(0, 6).join(', ')}.`
          : 'No electrochemistry-related terms found in the available text.') + instrumentNote,
      signals,
      summary,
      topics: candidate.topics.slice(0, 8),
      recommendedProductIds: scoredProducts.map((p) => p.productId),
      recommendedProductNotes:
        scoredProducts.length > 0
          ? 'Matched by catalog application areas and tags (keyword heuristic).'
          : undefined,
      model: this.name,
      costUsd: 0,
    };
  }

  /** An extractive summary — the first sentences of the evidence text, trimmed. */
  private buildSummary(
    candidate: EnrichmentInput['candidate'],
    matchedTerms: string[],
  ): string {
    const parts: string[] = [];

    if (candidate.institutionName) {
      parts.push(`${candidate.name} (${candidate.institutionName}).`);
    }

    const sentences = candidate.evidenceText
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.trim().length > 20)
      .slice(0, 2);
    if (sentences.length > 0) parts.push(sentences.join(' '));

    if (candidate.grants.length > 0) {
      const grant = candidate.grants[0]!;
      parts.push(`Funded: "${grant.title}"${grant.agency ? ` (${grant.agency})` : ''}.`);
    }

    if (matchedTerms.length > 0) {
      parts.push(`Relevant areas: ${matchedTerms.slice(0, 4).join(', ')}.`);
    }

    return parts.join(' ').slice(0, 900);
  }
}
