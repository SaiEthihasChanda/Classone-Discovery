/**
 * The follow-up check job: finds open threads whose `nextCheckAt` has passed
 * and drafts the next message — it never sends. Every send, first touch or
 * follow-up, goes through `approveAndSendOutreach` after a human looks at it.
 *
 * Reply detection is a manual "Mark replied" action for now (see
 * `outreachService.markReplied`); the `lastAiThreadSummary`/`ai_summary`
 * fields on `ThreadFollowUp` are reserved for an automated version later.
 */
import { repositories } from '../../repositories/index.js';
import { logActivity } from '../activity/activityService.js';
import { draftOutreachForLead } from './outreachService.js';

let running = false;

export async function runFollowUpCheck(): Promise<{ drafted: number; closed: number; failed: number }> {
  if (running) {
    console.warn('[cron] follow-up check already running — skipping this tick');
    return { drafted: 0, closed: 0, failed: 0 };
  }
  running = true;

  let drafted = 0;
  let closed = 0;
  let failed = 0;

  try {
    const due = await repositories.threads.findDueForFollowUp();
    for (const thread of due) {
      try {
        if (thread.followUp.attemptsSent >= thread.followUp.maxAttempts) {
          await repositories.threads.updateById(thread.id, { status: 'closed', closedReason: 'max_attempts_reached' });
          await repositories.leads.updateById(thread.leadId, { followUpStatusSummary: 'closed' });
          closed += 1;
          continue;
        }
        await draftOutreachForLead(thread.leadId);
        drafted += 1;
      } catch (error) {
        failed += 1;
        console.error(`[cron] follow-up draft failed for thread ${thread.id}:`, error instanceof Error ? error.message : error);
      }
    }

    if (drafted > 0 || closed > 0 || failed > 0) {
      console.log(`[cron] follow-up check: ${drafted} drafted, ${closed} closed (max attempts), ${failed} failed`);
    }
  } finally {
    running = false;
  }

  if (failed > 0) {
    await logActivity({
      type: 'system_error',
      severity: 'warning',
      message: `Follow-up check: ${failed} thread(s) failed to draft`,
    });
  }

  return { drafted, closed, failed };
}
