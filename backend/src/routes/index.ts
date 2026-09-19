import { Router } from 'express';
import { env } from '../config/env.js';
import { databaseState } from '../db/connection.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { leadsRouter } from './leads.routes.js';
import { catalogRouter } from './catalog.routes.js';
import { dashboardRouter } from './dashboard.routes.js';
import { discoveryRouter } from './discovery.routes.js';
import { settingsRouter } from './settings.routes.js';
import { adminRouter } from './admin.routes.js';

export const apiRouter = Router();

/**
 * GET /api/health
 *
 * Reports this service plus its two dependencies. Returns 503 when the database
 * is down so the check is usable by a monitor, not just a human.
 */
apiRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const db = databaseState();

    // A slow or missing scraper-service must not make this endpoint hang.
    let scraper: 'ok' | 'unreachable' = 'unreachable';
    try {
      const response = await fetch(`${env.SCRAPER_SERVICE_URL}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) scraper = 'ok';
    } catch {
      scraper = 'unreachable';
    }

    res.status(db === 'connected' ? 200 : 503).json({
      status: db === 'connected' ? 'ok' : 'degraded',
      service: 'backend',
      dependencies: { database: db, dbProvider: env.DB_PROVIDER, scraperService: scraper },
      timestamp: new Date().toISOString(),
    });
  }),
);

apiRouter.use('/leads', leadsRouter);
apiRouter.use('/catalog', catalogRouter);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/discovery', discoveryRouter);
apiRouter.use('/settings', settingsRouter);
apiRouter.use('/admin', adminRouter);
