import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getAiProvider } from '../services/ai/enrichmentService.js';
import { discoverByName, discoverByNames } from '../services/discovery/discoverByName.js';
import { runDiscovery } from '../services/discovery/discoveryOrchestrator.js';
import { getSettings } from '../services/settings/settingsService.js';
import {
  brandSearchTerms,
  buildKeywordGroups,
  buildKeywordPhrases,
  modelsToIdentify,
} from '../services/discovery/keywords.js';
import { INDIAN_INSTITUTIONS, institutionCounts } from '../data/indianInstitutions.js';
import { getBudgetSnapshot } from '../integrations/openAlexBudget.js';
import { getCacheStats } from '../integrations/openAlexClient.js';
import { OPENALEX_TOPIC_GROUPS } from '../data/openAlexTopics.js';
import { countModelQueries, estimateOpenAlexCredits } from '../services/discovery/sources.js';
import { env } from '../config/env.js';

export const discoveryRouter = Router();

const runSchema = z.object({
  queries: z.array(z.string().trim().min(2)).max(200).optional(),
  sinceYear: z.coerce.number().int().min(1990).max(2100).optional(),
  sources: z
    .array(z.enum(['openalex', 'nih', 'nsf', 'faculty', 'news']))
    .min(1)
    .optional(),
  skipEnrichment: z.boolean().optional(),
  region: z.enum(['indian_institutes', 'india', 'global']).optional(),
  institutionKinds: z.array(z.enum(['IIT', 'NIT', 'IIIT'])).optional(),
  // OpenAlex institution ids, e.g. "I68891433". Validated against the known
  // list so a typo cannot silently widen a run to "no filter".
  institutionIds: z
    .array(z.string().regex(/^I\d+$/))
    .max(100)
    .optional()
    .refine(
      (ids) => !ids || ids.every((id) => INDIAN_INSTITUTIONS.some((i) => i.openAlexId === id)),
      'Unknown institution id',
    ),
  includeInstrumentSearch: z.boolean().optional(),
  includeTopicSearch: z.boolean().optional(),
  includeKeywordSearch: z.boolean().optional(),
});

/**
 * GET /api/discovery/config — what a run would do, before running it.
 * Lets the UI show which sources are live and which AI provider is in use.
 */
discoveryRouter.get(
  '/config',
  asyncHandler(async (_req, res) => {
    const settings = await getSettings();
    const provider = getAiProvider();
    const keywordPhrases = buildKeywordPhrases({
      brands: settings.discovery.instrumentBrands,
      disabledGroups: settings.discovery.disabledKeywordGroups,
      extraKeywords: settings.discovery.queries,
    });

    res.json({
      defaultQueries: keywordPhrases,
      aiProvider: { name: provider.name, billable: provider.billable },
      budgetUsd: env.OPENAI_RUN_BUDGET_USD,
      scrapeTargets: {
        faculty: settings.facultyTargets.filter((t) => t.enabled).length,
        news: settings.newsTargets.filter((t) => t.enabled).length,
      },
      cronEnabled: env.CRON_ENABLED,
      discoverySchedule: env.CRON_DISCOVERY_SCHEDULE,
      defaultRegion: settings.discovery.region,
      institutions: {
        counts: institutionCounts(),
        total: INDIAN_INSTITUTIONS.length,
      },
      // Which brands a run will spend a full-text query on, so the page can
      // show the credit cost before the button is pressed — and, for each, the
      // terms actually derived for it, since nothing is typed in any more.
      instrumentSearch: {
        enabledByDefault: settings.discovery.instrumentSearchEnabled,
        searchedBrands: settings.discovery.instrumentBrands
          .filter((b) => b.enabled && b.searchEnabled)
          .map((b) => ({ key: b.key, brand: b.brand, vendor: b.vendor })),
        detectedBrands: settings.discovery.instrumentBrands.filter((b) => b.enabled).length,
        brands: settings.discovery.instrumentBrands.map((b) => ({
          key: b.key,
          terms: brandSearchTerms(b),
          models: modelsToIdentify(b).map((m) => m.model),
        })),
        identifyModels: settings.discovery.identifyModels,
        modelQueries: countModelQueries(settings.discovery.instrumentBrands),
      },
      // OpenAlex enforces a daily credit allowance (1000 credits / $0.10, reset
      // at midnight UTC). Surfaced so an exhausted budget is visible in the UI
      // rather than showing up as mysteriously unscored leads.
      openAlexBudget: getBudgetSnapshot(),
      openAlexCache: getCacheStats(),
      openAlexApiKeyConfigured: Boolean(env.OPENALEX_API_KEY),
      // Topic groups always run; they are the backbone of the search.
      topicSearch: {
        groups: OPENALEX_TOPIC_GROUPS.map((g) => ({
          key: g.key,
          label: g.label,
          productLine: g.productLine,
          topics: g.topics.length,
        })),
      },
      keywordSearch: {
        phrases: keywordPhrases.length,
        groups: buildKeywordGroups(settings.discovery.instrumentBrands).map((g) => ({
          key: g.key,
          label: g.label,
          description: g.description,
          searchedAs: g.searchedAs,
          count: g.phrases.length,
          // The whole list, so Settings can show exactly what is searched.
          phrases: g.phrases,
          enabled: !settings.discovery.disabledKeywordGroups.includes(g.key),
        })),
        extra: settings.discovery.queries,
      },
      // What a default run costs, so the page can show it next to the balance.
      estimatedCreditsPerRun: estimateOpenAlexCredits({
        topicGroups: OPENALEX_TOPIC_GROUPS.length,
        keywords: keywordPhrases.length,
        brands: settings.discovery.instrumentSearchEnabled
          ? settings.discovery.instrumentBrands.filter((b) => b.enabled && b.searchEnabled).length
          : 0,
        models:
          settings.discovery.instrumentSearchEnabled && settings.discovery.identifyModels
            ? countModelQueries(settings.discovery.instrumentBrands)
            : 0,
      }),
    });
  }),
);

