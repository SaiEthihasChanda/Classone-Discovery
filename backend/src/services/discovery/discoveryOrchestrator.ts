/**
 * The discovery pipeline: fetch -> merge -> dedupe -> enrich -> store.
 *
 * The ordering is the whole design. Dedupe happens BEFORE enrichment, both
 * in-batch (the same professor arriving from OpenAlex, a grant award and a news
 * item in one run) and against the database (someone discovered last week). Every
 * duplicate removed before enrichment is an AI call not paid for — which is why
 * this is the single biggest cost lever in the system.
 *
 * Nothing here writes an `approved` lead. Everything lands as `pending_review`
 * for a human, which is the gate that keeps false positives away from real
 * researchers' inboxes.
 */
import { randomUUID } from 'node:crypto';
import { OPENALEX_TOPIC_GROUPS } from '../../data/openAlexTopics.js';
import { buildKeywordPhrases } from './keywords.js';
import { getBudgetSnapshot, isExhausted, OpenAlexBudgetError } from '../../integrations/openAlexBudget.js';
import { ApiError } from '../../middleware/errorHandler.js';
import { repositories } from '../../repositories/index.js';
import { getSettings } from '../settings/settingsService.js';
import type { Lead, LeadCreateInput, Product } from '../../types/domain.js';
import { normalizeInstitutionKey, normalizeNameKey } from '../../utils/normalize.js';
import { describeLead, logActivity, logDiscoveryRun } from '../activity/activityService.js';
import {
  BudgetExceededError,
  BudgetTracker,
  computeContentHash,
  enrichCandidate,
  getAiProvider,
  isEnrichmentFresh,
} from '../ai/enrichmentService.js';
import type { AiProvider } from '../ai/types.js';
import { attachDetectedInstruments, mergeInstruments } from './instrumentDetector.js';
import {
  countModelQueries,
  estimateOpenAlexCredits,
  fetchFromFacultyPages,
  fetchFromGrants,
  fetchFromNews,
  fetchFromOpenAlex,
} from './sources.js';

/**
 * Raised when a run cannot do its job because the OpenAlex allowance is gone.
 * A 429 rather than a 200-with-warnings: the caller asked for OpenAlex and got
 * nothing from it, which is a failed run, not a successful one with footnotes.
 */
