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
import { startFlowEngine, stopFlowEngine } from './services/pipeline/flowEngine.js';
import { startScheduleTicker, stopScheduleTicker } from './services/pipeline/pipelineRuns.js';
import { startRunNotifier, stopRunNotifier } from './services/pipeline/runNotifier.js';
import { startInboxPoller, stopInboxPoller } from './services/email/inboxPoller.js';
import { startCampaignSender, stopCampaignSender } from './services/campaigns/campaignService.js';
import { startReplyWatch, stopReplyWatch } from './services/email/replyWatch.js';
import { startCatalogWatcher, stopCatalogWatcher } from './services/catalog/catalogWatcher.js';
import { startEnquiryWatcher, stopEnquiryWatcher } from './services/enquiries/enquiryWatcher.js';
import { startWeeklySummary, stopWeeklySummary } from './services/reports/weeklySummary.js';
import { startReengage, stopReengage } from './services/email/reengage.js';
import { startScheduleJobs, stopScheduleJobs } from './services/schedules/scheduleService.js';
import { startFundingAlerts, stopFundingAlerts } from './services/funding/fundingAlerts.js';
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
  // Reads the sales inbox for replies and enquiries (Gmail only). Off with INBOX_POLL_SECONDS=0.
  startInboxPoller();
  // Sends running campaigns one email at a time, at their pace, within CAMPAIGN_DAILY_CAP.
  startCampaignSender();
  // Overdue-reply digest to the team, and holding replies for people set to auto-reply.
  startReplyWatch();
  // New products on classonesystems.in → CRM catalog, discovery keywords, launch campaigns.
  startCatalogWatcher();
  // Enquiry form submissions on classonesystems.in → Conversations (a reply drafted for approval).
  startEnquiryWatcher();
  // Monday 09:00 IST: last week's numbers emailed to the team.
  startWeeklySummary();
  // Daily from 10:00 IST: check-ins drafted (for approval) for people who went quiet.
  startReengage();
  // 07:30 IST: each sales executive gets the day's visits.
  startScheduleJobs();
  // Sundays: new grants spotted on leads' papers → congratulations notes drafted for approval.
  startFundingAlerts();
  // The Prospects conveyor and its scheduled runs. Off with FLOW_ENGINE=off (e.g. a second instance).
  if (process.env.FLOW_ENGINE !== 'off') {
    await startFlowEngine();
    startScheduleTicker();
    startRunNotifier();
  }

  const shutdown = async (signal: string) => {
    console.log(`\n[api] ${signal} received, shutting down`);
    stopScheduler();
    stopInboxPoller();
    stopCampaignSender();
    stopReplyWatch();
    stopCatalogWatcher();
    stopEnquiryWatcher();
    stopWeeklySummary();
    stopReengage();
    stopScheduleJobs();
    stopFundingAlerts();
    stopFlowEngine();
    stopScheduleTicker();
    stopRunNotifier();
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
