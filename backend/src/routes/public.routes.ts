/**
 * The only routes that work without signing in: the "Review & send" links in
 * team emails (services/email/replyWatch.ts). A signed, expiring token names one
 * conversation and one draft; it can show that draft and send it to that one
 * person — nothing else. If the draft has changed or was sent since the email,
 * the link stops working.
 */
import { Router } from 'express';
import { ApiError, asyncHandler } from '../middleware/errorHandler.js';
import { repositories } from '../repositories/index.js';
import { approveAndSendOutreach, recipientOf } from '../services/email/outreachService.js';
import { readDraftToken } from '../services/email/replyWatch.js';

export const publicRouter = Router();

async function draftFor(token: string) {
  const t = readDraftToken(token);
  if ('error' in t) throw new ApiError(410, t.error);
  const thread = /^[a-f\d]{24}$/i.test(t.threadId) ? await repositories.threads.findById(t.threadId) : null;
  if (!thread) throw new ApiError(410, 'This conversation no longer exists.');
  if (!thread.draftBody || !thread.draftCreatedAt || new Date(thread.draftCreatedAt).getTime() !== t.draftAt) {
    throw new ApiError(410, 'This reply was already sent, discarded or rewritten — open the conversation in the CRM to see where it stands.');
  }
  return thread;
}

publicRouter.get(
  '/drafts/:token',
  asyncHandler(async (req, res) => {
    const thread = await draftFor(req.params.token!);
    const { email, contact } = await recipientOf(thread);
    const lastIn = [...thread.messages].reverse().find((m) => m.direction === 'inbound');
    res.json({
      to: { name: contact.name, email },
      subject: thread.draftSubject,
      body: thread.draftBody,
      theirMessage: lastIn ? { subject: lastIn.subject, body: lastIn.bodyText, at: lastIn.sentAt } : null,
      waitingSince: thread.awaitingReplySince,
    });
  }),
);

publicRouter.post(
  '/drafts/:token/send',
  asyncHandler(async (req, res) => {
    const thread = await draftFor(req.params.token!);
    await approveAndSendOutreach(thread.id, { sentBy: 'email-link' });
    const { email } = await recipientOf(thread);
    res.json({ ok: true, to: email });
  }),
);
