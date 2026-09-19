import type { Product, QualificationSignals } from '../../types/domain.js';
import type { DiscoveredCandidate } from '../discovery/types.js';

/** What enrichment produces for a single candidate. */
export interface EnrichmentResult {
  /** 0-100 overall fit for Class One's product line. */
  relevanceScore: number;
  relevanceReasoning: string;
  signals: QualificationSignals;
  summary: string;
  topics: string[];
  /** Slugs from `product_catalog` — never free text, so the CRM can link them. */
  recommendedProductIds: string[];
  recommendedProductNotes?: string;
  model: string;
  costUsd: number;
}

export interface EnrichmentInput {
  candidate: DiscoveredCandidate;
  catalog: Product[];
}

/**
 * The enrichment contract.
 *
 * Two implementations exist: OpenAI, and a keyword heuristic used when no API
 * key is configured. The heuristic is not a stub for tests — it is a real
 * fallback that keeps discovery working (and free) before billing is set up,
 * and it makes the entire pipeline testable without spending money.
 */
export interface AiProvider {
  readonly name: string;
  /** True if this provider costs money, so callers can apply a budget guard. */
  readonly billable: boolean;
  enrich(input: EnrichmentInput): Promise<EnrichmentResult>;
}
