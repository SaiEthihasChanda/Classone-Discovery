/**
 * Dashboard endpoint — the four tiles and the activity feed from the proposal.
 *
 * Every number here is a single-collection count against data other modules
 * already write. No new write paths, no joins, no aggregation pipelines (which
 * is also what keeps this working unchanged after the Firestore migration).
 */
import { Router } from 'express';
import { repositories, where } from '../repositories/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const dashboardRouter = Router();

// GET /api/dashboard
dashboardRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const alertWindowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [activeCustomers, inProgressDiscoveries, openThreads, criticalAlerts, recentActivity] =
      await Promise.all([
        // "Active Customers" — approved leads plus converted customers.
        repositories.leads.count([where.in('status', ['approved', 'customer'])]),
        // "In-Progress Discoveries" — awaiting the human approve/reject gate.
        repositories.leads.count([where.eq('status', 'pending_review')]),
        repositories.threads.count([where.eq('status', 'open')]),
        repositories.activity.countCritical(alertWindowStart),
        repositories.activity.findRecent(15),
      ]);

    res.json({
      tiles: { activeCustomers, inProgressDiscoveries, openThreads, criticalAlerts },
      recentActivity,
      generatedAt: new Date().toISOString(),
    });
  }),
);
