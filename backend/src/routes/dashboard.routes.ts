/**
 * The analytics dashboard (Home) — services/dashboard/dashboardService.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { buildDashboard, type Range } from '../services/dashboard/dashboardService.js';

export const dashboardRouter = Router();

// GET /api/dashboard?range=7|30|90|all
dashboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const range = z.enum(['7', '30', '90', 'all']).catch('30').parse(req.query.range) as Range;
    res.json(await buildDashboard(range));
  }),
);

/** Email last week's summary to the team now (it also goes out by itself every Monday at 09:00 IST). */
dashboardRouter.post(
  '/weekly-summary',
  asyncHandler(async (_req, res) => {
    const { sendWeeklySummary } = await import('../services/reports/weeklySummary.js');
    await sendWeeklySummary();
    res.json({ sent: true });
  }),
);
