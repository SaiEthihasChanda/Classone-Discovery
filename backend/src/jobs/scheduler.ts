/**
 * Scheduled jobs.
 *
 * Discovery is off by default (`CRON_ENABLED=false`) so a developer running the
 * app does not silently trigger live API calls and AI spend. The follow-up check
 * always runs (every FOLLOWUP_CHECK_MINUTES): it only drafts, never sends.
 */
import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../config/env.js';
import { logActivity } from '../services/activity/activityService.js';
import { runDiscovery } from '../services/discovery/discoveryOrchestrator.js';
import { runFollowUpCheck } from '../services/email/followUpScheduler.js';

const tasks: ScheduledTask[] = [];

/** Guard against overlap: a slow run must not have a second run start on top of it. */
let discoveryRunning = false;

async function weeklyDiscoveryJob(): Promise<void> {
  if (discoveryRunning) {
    console.warn('[cron] discovery already running — skipping this tick');
    return;
  }

  discoveryRunning = true;
  console.log('[cron] starting scheduled discovery run');

  try {
    const summary = await runDiscovery();
    console.log(
      `[cron] discovery finished: ${summary.leadsCreated} new leads, ` +
        `${summary.duplicatesSkipped} duplicates skipped, $${summary.estimatedCostUsd.toFixed(4)} spent`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[cron] discovery run failed:', message);
    await logActivity({
      type: 'system_error',
      severity: 'critical',
      message: `Scheduled discovery run failed: ${message}`,
    });
  } finally {
    discoveryRunning = false;
  }
}

let followUpTimer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  // Follow-ups: drafting only (never sending), so it runs whenever the app is up — CRON_ENABLED gates discovery alone.
  const followUpTick = () => void runFollowUpCheck().catch((e) => console.error('[follow-ups] check failed:', e instanceof Error ? e.message : e));
  followUpTimer = setInterval(followUpTick, env.FOLLOWUP_CHECK_MINUTES * 60_000);
  console.log(`[follow-ups] checking every ${env.FOLLOWUP_CHECK_MINUTES} min (drafts after ${env.FOLLOWUP_WAIT_DAYS} day(s) of silence)`);

  if (!env.CRON_ENABLED) {
    console.log('[cron] discovery disabled (set CRON_ENABLED=true in .env to enable scheduled discovery)');
    return;
  }

  if (!cron.validate(env.CRON_DISCOVERY_SCHEDULE)) {
    console.error(
      `[cron] invalid CRON_DISCOVERY_SCHEDULE "${env.CRON_DISCOVERY_SCHEDULE}" — scheduler not started`,
    );
    return;
  }

  tasks.push(cron.schedule(env.CRON_DISCOVERY_SCHEDULE, () => void weeklyDiscoveryJob()));
  console.log(`[cron] discovery scheduled: ${env.CRON_DISCOVERY_SCHEDULE}`);
}

export function stopScheduler(): void {
  for (const task of tasks) task.stop();
  tasks.length = 0;
  if (followUpTimer) clearInterval(followUpTimer);
  followUpTimer = null;
}
