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
import type { EmailThread, Lead, MessageType } from '../../types/domain.js';
import { ContactModel, touchContact } from '../../models/contact.model.js';
import { logActivity } from '../activity/activityService.js';
import { draftOutreachEmail } from './outreachDraftService.js';
import { getEmailTransport, type EmailMessage } from './transports/index.js';

const DRAFT_FIELDS = ['draftType', 'draftSubject', 'draftBody', 'draftModel', 'draftCreatedAt', 'draftIntent'];

/** Which message this thread's next send would be, based on follow-ups sent so far. */
function nextDraftType(thread: EmailThread): MessageType {
  return thread.followUp.attemptsSent >= 1 ? 'follow_up_2' : 'follow_up_1';
}

/**
 * Creates (or refreshes) a pending draft for a lead's next outreach message —
 * a fresh first touch if there is no thread yet, otherwise the next follow-up
 * due on the existing one.
 */
export async function draftOutreachForLead(leadId: string, options: { interactive?: boolean; threadId?: string } = {}): Promise<EmailThread> {
  const lead = await repositories.leads.findById(leadId);
  if (!lead) throw ApiError.notFound('Lead');
  if (!lead.person.email) {
    throw new ApiError(400, 'This lead has no email address yet — fill that in before drafting outreach.');
  }
  if (lead.doNotContact) {
    throw new ApiError(400, `${lead.person.name} asked not to be emailed — no outreach is drafted for them.`);
  }

  // A given conversation (the follow-up check), else the lead's open one.
  const existing = options.threadId ? await repositories.threads.findById(options.threadId) : await repositories.threads.findOpenThreadForLead(leadId);
  if (existing && existing.followUp.attemptsSent >= existing.followUp.maxAttempts) {
    throw new ApiError(400, `This thread has already had its ${existing.followUp.maxAttempts} follow-up(s) — nothing left to draft.`);
  }

  const draftType: MessageType = existing ? nextDraftType(existing) : 'initial_outreach';
  const draft = await draftOutreachEmail(
    lead,
    existing ? { thread: existing, followUpNumber: existing.followUp.attemptsSent + 1, isLast: existing.followUp.attemptsSent + 1 >= existing.followUp.maxAttempts } : undefined,
    { interactive: options.interactive ?? true },
  );
  const now = new Date();

  if (existing) {
    const updated = await repositories.threads.updateById(existing.id, {
      // A pending draft is what puts a thread in Outreach → Drafts (and approve-send requires it).
      status: 'draft',
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
export async function approveAndSendOutreach(threadId: string, options: { sentBy?: string } = {}): Promise<EmailThread> {
  const thread = await repositories.threads.findById(threadId);
  if (!thread) throw ApiError.notFound('Thread');
  if (thread.status !== 'draft' || !thread.draftBody || !thread.draftSubject || !thread.draftType) {
    throw new ApiError(400, 'This thread has no pending draft to send.');
  }

  const { email, lead, contact } = await recipientOf(thread);
  if (!email) throw new ApiError(400, "This conversation has no email address — can't send.");
  if (contact.doNotContact && thread.draftType !== 'response') {
    throw new ApiError(400, `${contact.name} asked not to be emailed — this draft can't be sent.`);
  }

  const isResponse = thread.draftType === 'response';
  const isFollowUp = thread.draftType !== 'initial_outreach' && !isResponse;
  // Answering a "not interested" closes the conversation; any other answer re-opens it for a follow-up if they go quiet.
  const closes = isResponse && (thread.draftIntent === 'not_interested' || thread.draftIntent === 'unsubscribe');

  const updated = await sendOnThread(thread, {
    to: email,
    subject: thread.draftSubject,
    body: thread.draftBody,
    type: thread.draftType,
    draftedBy: 'ai',
    aiDraftModel: thread.draftModel,
    sentBy: options.sentBy,
    closes,
    countsAsFollowUp: isFollowUp,
  });

  await logActivity({
    type: isFollowUp ? 'follow_up_sent' : 'email_sent',
    message: `${isFollowUp ? 'Follow-up' : isResponse ? 'Reply' : 'Outreach'} sent to ${contact.name}`,
    relatedLeadId: lead?.id,
    relatedThreadId: thread.id,
    metadata: { provider: updated.provider },
  });
  return updated;
}

/** Who a conversation is with: the lead when there is one, else the contact on the thread. */
export async function recipientOf(thread: EmailThread): Promise<{ email?: string; lead: Lead | null; contact: { name: string; doNotContact: boolean } }> {
  const lead = thread.leadId ? await repositories.leads.findById(thread.leadId) : null;
  const email = lead?.person.email ?? thread.contactEmail ?? thread.leadEmailSnapshot;
  const contactDoc = email ? ((await ContactModel.findOne({ email: email.toLowerCase() }).lean()) as { name?: string; doNotContact?: boolean } | null) : null;
  return {
    email,
    lead,
    contact: {
      name: lead?.person.name ?? thread.contactName ?? contactDoc?.name ?? email ?? 'them',
      doNotContact: Boolean(lead?.doNotContact || contactDoc?.doNotContact),
    },
  };
}

export interface SendOnThreadInput {
  to: string;
  subject: string;
  body: string;
  html?: string;
  attachments?: EmailMessage['attachments'];
  listUnsubscribe?: string;
  type: MessageType;
  draftedBy: 'ai' | 'human';
  aiDraftModel?: string;
  sentBy?: string;
  /** Closes the conversation once sent (answering "not interested"). */
  closes?: boolean;
  /** A follow-up: counts against followUp.maxAttempts. Anything else starts a fresh round. */
  countsAsFollowUp?: boolean;
  /** No automatic follow-up after this one (campaign mails: a reply still lands in the conversation). */
  noFollowUp?: boolean;
  /**
   * An automatic holding reply (replyWatch.ts): they still wait for a real answer, so the waiting clock and
   * any AI draft of the real answer are kept; it only records that the holding reply went out.
   */
  holding?: boolean;
}

/**
 * Sends one message on a conversation — threaded under the last message, in the same Gmail
 * conversation — records it, and re-arms the follow-up timer. Every send goes through here:
 * approved drafts, replies typed in Conversations, campaign mails.
 */
export async function sendOnThread(thread: EmailThread, input: SendOnThreadInput): Promise<EmailThread> {
  const transport = getEmailTransport();
  const headerIds = thread.messages.map((m) => m.rfcMessageId).filter((id): id is string => Boolean(id));
  const sent = await transport.send({
    to: input.to,
    subject: input.subject,
    text: input.body,
    html: input.html,
    attachments: input.attachments,
    listUnsubscribe: input.listUnsubscribe,
    inReplyToMessageId: headerIds.at(-1),
    references: headerIds,
    threadId: transport.name === 'gmail' ? thread.providerThreadId : undefined,
  });

  const now = new Date();
  await repositories.threads.appendMessage(thread.id, {
    messageId: sent.providerMessageId,
    direction: 'outbound',
    type: input.type,
    subject: input.subject,
    bodyText: input.body,
    sentAt: now,
    draftedBy: input.draftedBy,
    approvedBy: 'human',
    sentBy: input.sentBy,
    aiDraftModel: input.aiDraftModel,
    rfcMessageId: sent.rfcMessageId,
  });

  if (input.holding) {
    const kept = await repositories.threads.updateById(
      thread.id,
      { provider: transport.name, providerThreadId: sent.threadId ?? thread.providerThreadId ?? sent.providerMessageId, autoReplySentAt: now },
      { unset: ['autoReplyDueAt'] },
    );
    await touchContact(input.to, { lastMessageAt: now });
    return kept ?? thread;
  }

  const updated = await repositories.threads.updateById(
    thread.id,
    {
      status: input.closes ? 'closed' : 'open',
      ...(input.closes ? { closedReason: 'replied' as const } : {}),
      provider: transport.name,
      // Gmail's conversation id — how the inbox poller recognises their reply as part of this thread.
      providerThreadId: sent.threadId ?? thread.providerThreadId ?? sent.providerMessageId,
      followUp: {
        attemptsSent: input.countsAsFollowUp ? thread.followUp.attemptsSent + 1 : input.type === 'initial_outreach' ? thread.followUp.attemptsSent : 0,
        lastOutboundAt: now,
        ...(input.noFollowUp ? {} : { nextCheckAt: new Date(now.getTime() + env.FOLLOWUP_WAIT_DAYS * 24 * 60 * 60 * 1000) }),
      },
    },
    // A real answer: no longer waiting for us.
    { unset: [...DRAFT_FIELDS, 'awaitingReplySince', 'autoReplyDueAt', 'autoReplySentAt', ...(input.noFollowUp ? ['followUp.nextCheckAt'] : [])] },
  );
  // The lead carries a denormalised rollup of its active thread, so list views need no join.
  if (thread.leadId) await repositories.leads.updateById(thread.leadId, { followUpStatusSummary: input.closes ? 'closed' : 'in_progress', activeThreadId: thread.id });
  await touchContact(input.to, { lastMessageAt: now });
  return updated ?? thread;
}

/** Discards a pending draft without sending it — the thread falls back to no draft (not deleted, so its history is kept). */
export async function rejectDraft(threadId: string): Promise<EmailThread> {
  const thread = await repositories.threads.findById(threadId);
  if (!thread) throw ApiError.notFound('Thread');
  if (thread.status !== 'draft') throw new ApiError(400, 'This thread has no pending draft.');

  // Not answering their mail: the conversation stays "they replied" (never chased by follow-ups),
  // or closes if they said they're not interested.
  if (thread.draftType === 'response') {
    const closes = thread.draftIntent === 'not_interested' || thread.draftIntent === 'unsubscribe';
    const updated = await repositories.threads.updateById(thread.id, closes ? { status: 'closed', closedReason: 'replied' } : { status: 'replied' }, { unset: DRAFT_FIELDS });
    return updated ?? thread;
  }

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
  if (thread.leadId) await repositories.leads.updateById(thread.leadId, { followUpStatusSummary: 'closed' });

  await logActivity({
    type: 'reply_detected',
    message: `Reply marked for thread ${thread.subjectLine}`,
    relatedLeadId: thread.leadId,
    relatedThreadId: thread.id,
  });

  return updated ?? thread;
}
