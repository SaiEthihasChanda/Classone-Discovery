import { Router } from 'express';
import { z } from 'zod';
import { repositories, where, type Filter, type Query } from '../repositories/index.js';
import { ApiError, asyncHandler } from '../middleware/errorHandler.js';
import { bulkReviewLeads, createLead, reviewLead } from '../services/leads/leadService.js';
import { getSettings } from '../services/settings/settingsService.js';
import { leadsToCsv } from '../services/leads/leadCsv.js';
import { estimateScanCredits, scanLeadInstruments } from '../services/discovery/instrumentScan.js';
import { enrichLeadFromWeb, enrichLeadsFromWeb } from '../services/leads/webEnrichment.js';
import { verifyAffiliations, verifyLeadAffiliation } from '../services/leads/affiliationService.js';
import type { Lead } from '../types/domain.js';

export const leadsRouter = Router();

/** Comma-separated list in a query string -> string[]; absent/blank -> undefined. */
const csvList = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  );

const filterQuerySchema = z.object({
  status: z.enum(['pending_review', 'approved', 'rejected', 'customer']).optional(),
  source: z
    .enum([
      'openalex',
      'faculty_page',
      'university_news',
      'grant_portal',
      'manual',
      'manual_discovery_trigger',
    ])
    .optional(),
  search: z.string().trim().min(1).optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  /**
   * Instrument brand keys (see data/instrumentBrands.ts), comma-separated.
   * Matches leads seen using ANY of them — "show me every PalmSens or CorrTest
   * owner" is the question a salesperson actually asks.
   */
  brands: csvList,
  sortBy: z.enum(['createdAt', 'score', 'name']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

const listQuerySchema = filterQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

type FilterQuery = z.infer<typeof filterQuerySchema>;

/** One place turns the URL filters into a repository query, so list and export cannot drift. */
function buildLeadQuery(q: FilterQuery): Omit<Query, 'options'> {
  const filter: Filter = [];
  if (q.status) filter.push(where.eq('status', q.status));
  if (q.source) filter.push(where.eq('source.type', q.source));
  if (q.minScore !== undefined) {
    filter.push(where.gte('aiScoring.relevanceScore', q.minScore));
  }
  if (q.brands && q.brands.length > 0) {
    // Mongo matches a dotted path into an array of subdocuments against $in.
    // MIGRATION NOTE: Firestore cannot query into nested arrays; this needs a
    // denormalised `research.instrumentBrandKeys: string[]` with
    // array-contains-any at migration time.
    filter.push(where.in('research.instruments.brandKey', q.brands));
  }

  return {
    filter,
    search: q.search
      ? { term: q.search, fields: ['person.name', 'person.email', 'institution.name'] }
      : undefined,
  };
}

const bulkReviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reviewedBy: z.string().trim().optional(),
  rejectionReason: z.string().trim().optional(),
  /** Narrows which pending leads are affected; both optional. */
  minScore: z.number().min(0).max(100).optional(),
  brands: z.array(z.string()).optional(),
  /** Explicit ids win over the filter when supplied. */
  ids: z.array(z.string()).max(500).optional(),
});

const createLeadSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  email: z.string().email('Must be a valid email address').optional().or(z.literal('')),
  title: z.string().trim().optional(),
  orcid: z.string().trim().optional(),
  profileUrl: z.string().url().optional().or(z.literal('')),
  institutionName: z.string().trim().optional(),
  department: z.string().trim().optional(),
  country: z.string().trim().optional(),
  institutionWebsite: z.string().url().optional().or(z.literal('')),
  researchSummary: z.string().trim().optional(),
  topics: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});

const updateLeadSchema = createLeadSchema.partial().extend({
  status: z.enum(['pending_review', 'approved', 'rejected', 'customer']).optional(),
});

const reviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reviewedBy: z.string().trim().optional(),
  rejectionReason: z.string().trim().optional(),
});

/** Drops empty strings so an untouched optional form field does not overwrite stored data. */
function omitBlank<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '')) as T;
}

const SORT_FIELDS = {
  createdAt: 'createdAt',
  score: 'aiScoring.relevanceScore',
  name: 'person.name',
} as const;

