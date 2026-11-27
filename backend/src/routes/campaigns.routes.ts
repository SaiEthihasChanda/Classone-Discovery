/**
 * Campaigns — designed emails sent to filtered leads (services/campaigns/campaignService.ts).
 */
import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler } from '../middleware/errorHandler.js';
import { GeminiHttpError } from '../services/ai/geminiProvider.js';
import {
  audienceOptions,
  bytesOf,
  campaignRecipients,
  cancelCampaign,
  createCampaign,
  deleteCampaign,
  duplicateCampaign,
  getAsset,
  getCampaign,
  listCampaigns,
  pauseCampaign,
  previewAudience,
  previewCampaign,
  saveAsset,
  sendTest,
  sentToday,
  startCampaign,
  updateCampaign,
  writeCampaignText,
} from '../services/campaigns/campaignService.js';
import { env } from '../config/env.js';
import { getState } from '../models/systemState.model.js';
import { catalogWatchTick } from '../services/catalog/catalogWatcher.js';
import { getLaunchSettings, listLaunches, setLaunchSettings } from '../services/campaigns/productLaunch.js';

export const campaignsRouter = Router();

const str = (max: number) => z.string().max(max);
const blockSchema = z.discriminatedUnion('type', [
  z.object({ id: str(40), type: z.literal('heading'), text: str(300), size: z.enum(['lg', 'md']).optional(), align: z.enum(['left', 'center', 'right']).optional() }),
  z.object({ id: str(40), type: z.literal('text'), text: str(6000) }),
  z.object({
    id: str(40),
    type: z.literal('image'),
    assetId: str(40),
    alt: str(300).optional(),
    link: str(1000).optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    width: z.enum(['full', 'large', 'medium', 'small']).optional(),
  }),
  z.object({ id: str(40), type: z.literal('button'), label: str(80), url: str(1000), align: z.enum(['left', 'center', 'right', 'full']).optional(), style: z.enum(['solid', 'outline']).optional() }),
  z.object({ id: str(40), type: z.literal('product'), productId: str(120), blurb: str(1000).optional(), url: str(1000).optional() }),
  z.object({ id: str(40), type: z.literal('divider') }),
  z.object({ id: str(40), type: z.literal('spacer'), size: z.enum(['sm', 'md', 'lg']).optional() }),
]);
const audienceSchema = z.object({
  statuses: z.array(z.enum(['pending_review', 'approved', 'customer'])).optional(),
  institutes: z.array(z.string()).max(200).optional(),
  applicationAreas: z.array(z.string()).max(100).optional(),
  productIds: z.array(z.string()).max(100).optional(),
  brands: z.array(z.string()).max(50).optional(),
  tags: z.array(z.string()).max(100).optional(),
  minScore: z.number().min(0).max(100).optional(),
  search: z.string().max(200).optional(),
  leadIds: z.array(z.string()).max(5000).optional(),
});
const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    subject: str(300),
    preheader: str(300),
    blocks: z.array(blockSchema).max(60),
    audience: audienceSchema,
    paceSeconds: z.number().int().min(10).max(3600),
  })
  .partial();

const aiError = (error: unknown) => {
  const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  if (timedOut || (error instanceof GeminiHttpError && (error.status === 429 || error.status >= 500))) {
    return new ApiError(503, error instanceof GeminiHttpError && error.status === 429 ? "The AI's daily limit is used up — write this one by hand, or try later." : 'The AI is busy — try again in a minute.');
  }
  return error;
};

campaignsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ items: await listCampaigns(), sentToday: await sentToday(), dailyCap: env.CAMPAIGN_DAILY_CAP });
  }),
);

campaignsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(120) }).parse(req.body ?? {});
    res.status(201).json(await createCampaign({ name: body.name, createdBy: req.user?.email }));
  }),
);

// --- New products from the website ------------------------------------------------------------

campaignsRouter.get(
  '/launches',
  asyncHandler(async (_req, res) => {
    const [settings, items, lastSync] = await Promise.all([getLaunchSettings(), listLaunches(), getState('websiteCatalogLastSync')]);
    res.json({ settings, items, lastSync: lastSync ?? null });
  }),
);

campaignsRouter.put(
  '/launches/settings',
  asyncHandler(async (req, res) => {
    const body = z.object({ mode: z.enum(['auto', 'manual']), minRelevance: z.number().int().min(0).max(100), maxRecipients: z.number().int().min(1).max(2000) }).partial().parse(req.body ?? {});
    res.json(await setLaunchSettings(body));
  }),
);