/**
 * GET /api/discovery/institutions — the IIT/NIT/IIIT list discovery targets.
 * Optional `?kind=IIT` filter.
 */
discoveryRouter.get(
  '/institutions',
  asyncHandler(async (req, res) => {
    const kind = req.query.kind;
    const filtered =
      typeof kind === 'string' && ['IIT', 'NIT', 'IIIT'].includes(kind)
        ? INDIAN_INSTITUTIONS.filter((i) => i.kind === kind)
        : INDIAN_INSTITUTIONS;

    res.json({
      items: [...filtered].sort((a, b) => b.worksCount - a.worksCount),
      total: filtered.length,
      counts: institutionCounts(),
    });
  }),
);

/**
 * POST /api/discovery/run — runs the pipeline now.
 *
 * Synchronous: a run is minutes, not hours, and the caller wants the summary.
 * If runs grow long enough to time out an HTTP request, this is the place to
 * switch to a job queue (see the plan's deferred BullMQ note).
 */
discoveryRouter.post(
  '/run',
  asyncHandler(async (req, res) => {
    const options = runSchema.parse(req.body ?? {});
    const summary = await runDiscovery(options);
    res.json(summary);
  }),
);

const institutionIdSchema = z
  .string()
  .regex(/^I\d+$/)
  .refine((id) => INDIAN_INSTITUTIONS.some((i) => i.openAlexId === id), 'Unknown institution id');

const byNameSchema = z.object({
  name: z.string().trim().min(3, 'Provide at least 3 characters'),
  institutionId: institutionIdSchema.optional(),
});

const byNamesSchema = z.object({
  names: z
    .array(z.string().trim().min(3, 'Each name needs at least 3 characters'))
    .min(1, 'Provide at least one name')
    .max(50, 'At most 50 names per batch — each costs OpenAlex credits'),
  institutionId: institutionIdSchema.optional(),
});

// POST /api/discovery/by-names — batch version: one name per line pasted in.
// Synchronous like /run; 50 sequential lookups is well under a minute.
discoveryRouter.post(
  '/by-names',
  asyncHandler(async (req, res) => {
    const { names, institutionId } = byNamesSchema.parse(req.body);
    // Dedupe case-insensitively so a pasted list with a repeated name is not
    // charged twice.
    const seen = new Set<string>();
    const unique = names.filter((n) => {
      const key = n.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    res.json(await discoverByNames(unique, { institutionId }));
  }),
);

// POST /api/discovery/by-name — the manual "feed a name" trigger.
discoveryRouter.post(
  '/by-name',
  asyncHandler(async (req, res) => {
    const { name, institutionId } = byNameSchema.parse(req.body);
    const result = await discoverByName(name, { institutionId });

    if (!result.lead) {
      res.status(404).json({ error: `No researcher found matching "${name}"`, alternatives: [] });
      return;
    }

    res.status(result.wasDuplicate ? 200 : 201).json(result);
  }),
);
