import cors from 'cors';
import express from 'express';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiRouter } from './routes/index.js';

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  if (!env.isProduction) {
    app.use((req, _res, next) => {
      console.log(`[api] ${req.method} ${req.path}`);
      next();
    });
  }

  app.use('/api', apiRouter);

  // Order matters: unmatched routes first, then the error handler last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
