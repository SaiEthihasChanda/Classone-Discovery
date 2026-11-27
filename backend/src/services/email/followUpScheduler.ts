/**
 * The follow-up check (every FOLLOWUP_CHECK_MINUTES).
 *
 * 1. Conversations whose wait is over (status open, nextCheckAt passed) get the
 *    next follow-up drafted — or are closed once their follow-ups are used up.
 * 2. Follow-up drafts are sent automatically when the follow-up mode is Auto —
 *    the global switch, or that person's own override — but only inside the
 *    send window (Mon–Sat, 09:00–18:00 IST); outside it they wait for the next
 *    window. Each automatic send emails the team what went out. In Manual mode
 *    drafts wait in Conversations → Needs you for someone to send.
 *
 * Do-not-contact people are never followed up. Conversations with someone who
 * is not a CRM lead are left to the team.
 */
import { ContactModel } from '../../models/contact.model.js';
import { EmailThreadModel } from '../../models/emailThread.model.js';
import { getState, setState } from '../../models/systemState.model.js';
import { repositories } from '../../repositories/index.js';
import type { EmailThread } from '../../types/domain.js';
import { inSendWindow } from '../../utils/sendWindow.js';
import { logActivity } from '../activity/activityService.js';
import { approveAndSendOutreach, draftOutreachForLead, recipientOf } from './outreachService.js';
import { button, crmLink, esc, para, sendToTeam, shell } from './replyWatch.js';

export type FollowUpMode = 'auto' | 'manual';

export async function getFollowUpMode(): Promise<FollowUpMode> {
  return (await getState<FollowUpMode>('followUpMode')) === 'auto' ? 'auto' : 'manual';
}

export async function setFollowUpMode(mode: FollowUpMode): Promise<void> {
  await setState('followUpMode', mode);
}

/** The mode for one person: their override, else the global switch. */
export async function followUpModeFor(email: string | undefined, global?: FollowUpMode): Promise<FollowUpMode> {
  const c = email ? ((await ContactModel.findOne({ email: email.toLowerCase() }, { followUpMode: 1 }).lean()) as { followUpMode?: FollowUpMode } | null) : null;
  return c?.followUpMode ?? global ?? (await getFollowUpMode());
}

let running = false;

export async function runFollowUpCheck(now = new Date()): Promise<{ drafted: number; sent: number; closed: number; failed: number }> {
  const out = { drafted: 0, sent: 0, closed: 0, failed: 0 };
  if (running) {
    console.warn('[follow-ups] check already running — skipping this tick');
    return out;
  }
  running = true;

  try {
    // 1. Draft what is due.
    for (const thread of await repositories.threads.findDueForFollowUp(now)) {
      try {
        if (!thread.leadId) continue;
        if (thread.followUp.attemptsSent >= thread.followUp.maxAttempts) {
          await repositories.threads.updateById(thread.id, { status: 'closed', closedReason: 'max_attempts_reached' });
          await repositories.leads.updateById(thread.leadId, { followUpStatusSummary: 'closed' });
          out.closed += 1;
          continue;
        }
        const { contact } = await recipientOf(thread);
        if (contact.doNotContact) continue;
        // A draft already waiting: don't overwrite it on every tick.
        if (thread.draftBody) continue;
        await draftOutreachForLead(thread.leadId, { interactive: false, threadId: thread.id });
        out.drafted += 1;
      } catch (error) {
        out.failed += 1;
        console.error(`[follow-ups] draft failed for ${thread.id}:`, error instanceof Error ? error.message : error);
      }
    }

    // 2. Send follow-up drafts for people in Auto mode — inside the send window only.
    if (inSendWindow(now)) {
      const global = await getFollowUpMode();
      const drafts = await EmailThreadModel.find({ status: 'draft', draftType: { $in: ['follow_up_1', 'follow_up_2'] }, leadId: { $exists: true } }, { _id: 1 }).lean();
      for (const d of drafts) {
        const thread = await repositories.threads.findById(String(d._id));
        if (!thread?.draftBody) continue;
        try {
          const { email, contact } = await recipientOf(thread);
          if (!email || contact.doNotContact) continue;
          if ((await followUpModeFor(email, global)) !== 'auto') continue;
          const draft = { subject: thread.draftSubject ?? thread.subjectLine, body: thread.draftBody, number: thread.draftType === 'follow_up_2' ? 2 : 1 };
          const sent = await approveAndSendOutreach(thread.id, { sentBy: 'auto-followup' });
          out.sent += 1;
          await notifyAutoFollowUp(sent, contact.name, email, draft).catch((e) => console.error('[follow-ups] could not notify the team:', e instanceof Error ? e.message : e));
        } catch (error) {
          out.failed += 1;
          console.error(`[follow-ups] automatic send failed for ${thread.id}:`, error instanceof Error ? error.message : error);
        }
      }
    }

    if (out.drafted || out.sent || out.closed || out.failed) {
      console.log(`[follow-ups] ${out.drafted} drafted, ${out.sent} sent automatically, ${out.closed} closed (max attempts), ${out.failed} failed`);
    }
  } finally {
    running = false;
  }

  if (out.failed > 0) {
    await logActivity({ type: 'system_error', severity: 'warning', message: `Follow-up check: ${out.failed} follow-up(s) could not be drafted or sent` });
  }
  return out;
}

export async function notifyAutoFollowUp(thread: EmailThread, name: string, email: string, draft: { subject: string; body: string; number: number }): Promise<void> {
  const left = Math.max(0, thread.followUp.maxAttempts - thread.followUp.attemptsSent);
  const html = shell(
    `Follow-up ${draft.number} sent to ${name}`,
    `${esc(name)} (${esc(email)}) hadn't answered, and follow-ups are on Auto, so this went out. ${left ? `${left} more follow-up${left === 1 ? '' : 's'} will go out if they stay quiet.` : 'That was the last follow-up — the conversation closes if they stay quiet.'}`,
    `<p style="margin:0 0 4px;font-weight:600">${esc(draft.subject)}</p>
<div style="background:#f3f5f9;border-radius:8px;padding:10px 14px;margin:0 0 14px">${para(draft.body)}</div>
<p>${button(crmLink(email), 'Open in the CRM')}</p>`,
  );
  await sendToTeam(`Follow-up sent to ${name}`, html, `Follow-up ${draft.number} sent automatically to ${name} <${email}>:\n\n${draft.body}\n\nOpen in the CRM: ${crmLink(email)}`);
}
