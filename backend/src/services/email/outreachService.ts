/**
 * The draft -> human approval -> send lifecycle for outreach (first touch and
 * follow-ups alike). Nothing is ever sent without `approveAndSendOutreach` —
 * matches the review queue's "AI scores and enriches, but a person decides".
 *
 * A thread holds at most one pending draft at a time, as `draftSubject`/
 * `draftBody`/`draftType` on the thread document itself; approving it pushes
 * the real message into `messages[]` and clears those fields.
 */
import { env } from '../../config/env.js';
import { repositories } from '../../repositories/index.js';
import { ApiError } from '../../middleware/errorHandler.js';
import type { EmailThread, MessageType } from '../../types/domain.js';
import { logActivity } from '../activity/activityService.js';
import { draftOutreachEmail } from './outreachDraftService.js';
import { getEmailTransport } from './transports/index.js';

const DRAFT_FIELDS = ['draftType', 'draftSubject', 'draftBody', 'draftModel', 'draftCreatedAt'];

/** Which message this thread's next send would be, based on follow-ups sent so far. */
function nextDraftType(thread: EmailThread): MessageType {
  return thread.followUp.attemptsSent >= 1 ? 'follow_up_2' : 'follow_up_1';
}

/**
 * Creates (or refreshes) a pending draft for a lead's next outreach message —
 * a fresh first touch if there is no thread yet, otherwise the next follow-up
 * due on the existing one.
 */
export async function draftOutreachForLead(leadId: string): Promise<EmailThread> {
  const lead = await repositories.leads.findById(leadId);
  if (!lead) throw ApiError.notFound('Lead');
  if (!lead.person.email) {
    throw new ApiError(400, 'This lead has no email address yet — fill that in before drafting outreach.');
  }

  const existing = await repositories.threads.findOpenThreadForLead(leadId);
  if (existing && existing.followUp.attemptsSent >= existing.followUp.maxAttempts) {
    throw new ApiError(400, `This thread has already had its ${existing.followUp.maxAttempts} follow-up(s) — nothing left to draft.`);
  }

  const draftType: MessageType = existing ? nextDraftType(existing) : 'initial_outreach';
  const draft = await draftOutreachEmail(lead);
  const now = new Date();

  if (existing) {
    const updated = await repositories.threads.updateById(existing.id, {
      draftType,
      draftSubject: draft.subject,
      draftBody: draft.body,
      draftModel: draft.model,
      draftCreatedAt: now,
    });
    return updated ?? existing;
  }

  return repositories.threads.create({
    leadId,
    leadEmailSnapshot: lead.person.email,
    subjectLine: draft.subject,
    status: 'draft',
    provider: env.EMAIL_PROVIDER,
    messages: [],
    followUp: { attemptsSent: 0, maxAttempts: env.FOLLOWUP_MAX_ATTEMPTS, replyDetected: false },
    draftType,
    draftSubject: draft.subject,
    draftBody: draft.body,
    draftModel: draft.model,
    draftCreatedAt: now,
  });
}

/** Sends a thread's pending draft and records it as a real message. The only path that actually sends email. */
export async function approveAndSendOutreach(threadId: string): Promise<EmailThread> {
  const thread = await repositories.threads.findById(threadId);
  if (!thread) throw ApiError.notFound('Thread');
  if (thread.status !== 'draft' || !thread.draftBody || !thread.draftSubject || !thread.draftType) {
    throw new ApiError(400, 'This thread has no pending draft to send.');
  }

  const lead = await repositories.leads.findById(thread.leadId);
  if (!lead?.person.email) throw new ApiError(400, "This lead has no email address — can't send.");

  const transport = getEmailTransport();
  const priorOutboundIds = thread.messages.filter((m) => m.direction === 'outbound').map((m) => m.messageId);

  const sent = await transport.send({
    to: lead.person.email,
    subject: thread.draftSubject,
    text: thread.draftBody,
    inReplyToMessageId: priorOutboundIds.at(-1),
    references: priorOutboundIds,
  });

  const now = new Date();
  const nextCheckAt = new Date(now.getTime() + env.FOLLOWUP_WAIT_DAYS * 24 * 60 * 60 * 1000);
  const isFollowUp = thread.draftType !== 'initial_outreach';

  await repositories.threads.appendMessage(thread.id, {
    messageId: sent.providerMessageId,
    direction: 'outbound',
    type: thread.draftType,
    subject: thread.draftSubject,
    bodyText: thread.draftBody,
    sentAt: now,
    draftedBy: 'ai',
    approvedBy: 'human',
    aiDraftModel: thread.draftModel,
  });

  const updated = await repositories.threads.updateById(
    thread.id,
    {
      status: 'open',
      provider: transport.name,
      providerThreadId: sent.providerMessageId,
      followUp: {
        attemptsSent: isFollowUp ? thread.followUp.attemptsSent + 1 : thread.followUp.attemptsSent,
        lastOutboundAt: now,
        nextCheckAt,
      },
    },
    { unset: DRAFT_FIELDS },
  );
  // The lead carries a denormalised rollup of its active thread, so list views need no join.
  await repositories.leads.updateById(lead.id, { followUpStatusSummary: 'in_progress', activeThreadId: thread.id });

  await logActivity({
    type: isFollowUp ? 'follow_up_sent' : 'email_sent',
    message: `${isFollowUp ? 'Follow-up' : 'Outreach'} sent to ${lead.person.name}${sent.previewUrl ? ` — preview: ${sent.previewUrl}` : ''}`,
    relatedLeadId: lead.id,
    relatedThreadId: thread.id,
    metadata: { provider: transport.name, previewUrl: sent.previewUrl },
  });

  return updated ?? thread;
}

/** Discards a pending draft without sending it — the thread falls back to no draft (not deleted, so its history is kept). */
export async function rejectDraft(threadId: string): Promise<EmailThread> {
  const thread = await repositories.threads.findById(threadId);
  if (!thread) throw ApiError.notFound('Thread');
  if (thread.status !== 'draft') throw new ApiError(400, 'This thread has no pending draft.');

  // A thread with no messages yet exists only to hold the draft — nothing to fall back to, so it is removed outright.
  if (thread.messages.length === 0) {
    await repositories.threads.deleteById(thread.id);
    return thread;
  }

  const updated = await repositories.threads.updateById(thread.id, { status: 'open' }, { unset: DRAFT_FIELDS });
  return updated ?? thread;
}

/** The manual "mark replied" action — closes the thread so it drops off the follow-up schedule. */
export async function markReplied(threadId: string): Promise<EmailThread> {
  const thread = await repositories.threads.findById(threadId);
  if (!thread) throw ApiError.notFound('Thread');

  const updated = await repositories.threads.updateById(thread.id, {
    status: 'closed',
    closedReason: 'replied',
    followUp: { replyDetected: true, replyDetectedAt: new Date(), replyDetectionMethod: 'manual' },
  });
  await repositories.leads.updateById(thread.leadId, { followUpStatusSummary: 'closed' });

  await logActivity({
    type: 'reply_detected',
    message: `Reply marked for thread ${thread.subjectLine}`,
    relatedLeadId: thread.leadId,
    relatedThreadId: thread.id,
  });

  return updated ?? thread;
}
