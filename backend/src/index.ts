/**
 * Backend entry point.
 *
 * Order is deliberate: validate config (already done on import of `env`),
 * connect the database, and only then bind the HTTP port — so the API never
 * accepts a request it cannot serve.
 */
import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './db/connection.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { getAiProvider } from './services/ai/enrichmentService.js';

async function main(): Promise<void> {
  await connectDatabase();

  // Logs which provider is active, so it is obvious at boot whether runs will
  // cost money or use the free heuristic.
  getAiProvider();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`[api] listening on http://localhost:${env.PORT}`);
    console.log(`[api] health check: http://localhost:${env.PORT}/api/health`);
  });

  startScheduler();

  const shutdown = async (signal: string) => {
    console.log(`\n[api] ${signal} received, shutting down`);
    stopScheduler();
    server.close();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[api] failed to start:', error);
  process.exit(1);
});