export class OpenAlexExhaustedError extends ApiError {
  constructor(detail: string) {
    const snapshot = getBudgetSnapshot();
    const mins = snapshot.resetInSeconds ? Math.round(snapshot.resetInSeconds / 60) : null;
    super(
      429,
      `OpenAlex daily credit allowance exhausted — ${detail}. ` +
        (mins !== null
          ? `It resets in about ${mins >= 90 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`}. `
          : '') +
        'A free OpenAlex API key raises the allowance 10× (set OPENALEX_API_KEY in .env); ' +
        'see https://openalex.org/pricing for prepaid credits.',
      { code: 'openalex_exhausted', resetInSeconds: snapshot.resetInSeconds },
    );
  }
}
import {
  DEFAULT_REGION,
  type DiscoveredCandidate,
  type DiscoveryRunOptions,
  type DiscoveryRunSummary,
} from './types.js';

/**
 * Leads scoring at or above this are worth an individual feed entry.
 * Everything else is counted in the run summary only — a 500-lead run logged
 * one-by-one would bury every other notification.
 */
const NOTABLE_SCORE_THRESHOLD = 70;

/** Same paper twice (by OpenAlex id, else title) collapses to one entry, order preserved. */
export function dedupePublications<T extends { title: string; sourceId?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((p) => {
    const key = (p.sourceId ?? p.title).trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeGrants<T extends { title: string; sourceId?: string }>(items: T[]): T[] {
  return dedupePublications(items);
}

/**
 * Joins evidence text from two sightings without repeating itself.
 *
 * The same person reached from a topic query, a keyword query and a brand query
 * arrives three times carrying the same abstract; gluing those together
 * produced summaries that were one paragraph repeated three times.
 */
function mergeEvidence(existing: string, incoming: string): string {
  const a = existing.trim();
  const b = incoming.trim();
  if (!b || a.includes(b)) return a;
  if (!a || b.includes(a)) return b;
  return `${a}\n\n${b}`.slice(0, 2500);
}

/** Merges a duplicate candidate into the one already held, keeping the best data. */
function mergeCandidates(
  existing: DiscoveredCandidate,
  incoming: DiscoveredCandidate,
): DiscoveredCandidate {
  return {
    ...existing,
    // Prefer any real value over an absent one, regardless of which source won.
    email: existing.email ?? incoming.email,
    title: existing.title ?? incoming.title,
    orcid: existing.orcid ?? incoming.orcid,
    profileUrl: existing.profileUrl ?? incoming.profileUrl,
    institutionName: existing.institutionName ?? incoming.institutionName,
    department: existing.department ?? incoming.department,
    country: existing.country ?? incoming.country,
    publications: dedupePublications([...existing.publications, ...incoming.publications]).slice(0, 10),
    grants: dedupeGrants([...existing.grants, ...incoming.grants]).slice(0, 10),
    topics: [...new Set([...existing.topics, ...incoming.topics])].slice(0, 12),
    // Evidence from several sources makes for a better-grounded enrichment —
    // but the same source three times over is not several sources.
    evidenceText: mergeEvidence(existing.evidenceText, incoming.evidenceText),
    // The same person surfacing from a topic query AND the Gamry brand query
    // is exactly how instrument ownership gets attached — keep both sightings.
    instruments: mergeInstruments(existing.instruments, incoming.instruments),
  };
}

/** Collapses candidates that describe the same person within a single run. */
export function dedupeWithinBatch(candidates: DiscoveredCandidate[]): DiscoveredCandidate[] {
  const byKey = new Map<string, DiscoveredCandidate>();

  for (const candidate of candidates) {
    // Email is definitive. Otherwise fall back to normalised name+institution,
    // and finally to the name alone for sources (like news) that carry nothing else.
    const nameKey = normalizeNameKey(candidate.name);
    if (!nameKey) continue;

    const institutionKey = normalizeInstitutionKey(candidate.institutionName);
    const key = candidate.email
      ? `email:${candidate.email.toLowerCase()}`
      : institutionKey
        ? `name:${nameKey}|inst:${institutionKey}`
        : `name:${nameKey}`;

    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeCandidates(existing, candidate) : candidate);
  }

  return [...byKey.values()];
}

export interface RunDiscoveryDeps {
  provider?: AiProvider;
  /** Injected by tests to avoid live network calls. */
  fetchers?: {
    openalex?: typeof fetchFromOpenAlex;
    grants?: typeof fetchFromGrants;
    faculty?: typeof fetchFromFacultyPages;
    news?: typeof fetchFromNews;
  };
}

export async function runDiscovery(
  options: DiscoveryRunOptions = {},
  deps: RunDiscoveryDeps = {},
): Promise<DiscoveryRunSummary> {
  const startedAt = Date.now();
  const runId = randomUUID();

  // Explicit run options win; otherwise fall back to the saved settings, and
  // only then to the built-in defaults. That ordering is what makes the Settings
  // page actually govern scheduled runs, which pass no options at all.
  const settings = await getSettings();

  // Derived from the website catalog and brand list, plus anything typed into
  // "additional keywords". An explicit list on the run options wins, which is
  // what the tests use.
  const queries = options.queries?.length
    ? options.queries
    : buildKeywordPhrases({
        brands: settings.discovery.instrumentBrands,
        disabledGroups: settings.discovery.disabledKeywordGroups,
        extraKeywords: settings.discovery.queries,
      });

  const sinceYear =
    options.sinceYear ?? settings.discovery.sinceYear ?? new Date().getFullYear() - 3;
  const region = options.region ?? settings.discovery.region ?? DEFAULT_REGION;
  const institutionKinds = options.institutionKinds ?? settings.discovery.institutionKinds;
  const institutionIds =
    options.institutionIds && options.institutionIds.length > 0 ? options.institutionIds : undefined;
  const enrichFaculty = settings.discovery.enrichFacultyFromOpenAlex;

  // Instrument brands are always used for free text detection; the per-brand
  // full-text search (which costs OpenAlex credits) is the part that can be
  // switched off per run or in settings.
  const instrumentBrands = settings.discovery.instrumentBrands.filter((b) => b.enabled);
  const includeInstrumentSearch =
    options.includeInstrumentSearch ?? settings.discovery.instrumentSearchEnabled;
  // Topic groups are not optional: they are the cheap backbone of the search
  // (1 credit each) and the only part that finds researchers whose abstracts
  // never name a technique. `includeTopicSearch` remains as a test seam.
  const includeTopicSearch = options.includeTopicSearch ?? true;
  const includeKeywordSearch = options.includeKeywordSearch ?? true;
  const topicGroups = includeTopicSearch ? OPENALEX_TOPIC_GROUPS : [];
  const keywordQueries = includeKeywordSearch ? queries : [];
  const searchedBrands = includeInstrumentSearch
    ? instrumentBrands.filter((b) => b.searchEnabled)
    : [];

  // NIH and NSF fund US institutions almost exclusively, so they contribute
  // nothing to an India-targeted run. Dropping them by default avoids spending
  // request time on sources that cannot match — they can still be requested
  // explicitly.
  const defaultSources: DiscoveryRunOptions['sources'] =
    region === 'global'
      ? ['openalex', 'nih', 'nsf', 'faculty', 'news']
      : ['openalex', 'faculty', 'news'];

  const sources = options.sources ?? defaultSources!;

  const openAlexCreditsEstimated = sources.includes('openalex')
    ? estimateOpenAlexCredits({
        topicGroups: topicGroups.length,
        keywords: keywordQueries.length,
        brands: searchedBrands.length,
        models: settings.discovery.identifyModels ? countModelQueries(searchedBrands) : 0,
      })
    : 0;

  // Fail before spending anything, not after a burst of doomed calls. Cache
  // hits would still work, but a run that cannot issue a single new request is
  // not a run the user wants to sit through.
  if (sources.includes('openalex') && isExhausted()) {
    throw new OpenAlexExhaustedError('no OpenAlex queries can be issued right now');
  }

  const fetchers = {
    openalex: deps.fetchers?.openalex ?? fetchFromOpenAlex,
    grants: deps.fetchers?.grants ?? fetchFromGrants,
    faculty: deps.fetchers?.faculty ?? fetchFromFacultyPages,
    news: deps.fetchers?.news ?? fetchFromNews,
  };

  const errors: string[] = [];
  const sourcesRun: string[] = [];
  const rawCandidates: DiscoveredCandidate[] = [];
  let openAlexExhausted = false;

  // --- 1. Fetch, all sources in parallel ----------------------------------
  const jobs: Promise<void>[] = [];

  if (sources.includes('openalex')) {
    sourcesRun.push('openalex');
    jobs.push(
      fetchers
        .openalex(keywordQueries, sinceYear, {
          region,
          institutionKinds,
          institutionIds,
          instrumentBrands: searchedBrands,
          topicGroups,
          identifyModels: settings.discovery.identifyModels,
          instrumentLookbackYears: settings.discovery.instrumentLookbackYears,
        })
        .then((result) => {
          rawCandidates.push(...result.candidates);
          errors.push(...result.errors);
          if (result.budgetExhausted) openAlexExhausted = true;
        }),
    );
  }

  const agencies = sources.filter((s): s is 'nih' | 'nsf' => s === 'nih' || s === 'nsf');
  if (agencies.length > 0) {
    sourcesRun.push(...agencies);
    jobs.push(
      fetchers.grants(queries, sinceYear, agencies).then((result) => {
        rawCandidates.push(...result.candidates);
        errors.push(...result.errors);
      }),
    );
  }

  if (sources.includes('faculty')) {
    sourcesRun.push('faculty');
    jobs.push(
      fetchers.faculty(enrichFaculty, institutionIds).then((result) => {
        rawCandidates.push(...result.candidates);
        errors.push(...result.errors);
      }),
    );
  }

  if (sources.includes('news')) {
    sourcesRun.push('news');
    jobs.push(
      fetchers.news(institutionIds).then((result) => {
        rawCandidates.push(...result.candidates);
        errors.push(...result.errors);
      }),
    );
  }

  // allSettled, not all: a source adapter that throws despite its own guard
  // must not take down the run.
  const settled = await Promise.allSettled(jobs);
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      if (outcome.reason instanceof OpenAlexBudgetError) {
        openAlexExhausted = true;
        continue;
      }
      errors.push(`Source failed: ${String(outcome.reason)}`);
    }
  }

  // Nothing came back and the reason is the allowance: that is a failed run.
  // Partial results still go through — the caller sees the flag and can
  // decide — but zero results dressed as success is what caused the confusion
  // this guards against.
  if (openAlexExhausted && rawCandidates.length === 0) {
    throw new OpenAlexExhaustedError('the run produced no candidates before the allowance ran out');
  }

  // --- 2. Dedupe within the batch, before spending anything ---------------
  const candidates = dedupeWithinBatch(rawCandidates);

  // Free, deterministic, and runs on every candidate regardless of source: an
  // abstract that says "on a CHI 660E" tags the lead even when the brand search
  // did not surface them.
  for (const candidate of candidates) {
    attachDetectedInstruments(candidate, instrumentBrands);
  }
  const instrumentsDetected = candidates.filter((c) => (c.instruments?.length ?? 0) > 0).length;

  // --- 3. Enrich and store ------------------------------------------------
  const catalog: Product[] = await repositories.products.findActive();
  const budget = new BudgetTracker();
  const provider = deps.provider ?? getAiProvider();

  let leadsCreated = 0;
  let duplicatesSkipped = 0;
  let enrichedCount = 0;
  let budgetStopped = false;

  for (const candidate of candidates) {
    if (budgetStopped) break;

    try {
      const nameKey = normalizeNameKey(candidate.name);
      const institutionKey = normalizeInstitutionKey(candidate.institutionName);

      const existing = await repositories.leads.findDuplicate({
        email: candidate.email,
        normalizedNameKey: nameKey,
        institutionKey,
      });

      const contentHash = computeContentHash(candidate);

      if (existing) {
        duplicatesSkipped += 1;
        // Already known and still fresh — the cache hit that saves the money.
        if (isEnrichmentFresh(existing, contentHash)) {
          // ...but a newly seen instrument is still worth recording. Costs no
          // AI call, and it is exactly the case where a lead found last week
          // by a topic query turns up this week in the PalmSens brand search.
          const merged = mergeInstruments(existing.research.instruments, candidate.instruments);
          // Compare by content, not length: a brand-only sighting upgraded to
          // a specific model is the same number of entries and the whole point.
          const fingerprint = (list: typeof merged) =>
            list.map((i) => `${i.brandKey}|${i.model ?? ''}`).sort().join(',');
          if (fingerprint(merged) !== fingerprint(existing.research.instruments ?? [])) {
            await repositories.leads.updateById(existing.id, { research: { instruments: merged } });
          }
          continue;
        }
        await refreshExistingLead(existing, candidate, contentHash, {
          catalog,
          budget,
          provider,
          skipEnrichment: options.skipEnrichment,
        });
        enrichedCount += 1;
        continue;
      }

      const lead = await createLeadFromCandidate(candidate, contentHash, {
        catalog,
        budget,
        provider,
        skipEnrichment: options.skipEnrichment,
      });

      leadsCreated += 1;
      if (!options.skipEnrichment) enrichedCount += 1;

      if ((lead.aiScoring.relevanceScore ?? 0) >= NOTABLE_SCORE_THRESHOLD) {
        await logActivity({
          type: 'lead_discovered',
          message: `New lead discovered — ${describeLead(lead)} (score ${lead.aiScoring.relevanceScore})`,
          relatedLeadId: lead.id,
          metadata: { source: candidate.sourceType, runId },
        });
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        budgetStopped = true;
        errors.push(error.message);
        await logActivity({
          type: 'system_error',
          severity: 'critical',
          message: `Discovery run halted — AI budget ceiling reached ($${budget.spentUsd.toFixed(2)})`,
          metadata: { runId, spentUsd: budget.spentUsd },
        });
        break;
      }
      errors.push(
        `Candidate "${candidate.name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const summary: DiscoveryRunSummary = {
    runId,
    sourcesRun,
    candidatesFound: candidates.length,
    leadsCreated,
    duplicatesSkipped,
    enrichedCount,
    instrumentsDetected,
    openAlexExhausted,
    openAlexCreditsEstimated,
    errors,
    estimatedCostUsd: budget.spentUsd,
    durationMs: Date.now() - startedAt,
  };

  await logDiscoveryRun({
    sourcesRun,
    candidatesFound: candidates.length,
    leadsCreated,
    duplicatesSkipped,
    errors: errors.length,
    durationMs: summary.durationMs,
  });

  return summary;
}

interface StoreOptions {
  catalog: Product[];
  budget: BudgetTracker;
  provider: AiProvider;
  skipEnrichment?: boolean;
}

async function createLeadFromCandidate(
  candidate: DiscoveredCandidate,
  contentHash: string,
  options: StoreOptions,
): Promise<Lead> {
  const enrichment = options.skipEnrichment
    ? null
    : await enrichCandidate(candidate, {
        catalog: options.catalog,
        budget: options.budget,
        provider: options.provider,
      });

  const toCreate: LeadCreateInput = {
    status: 'pending_review',
    source: {
      type: candidate.sourceType,
      sourceUrl: candidate.sourceUrl,
      sourceRecordId: candidate.sourceRecordId,
      discoveredAt: new Date(),
    },
    person: {
      name: candidate.name,
      normalizedNameKey: normalizeNameKey(candidate.name),
      email: candidate.email?.toLowerCase(),
      title: candidate.title,
      orcid: candidate.orcid,
      profileUrl: candidate.profileUrl,
    },
    institution: {
      name: candidate.institutionName,
      normalizedNameKey: normalizeInstitutionKey(candidate.institutionName),
      department: candidate.department,
      country: candidate.country,
    },
    research: {
      summary: enrichment?.summary,
      summaryGeneratedAt: enrichment ? new Date() : undefined,
      summaryModel: enrichment?.model,
      contentHash,
      topics: enrichment?.topics ?? candidate.topics,
      recentPublications: candidate.publications,
      recentGrants: candidate.grants,
      instruments: candidate.instruments ?? [],
    },
    aiScoring: enrichment
      ? {
          relevanceScore: enrichment.relevanceScore,
          relevanceReasoning: enrichment.relevanceReasoning,
          qualificationSignals: enrichment.signals,
          recommendedProductIds: enrichment.recommendedProductIds,
          recommendedProductNotes: enrichment.recommendedProductNotes,
          scoredAt: new Date(),
          scoringModel: enrichment.model,
        }
      : { recommendedProductIds: [] },
    review: {},
    followUpStatusSummary: 'not_started',
    tags: [],
  };

  return repositories.leads.create(toCreate);
}

/** Re-enriches a known lead whose source material has changed, and tops up missing contact data. */
async function refreshExistingLead(
  existing: Lead,
  candidate: DiscoveredCandidate,
  contentHash: string,
  options: StoreOptions,
): Promise<void> {
  const enrichment = options.skipEnrichment
    ? null
    : await enrichCandidate(candidate, {
        catalog: options.catalog,
        budget: options.budget,
        provider: options.provider,
      });

  await repositories.leads.updateById(existing.id, {
    // Only fill gaps — never overwrite a value a human may have corrected.
    person: {
      ...(existing.person.email ? {} : { email: candidate.email?.toLowerCase() }),
      ...(existing.person.title ? {} : { title: candidate.title }),
      ...(existing.person.orcid ? {} : { orcid: candidate.orcid }),
      ...(existing.person.profileUrl ? {} : { profileUrl: candidate.profileUrl }),
    },
    institution: existing.institution.name ? {} : { name: candidate.institutionName },
    research: {
      ...(enrichment ? { summary: enrichment.summary, summaryModel: enrichment.model } : {}),
      contentHash,
      topics: enrichment?.topics ?? existing.research.topics,
      recentPublications: dedupePublications([
        ...existing.research.recentPublications,
        ...candidate.publications,
      ]).slice(0, 10),
      recentGrants: dedupeGrants([...existing.research.recentGrants, ...candidate.grants]).slice(0, 10),
      // Union, never replace: a sighting from last week's run is still true.
      instruments: mergeInstruments(existing.research.instruments, candidate.instruments),
      ...(enrichment ? { summaryGeneratedAt: new Date() } : {}),
    },
    ...(enrichment
      ? {
          aiScoring: {
            relevanceScore: enrichment.relevanceScore,
            relevanceReasoning: enrichment.relevanceReasoning,
            qualificationSignals: enrichment.signals,
            recommendedProductIds: enrichment.recommendedProductIds,
            recommendedProductNotes: enrichment.recommendedProductNotes,
            scoredAt: new Date(),
            scoringModel: enrichment.model,
          },
        }
      : {}),
  });
}
