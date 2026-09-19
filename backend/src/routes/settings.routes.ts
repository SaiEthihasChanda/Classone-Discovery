import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ApiError } from '../middleware/errorHandler.js';
import {
  getSettings,
  resetSettings,
  updateSettings,
  type ScrapeTargetConfig,
} from '../services/settings/settingsService.js';
import { INDIAN_INSTITUTIONS, institutionCounts } from '../data/indianInstitutions.js';

export const settingsRouter = Router();

const targetSchema = z.object({
  targetId: z.string().optional(),
  universityName: z.string().trim().min(1, 'Institution name is required'),
  department: z.string().trim().optional(),
  url: z.string().trim().url('Must be a valid URL'),
  enabled: z.boolean().default(true),
  note: z.string().trim().optional(),
});

const instrumentBrandSchema = z.object({
  key: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'Key must be lowercase letters, digits and dashes'),
  brand: z.string().trim().min(2, 'Brand name is required').max(80),
  vendor: z.enum(['classone', 'competitor']),
  // Model names are derived from the catalog, never posted by the client.
  searchAliases: z.array(z.string().trim().min(2).max(60)).max(25).optional(),
  enabled: z.boolean().default(true),
  searchEnabled: z.boolean().default(false),
});

const settingsPatchSchema = z.object({
  discovery: z
    .object({
      queries: z.array(z.string().trim().min(2)).max(60).optional(),
      disabledKeywordGroups: z.array(z.string()).optional(),
      instrumentSearchEnabled: z.boolean().optional(),
      identifyModels: z.boolean().optional(),
      instrumentLookbackYears: z.number().int().min(1).max(30).optional(),
      instrumentBrands: z.array(instrumentBrandSchema).max(40).optional(),
      region: z.enum(['indian_institutes', 'india', 'global']).optional(),
      institutionKinds: z.array(z.enum(['IIT', 'NIT', 'IIIT'])).optional(),
      disabledInstitutionIds: z.array(z.string()).optional(),
      sinceYear: z.number().int().min(1990).max(2100).optional(),
      enrichFacultyFromOpenAlex: z.boolean().optional(),
    })
    .optional(),
  scraping: z
    .object({
      allowBrowser: z.boolean().optional(),
      allowProxy: z.boolean().optional(),
      followProfiles: z.boolean().optional(),
      maxProfileFetches: z.number().int().min(0).max(100).optional(),
      enrichFromLabSites: z.boolean().optional(),
      maxEnrichmentPagesPerLead: z.number().int().min(1).max(30).optional(),
      readOpenAccessPapers: z.boolean().optional(),
      maxPapersPerLead: z.number().int().min(0).max(10).optional(),
    })
    .optional(),
  facultyTargets: z.array(targetSchema).optional(),
  newsTargets: z.array(targetSchema).optional(),
});

/** Ensures every target has a stable id, so the UI can key and edit rows. */
function withIds(targets: z.infer<typeof targetSchema>[]): ScrapeTargetConfig[] {
  return targets.map((t) => ({
    targetId: t.targetId ?? randomUUID(),
    universityName: t.universityName,
    department: t.department,
    url: t.url,
    enabled: t.enabled,
    note: t.note,
  }));
}

// GET /api/settings — everything the Settings page renders.
settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const settings = await getSettings();
    res.json({
      ...settings,
      // Sent alongside so the institution picker can render without a second call.
      institutions: {
        items: [...INDIAN_INSTITUTIONS].sort((a, b) => b.worksCount - a.worksCount),
        counts: institutionCounts(),
        total: INDIAN_INSTITUTIONS.length,
      },
    });
  }),
);

// PATCH /api/settings — partial update.
settingsRouter.patch(
  '/',
  asyncHandler(async (req, res) => {
    const body = settingsPatchSchema.parse(req.body);

    const updated = await updateSettings({
      ...(body.discovery ? { discovery: body.discovery as never } : {}),
      ...(body.scraping ? { scraping: body.scraping as never } : {}),
      ...(body.facultyTargets ? { facultyTargets: withIds(body.facultyTargets) } : {}),
      ...(body.newsTargets ? { newsTargets: withIds(body.newsTargets) } : {}),
    });

    res.json(updated);
  }),
);

// POST /api/settings/targets — add one scrape target.
settingsRouter.post(
  '/targets',
  asyncHandler(async (req, res) => {
    const schema = targetSchema.extend({ kind: z.enum(['faculty', 'news']) });
    const body = schema.parse(req.body);
    const settings = await getSettings();

    const list = body.kind === 'faculty' ? settings.facultyTargets : settings.newsTargets;
    if (list.some((t) => t.url === body.url)) {
      throw ApiError.badRequest('That URL is already in the list');
    }

    const target: ScrapeTargetConfig = {
      targetId: randomUUID(),
      universityName: body.universityName,
      department: body.department,
      url: body.url,
      enabled: body.enabled,
      note: body.note,
    };

    const updated = await updateSettings(
      body.kind === 'faculty'
        ? { facultyTargets: [...settings.facultyTargets, target] }
        : { newsTargets: [...settings.newsTargets, target] },
    );

    res.status(201).json(updated);
  }),
);

// DELETE /api/settings/targets/:id
settingsRouter.delete(
  '/targets/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const settings = await getSettings();

    const faculty = settings.facultyTargets.filter((t) => t.targetId !== id);
    const news = settings.newsTargets.filter((t) => t.targetId !== id);

    if (
      faculty.length === settings.facultyTargets.length &&
      news.length === settings.newsTargets.length
    ) {
      throw ApiError.notFound('Target');
    }

    res.json(await updateSettings({ facultyTargets: faculty, newsTargets: news }));
  }),
);

// POST /api/settings/reset — back to the seed-file values.
settingsRouter.post(
  '/reset',
  asyncHandler(async (_req, res) => {
    res.json(await resetSettings());
  }),
);