/** "Check the website now": one watcher pass (sync the catalog, draft pending launches). */
campaignsRouter.post(
  '/launches/check',
  asyncHandler(async (_req, res) => {
    const r = await catalogWatchTick();
    res.json(r ? { seen: r.seen, added: r.added, updated: r.updated, removed: r.deactivated, failed: r.failed, firstRun: r.firstRun } : { busy: true });
  }),
);

campaignsRouter.get(
  '/audience/options',
  asyncHandler(async (_req, res) => {
    res.json(await audienceOptions());
  }),
);

campaignsRouter.post(
  '/audience/preview',
  asyncHandler(async (req, res) => {
    const body = z.object({ audience: audienceSchema, campaignId: z.string().optional() }).parse(req.body ?? {});
    res.json(await previewAudience(body.audience, body.campaignId));
  }),
);

campaignsRouter.post(
  '/preview',
  asyncHandler(async (req, res) => {
    const body = z.object({ subject: str(300).default(''), preheader: str(300).optional(), blocks: z.array(blockSchema).max(60), leadId: z.string().optional() }).parse(req.body ?? {});
    res.json(await previewCampaign(body, body.leadId));
  }),
);

campaignsRouter.post(
  '/ai-text',
  asyncHandler(async (req, res) => {
    const body = z.object({ brief: z.string().trim().min(3).max(2000), products: z.array(z.string()).max(10).optional() }).parse(req.body ?? {});
    try {
      res.json(await writeCampaignText(body.brief, body.products));
    } catch (error) {
      throw aiError(error);
    }
  }),
);

/** Image upload: base64 JSON (this route alone accepts bodies up to 3 MB — see app.ts). */
campaignsRouter.post(
  '/assets',
  asyncHandler(async (req, res) => {
    const body = z
      .object({ filename: z.string().min(1).max(200), contentType: z.string(), data: z.string().min(10), width: z.number().int().optional(), height: z.number().int().optional() })
      .parse(req.body ?? {});
    res.status(201).json(await saveAsset({ ...body, createdBy: req.user?.email }));
  }),
);

campaignsRouter.get(
  '/assets/:id',
  asyncHandler(async (req, res) => {
    const a = await getAsset(req.params.id!);
    res.setHeader('Content-Type', a.contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(bytesOf(a.data));
  }),
);

campaignsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await getCampaign(req.params.id!));
  }),
);

campaignsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await updateCampaign(req.params.id!, patchSchema.parse(req.body ?? {}) as never));
  }),
);

campaignsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await deleteCampaign(req.params.id!);
    res.json({ ok: true });
  }),
);

/** Person by person: opened, clicked which links, opened the booking page, booked, replied. */
campaignsRouter.get(
  '/:id/results',
  asyncHandler(async (req, res) => {
    const { campaignResults } = await import('../services/campaigns/campaignResults.js');
    res.json(await campaignResults(req.params.id!));
  }),
);

/** Drafts a follow-up (for approval) to everyone who opened the booking page but did not book. */
campaignsRouter.post(
  '/:id/nudge-non-bookers',
  asyncHandler(async (req, res) => {
    const { nudgeNonBookers } = await import('../services/campaigns/campaignResults.js');
    res.json({ drafted: await nudgeNonBookers(req.params.id!) });
  }),
);

campaignsRouter.get(
  '/:id/recipients',
  asyncHandler(async (req, res) => {
    res.json({ items: await campaignRecipients(req.params.id!) });
  }),
);

campaignsRouter.post(
  '/:id/duplicate',
  asyncHandler(async (req, res) => {
    res.status(201).json(await duplicateCampaign(req.params.id!, req.user?.email));
  }),
);

campaignsRouter.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const body = z.object({ to: z.string().email().optional() }).parse(req.body ?? {});
    // Default: the person testing — or the sales mailbox when signed in as a local dev/internal user.
    const me = req.user?.email && !req.user.email.endsWith('@localhost') ? req.user.email : env.EMAIL_FROM_ADDRESS;
    const to = body.to ?? me;
    await sendTest(req.params.id!, to);
    res.json({ ok: true, to });
  }),
);

campaignsRouter.post(
  '/:id/start',
  asyncHandler(async (req, res) => {
    const body = z.object({ sendAt: z.coerce.date().optional() }).parse(req.body ?? {});
    res.json(await startCampaign(req.params.id!, { sendAt: body.sendAt }));
  }),
);

campaignsRouter.post(
  '/:id/pause',
  asyncHandler(async (req, res) => {
    res.json(await pauseCampaign(req.params.id!));
  }),
);

campaignsRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    res.json(await cancelCampaign(req.params.id!));
  }),
);
