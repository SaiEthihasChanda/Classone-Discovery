/**
 * Scheduled jobs.
 *
 * Off by default (`CRON_ENABLED=false`) so a developer running the app does not
 * silently trigger live API calls and AI spend. Turn it on deliberately.
 */
import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../config/env.js';
import { logActivity } from '../services/activity/activityService.js';
import { runDiscovery } from '../services/discovery/discoveryOrchestrator.js';

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

export function startScheduler(): void {
  if (!env.CRON_ENABLED) {
    console.log('[cron] disabled (set CRON_ENABLED=true in .env to enable scheduled runs)');
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

  // The follow-up check job is registered here in Phase 3.
}

export function stopScheduler(): void {
  for (const task of tasks) task.stop();
  tasks.length = 0;
}
