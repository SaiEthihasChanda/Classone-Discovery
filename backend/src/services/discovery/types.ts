/**
 * The common shape every discovery source produces.
 *
 * OpenAlex, NIH, NSF, faculty pages and news pages all return wildly different
 * payloads. Each source adapter normalises into this one type, so the
 * orchestrator's dedupe -> enrich -> store pipeline is written once rather than
 * five times.
 */
import type { InstitutionKind } from '../../data/indianInstitutions.js';
import type { InstrumentVendor } from '../../data/instrumentBrands.js';
import type { LeadGrant, LeadInstrument, LeadPublication, LeadSourceType } from '../../types/domain.js';

/**
 * An instrument a researcher has been seen using. Carried on the candidate so
 * dedupe can merge sightings from several papers before anything is stored.
 */
export type DetectedInstrument = LeadInstrument;
export type { InstrumentVendor };

export interface DiscoveredCandidate {
  sourceType: LeadSourceType;
  /** Stable id from the origin system. Makes re-discovery idempotent. */
  sourceRecordId: string;
  sourceUrl?: string;

  name: string;
  email?: string;
  title?: string;
  orcid?: string;
  profileUrl?: string;

  institutionName?: string;
  /** OpenAlex institution id when the source knows it — exact matching downstream. */
  institutionOpenAlexId?: string;
  department?: string;
  country?: string;

  publications: LeadPublication[];
  grants: LeadGrant[];
  topics: string[];

  /**
   * The text the AI actually reads — abstracts, bios, grant summaries.
   * Assembled by the source adapter and trimmed before it reaches a prompt,
   * since token count is the direct cost driver.
   */
  evidenceText: string;

  /**
   * Instruments this person has been seen using — from a brand full-text search
   * hit or a model name in the abstract. Optional so test fixtures and adapters
   * that cannot know (grants, news) need not set it.
   */
  instruments?: DetectedInstrument[];
}

export interface SourceResult {
  source: string;
  candidates: DiscoveredCandidate[];
  /** Non-fatal problems. One failing source must never abort the whole run. */
  errors: string[];
  /** The OpenAlex daily allowance ran out during this source's work. */
  budgetExhausted?: boolean;
}

export interface DiscoveryRunOptions {
  /**
   * Extra keyword phrases on top of the derived set (see
   * `services/discovery/keywords.ts`). Tests pass an explicit list here.
   */
  queries?: string[];
  /** Only consider work published/awarded in or after this year. */
  sinceYear?: number;
  sources?: Array<'openalex' | 'nih' | 'nsf' | 'faculty' | 'news'>;
  /** Skip AI enrichment. Used by tests and dry runs to avoid spend. */
  skipEnrichment?: boolean;
  /**
   * Geographic/institutional targeting for OpenAlex.
   *
   * `indian_institutes` restricts results to the IIT/NIT/IIIT list in
   * `data/indianInstitutions.ts`; `india` widens to any Indian institution;
   * `global` applies no restriction.
   */
  region?: DiscoveryRegion;
  /** Narrows `indian_institutes` to specific categories. Empty means all three. */
  institutionKinds?: InstitutionKind[];
  /**
   * Restrict the run to specific institutes (OpenAlex ids from
   * `data/indianInstitutions.ts`). Takes precedence over `institutionKinds`.
   * Faculty and news targets are narrowed to the same institutes.
   */
  institutionIds?: string[];
  /**
   * Also run one full-text query per enabled instrument brand (PalmSens,
   * CorrTest and competitors), so leads are tagged with the equipment they
   * already use. Costs 10 OpenAlex credits per brand. Defaults to the setting.
   */
  includeInstrumentSearch?: boolean;
  /** Test seam: skip the topic-group queries. Always on in normal use. */
  includeTopicSearch?: boolean;
  /** Test seam: skip the keyword queries. Always on in normal use. */
  includeKeywordSearch?: boolean;
  /** Check each new lead is still at the institute (free author lookup). Defaults to the setting. */
  verifyAffiliations?: boolean;
}

export type DiscoveryRegion = 'indian_institutes' | 'india' | 'global';

export interface DiscoveryRunSummary {
  runId: string;
  sourcesRun: string[];
  candidatesFound: number;
  leadsCreated: number;
  duplicatesSkipped: number;
  enrichedCount: number;
  /** Candidates on which at least one instrument brand was identified. */
  instrumentsDetected: number;
  /** Leads whose affiliation check found they had moved or could not be placed. */
  affiliationChanges: number;
  /**
   * OpenAlex's daily allowance ran out during the run. Whatever was fetched
   * before that is included; the UI treats this as a failure to surface, not a
   * footnote.
   */
  openAlexExhausted: boolean;
  /** Credits the run was expected to spend on OpenAlex (cache hits reduce the real figure). */
  openAlexCreditsEstimated: number;
  errors: string[];
  estimatedCostUsd: number;
  durationMs: number;
}

/**
 * Additional keyword phrases typed on the Settings page, on top of the derived
 * set.
 *
 * Empty by default: the keyword set is now COMPUTED from the website's subject
 * terms, the catalog's application areas and per-product keywords, its model
 * names and the brand list (see `services/discovery/keywords.ts`). Typing the
 * product range in by hand is exactly the drift that change removes; this list
 * exists only for a one-off term the derived set does not cover.
 */
export const DEFAULT_QUERIES: string[] = [];

/** Targeting used when a run does not specify one. */
export const DEFAULT_REGION: DiscoveryRegion = 'indian_institutes';
