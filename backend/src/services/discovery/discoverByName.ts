/**
 * The manual "feed a name to the discovery engine" entry point from the proposal.
 *
 * A salesperson hears about a researcher, types the name, and gets a scored,
 * enriched CRM record instead of doing the lookup by hand.
 */
import { repositories } from '../../repositories/index.js';
import { ApiError } from '../../middleware/errorHandler.js';
import { findAuthorByName } from '../../integrations/openAlexClient.js';
import { OpenAlexBudgetError } from '../../integrations/openAlexBudget.js';
import { normalizeInstitutionKey, normalizeNameKey } from '../../utils/normalize.js';
import { describeLead, logActivity } from '../activity/activityService.js';
import { getSettings } from '../settings/settingsService.js';
import { attachDetectedInstruments } from './instrumentDetector.js';
import {
  BudgetTracker,
  computeContentHash,
  enrichCandidate,
  getAiProvider,
} from '../ai/enrichmentService.js';
import type { Lead } from '../../types/domain.js';
import type { AiProvider } from '../ai/types.js';

export interface DiscoverByNameResult {
  lead: Lead | null;
  wasDuplicate: boolean;
  /** Other people OpenAlex matched, so the user can retry with a fuller name. */
  alternatives: Array<{ name: string; institution?: string; profileUrl?: string }>;
}

export async function discoverByName(
  name: string,
  deps: { provider?: AiProvider; institutionId?: string } = {},
): Promise<DiscoverByNameResult> {
  const trimmed = name.trim();
  if (trimmed.length < 3) {
    throw ApiError.badRequest('Please provide at least 3 characters of a name');
  }

  const matches = await findAuthorByName(trimmed, deps.institutionId);
  if (matches.length === 0) {
    return { lead: null, wasDuplicate: false, alternatives: [] };
  }

  // OpenAlex sorts by relevance, so the first hit is the best match. The rest
  // are returned as alternatives rather than silently discarded — common names
  // genuinely are ambiguous and the user is better placed to disambiguate.
  const best = matches[0]!;
  const alternatives = matches.slice(1).map((m) => ({
    name: m.name,
    institution: m.institutionName,
    profileUrl: m.profileUrl,
  }));

  const nameKey = normalizeNameKey(best.name);
  const institutionKey = normalizeInstitutionKey(best.institutionName);

  const existing = await repositories.leads.findDuplicate({
    email: best.email,
    normalizedNameKey: nameKey,
    institutionKey,
  });
  if (existing) {
    return { lead: existing, wasDuplicate: true, alternatives };
  }

  // Same free text pass the bulk pipeline runs, so a by-name lead is tagged
  // with any instrument its indexed topics or works happen to name.
  const settings = await getSettings();
  attachDetectedInstruments(best, settings.discovery.instrumentBrands);

  const provider = deps.provider ?? getAiProvider();
  const catalog = await repositories.products.findActive();
  const enrichment = await enrichCandidate(best, {
    catalog,
    budget: new BudgetTracker(),
    provider,
  });

  const lead = await repositories.leads.create({
    status: 'pending_review',
    source: {
      type: 'manual_discovery_trigger',
      sourceUrl: best.sourceUrl,
      sourceRecordId: best.sourceRecordId,
      discoveredAt: new Date(),
    },
    person: {
      name: best.name,
      normalizedNameKey: nameKey,
      email: best.email?.toLowerCase(),
      title: best.title,
      orcid: best.orcid,
      profileUrl: best.profileUrl,
    },
    institution: {
      name: best.institutionName,
      normalizedNameKey: institutionKey,
      openAlexId: best.institutionOpenAlexId,
      discoveredName: best.institutionName,
      discoveredOpenAlexId: best.institutionOpenAlexId,
      country: best.country,
    },
    research: {
      summary: enrichment.summary,
      summaryGeneratedAt: new Date(),
      summaryModel: enrichment.model,
      contentHash: computeContentHash(best),
      topics: enrichment.topics,
      recentPublications: best.publications,
      recentGrants: best.grants,
      instruments: best.instruments ?? [],
    },
    aiScoring: {
      relevanceScore: enrichment.relevanceScore,
      relevanceReasoning: enrichment.relevanceReasoning,
      qualificationSignals: enrichment.signals,
      recommendedProductIds: enrichment.recommendedProductIds,
      recommendedProductNotes: enrichment.recommendedProductNotes,
      scoredAt: new Date(),
      scoringModel: enrichment.model,
    },
    review: {},
    followUpStatusSummary: 'not_started',
    tags: [],
  });

  await logActivity({
    type: 'lead_discovered',
    message: `Lead discovered by name lookup — ${describeLead(lead)} (score ${enrichment.relevanceScore})`,
    relatedLeadId: lead.id,
  });

  return { lead, wasDuplicate: false, alternatives };
}

export interface BatchNameOutcome {
  name: string;
  status: 'created' | 'duplicate' | 'not_found' | 'skipped' | 'error';
  lead?: Lead;
  message?: string;
}

export interface BatchNameResult {
  outcomes: BatchNameOutcome[];
  created: number;
  duplicates: number;
  notFound: number;
  skipped: number;
  errors: number;
}

/**
 * Looks up many names — a faculty list pasted from a department page, or a
 * conference attendee list.
 *
 * Sequential rather than parallel: OpenAlex asks for courtesy on its free tier,
 * each lookup already costs credits, and a 50-name paste fired at once is
 * neither. When the daily credit allowance runs out mid-batch, the remaining
 * names are reported as skipped instead of each failing in turn.
 */
export async function discoverByNames(
  names: string[],
  deps: { provider?: AiProvider; institutionId?: string } = {},
): Promise<BatchNameResult> {
  const outcomes: BatchNameOutcome[] = [];
  let budgetGone = false;

  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;

    if (budgetGone) {
      outcomes.push({ name, status: 'skipped', message: 'OpenAlex daily allowance exhausted' });
      continue;
    }

    try {
      const result = await discoverByName(name, deps);
      if (!result.lead) {
        outcomes.push({ name, status: 'not_found' });
      } else {
        outcomes.push({
          name,
          status: result.wasDuplicate ? 'duplicate' : 'created',
          lead: result.lead,
        });
      }
    } catch (error) {
      if (error instanceof OpenAlexBudgetError) {
        budgetGone = true;
        outcomes.push({ name, status: 'skipped', message: 'OpenAlex daily allowance exhausted' });
        continue;
      }
      outcomes.push({
        name,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const count = (status: BatchNameOutcome['status']) =>
    outcomes.filter((o) => o.status === status).length;

  return {
    outcomes,
    created: count('created'),
    duplicates: count('duplicate'),
    notFound: count('not_found'),
    skipped: count('skipped'),
    errors: count('error'),
  };
}