// GET /api/leads — the list view: filter, search, sort, paginate.
leadsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);

    const result = await repositories.leads.findPaginated({
      ...buildLeadQuery(q),
      options: {
        limit: q.limit,
        skip: q.skip,
        sort: { [SORT_FIELDS[q.sortBy]]: q.sortDir === 'asc' ? 1 : -1 },
      },
    });

    res.json(result);
  }),
);

/**
 * GET /api/leads/export.csv — the same filters as the list, every matching
 * row, as a spreadsheet. Pages through the repository rather than loading one
 * unbounded array, and is capped so a mistaken "export everything" cannot
 * pin the server.
 */
const EXPORT_PAGE = 500;
const EXPORT_MAX_ROWS = 25_000;

leadsRouter.get(
  '/export.csv',
  asyncHandler(async (req, res) => {
    const q = filterQuerySchema.parse(req.query);
    const base = buildLeadQuery(q);
    const sort = { [SORT_FIELDS[q.sortBy]]: q.sortDir === 'asc' ? 1 : -1 } as Record<string, 1 | -1>;

    const rows: Lead[] = [];
    for (let skip = 0; skip < EXPORT_MAX_ROWS; skip += EXPORT_PAGE) {
      const page = await repositories.leads.findPaginated({
        ...base,
        options: { limit: EXPORT_PAGE, skip, sort },
      });
      rows.push(...page.items);
      if (page.items.length < EXPORT_PAGE || rows.length >= page.total) break;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="classone-leads-${stamp}.csv"`);
    // Says so plainly rather than silently handing over a truncated file.
    if (rows.length >= EXPORT_MAX_ROWS) {
      res.setHeader('X-Export-Truncated', String(EXPORT_MAX_ROWS));
    }
    // BOM so Excel opens UTF-8 names (diacritics) correctly.
    res.send('\uFEFF' + leadsToCsv(rows.slice(0, EXPORT_MAX_ROWS)));
  }),
);

/**
 * GET /api/leads/brand-options — the instrument brands a lead can be filtered
 * by, in display order (Class One's own first), for the CRM filter control.
 */
leadsRouter.get(
  '/brand-options',
  asyncHandler(async (_req, res) => {
    const settings = await getSettings();
    res.json({
      items: settings.discovery.instrumentBrands
        .filter((b) => b.enabled)
        .map((b) => ({ key: b.key, brand: b.brand, vendor: b.vendor })),
    });
  }),
);

/**
 * POST /api/leads/review-bulk — approve or reject many pending leads at once.
 * Only ever touches `pending_review` leads, whatever ids or filter is passed.
 */
leadsRouter.post(
  '/review-bulk',
  asyncHandler(async (req, res) => {
    const body = bulkReviewSchema.parse(req.body);
    const result = await bulkReviewLeads(body.decision, {
      ids: body.ids,
      minScore: body.minScore,
      brands: body.brands,
      reviewedBy: body.reviewedBy,
      rejectionReason: body.rejectionReason,
    });
    res.json(result);
  }),
);

// GET /api/leads/scan-instruments/estimate — credits a per-lead scan may cost.
leadsRouter.get(
  '/scan-instruments/estimate',
  asyncHandler(async (_req, res) => {
    res.json(await estimateScanCredits());
  }),
);

/**
 * POST /api/leads/:id/scan-instruments — every instrument this researcher
 * has written up, from their own papers rather than the run's sample of them.
 */
leadsRouter.post(
  '/:id/scan-instruments',
  asyncHandler(async (req, res) => {
    res.json(await scanLeadInstruments(req.params.id!));
  }),
);

/**
 * POST /api/leads/enrich-web-bulk — web enrichment for up to 25 leads in one
 * call, sequentially. Small on purpose: each lead is several politely-paced
 * page fetches, so 25 is already a few minutes.
 */
const bulkEnrichSchema = z.object({
  ids: z.array(z.string()).min(1).max(25),
});

leadsRouter.post(
  '/enrich-web-bulk',
  asyncHandler(async (req, res) => {
    const { ids } = bulkEnrichSchema.parse(req.body);
    const results = await enrichLeadsFromWeb(ids);
    res.json({
      results: results.map((r) => ({
        leadId: r.leadId,
        name: r.name,
        error: r.error,
        ...(r.result
          ? {
              filled: r.result.filled,
              instruments: [...new Set(r.result.instrumentsFound.map((i) => i.model ?? i.brand))],
              papersRead: r.result.papers.read,
              pagesVisited: r.result.pagesVisited,
              errors: r.result.errors.length,
            }
          : {}),
      })),
    });
  }),
);

/**
 * POST /api/leads/verify-affiliations — re-check "still at this institute?"
 * for many leads (oldest check first). Free at OpenAlex.
 */
const bulkVerifySchema = z.object({
  ids: z.array(z.string()).max(2000).optional(),
  status: z.enum(['pending_review', 'approved', 'rejected', 'customer']).optional(),
  brands: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
  /** Also consult the institute directory and registries via the scraper. */
  deep: z.boolean().optional(),
});

leadsRouter.post(
  '/verify-affiliations',
  asyncHandler(async (req, res) => {
    const body = bulkVerifySchema.parse(req.body ?? {});
    res.json(await verifyAffiliations(body));
  }),
);

// POST /api/leads/:id/verify-affiliation — one lead, now. `{ deep: true }`
// also asks the institute directory and the registries (needs the scraper).
leadsRouter.post(
  '/:id/verify-affiliation',
  asyncHandler(async (req, res) => {
    const deep = z.object({ deep: z.boolean().optional() }).parse(req.body ?? {}).deep ?? false;
    res.json(await verifyLeadAffiliation(req.params.id!, { deep }));
  }),
);

/**
 * POST /api/leads/:id/enrich-web — profile page, ORCID, lab website and
 * open-access papers for one lead. Fills only what is blank.
 */
leadsRouter.post(
  '/:id/enrich-web',
  asyncHandler(async (req, res) => {
    res.json(await enrichLeadFromWeb(req.params.id!));
  }),
);

// GET /api/leads/:id
leadsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const lead = await repositories.leads.findById(req.params.id!);
    if (!lead) throw ApiError.notFound('Lead');

    // Threads are fetched alongside so the detail view renders in one round trip.
    const threads = await repositories.threads.findAllForLead(lead.id);
    res.json({ ...lead, threads });
  }),
);

// POST /api/leads — manual entry.
leadsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = omitBlank(createLeadSchema.parse(req.body));
    const { lead, wasDuplicate } = await createLead(body, { logAs: 'manual' });

    // 200 rather than 201 on a duplicate: nothing was created, and the client
    // needs to tell the two cases apart to show the right message.
    res.status(wasDuplicate ? 200 : 201).json({ lead, wasDuplicate });
  }),
);

// PATCH /api/leads/:id
leadsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = omitBlank(updateLeadSchema.parse(req.body));
    const existing = await repositories.leads.findById(req.params.id!);
    if (!existing) throw ApiError.notFound('Lead');

    const updated = await repositories.leads.updateById(req.params.id!, {
      ...(body.status ? { status: body.status } : {}),
      person: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.email !== undefined ? { email: body.email?.toLowerCase() } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.orcid !== undefined ? { orcid: body.orcid } : {}),
        ...(body.profileUrl !== undefined ? { profileUrl: body.profileUrl } : {}),
      },
      institution: {
        ...(body.institutionName !== undefined ? { name: body.institutionName } : {}),
        ...(body.department !== undefined ? { department: body.department } : {}),
        ...(body.country !== undefined ? { country: body.country } : {}),
        ...(body.institutionWebsite !== undefined ? { websiteUrl: body.institutionWebsite } : {}),
      },
      ...(body.researchSummary !== undefined
        ? { research: { summary: body.researchSummary } }
        : {}),
      ...(body.tags ? { tags: body.tags } : {}),
    });

    res.json(updated);
  }),
);

// POST /api/leads/:id/review — the human approve/reject gate.
leadsRouter.post(
  '/:id/review',
  asyncHandler(async (req, res) => {
    const body = reviewSchema.parse(req.body);
    const lead = await reviewLead(req.params.id!, body.decision, {
      reviewedBy: body.reviewedBy,
      rejectionReason: body.rejectionReason,
    });
    res.json(lead);
  }),
);

// DELETE /api/leads/:id
leadsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const deleted = await repositories.leads.deleteById(req.params.id!);
    if (!deleted) throw ApiError.notFound('Lead');
    res.status(204).send();
  }),
);
