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
import { rosterRouter } from './roster.routes.js';
import { pipelineRouter } from './pipeline.routes.js';
import { conversationsRouter } from './conversations.routes.js';
import { campaignsRouter } from './campaigns.routes.js';
import { publicRouter } from './public.routes.js';
import { threadsRouter } from './threads.routes.js';
import { usersRouter } from './users.routes.js';
import { schedulesRouter } from './schedules.routes.js';
import { fundingRouter } from './funding.routes.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { auditTrail } from '../middleware/requestContext.js';

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

// Everything below /health needs a sign-in. /me answers even a "pending" user,
// so the UI can tell them they are waiting for access.
apiRouter.get('/me', authenticate, (req, res) => {
  res.json({ ...req.user, authEnabled: env.authEnabled });
});
// "Review & send" links from team emails: signed tokens, no sign-in (routes/public.routes.ts).
apiRouter.use('/public', publicRouter);
apiRouter.use(authenticate, authorize, auditTrail);

apiRouter.use('/users', usersRouter);
apiRouter.use('/leads', leadsRouter);
apiRouter.use('/catalog', catalogRouter);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/discovery', discoveryRouter);
apiRouter.use('/settings', settingsRouter);
apiRouter.use('/admin', adminRouter);
apiRouter.use('/roster', rosterRouter);
apiRouter.use('/pipeline', pipelineRouter);
apiRouter.use('/threads', threadsRouter);
apiRouter.use('/conversations', conversationsRouter);
apiRouter.use('/campaigns', campaignsRouter);
apiRouter.use('/schedules', schedulesRouter);
apiRouter.use('/funding', fundingRouter);
