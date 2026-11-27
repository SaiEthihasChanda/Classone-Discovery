/** Funding alerts (services/funding/fundingAlerts.ts): new grants spotted on leads' papers. */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { dismissSignal, listSignals, runFundingCheck } from '../services/funding/fundingAlerts.js';

export const fundingRouter = Router();

fundingRouter.get(
  '/signals',
  asyncHandler(async (req, res) => {
    const q = z.object({ status: z.enum(['new', 'drafted', 'sent', 'skipped', 'dismissed']).optional(), days: z.coerce.number().int().min(1).max(365).optional() }).parse(req.query);
    res.json({ items: await listSignals(q) });
  }),
);

fundingRouter.post(
  '/signals/:id/dismiss',
  asyncHandler(async (req, res) => {
    await dismissSignal(String(req.params.id));
    res.json({ ok: true });
  }),
);

/** Runs the weekly check now, in the background (it reads every approved lead's recent papers). */
fundingRouter.post(
  '/check',
  asyncHandler(async (_req, res) => {
    void runFundingCheck()
      .then((r) => console.log(`[funding] manual check: ${r.checked} people, ${r.newSignals} new grant(s), ${r.drafted} drafted`))
      .catch((e) => console.error('[funding] manual check failed:', e instanceof Error ? e.message : e));
    res.status(202).json({ started: true });
  }),
);
