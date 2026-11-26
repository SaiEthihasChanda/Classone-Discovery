/**
 * Conversations — the sales mailbox organised by person (services/email/conversationService.ts).
 */
import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler } from '../middleware/errorHandler.js';
import { GeminiHttpError } from '../services/ai/geminiProvider.js';
import {
  aiDraftForThread,
  composeMessage,
  conversationSummary,
  listPeople,
  markHandled,
  needsYouQueue,
  markThreadRead,
  setAutoReply,
  personDetail,
  personToLead,
  replyOnThread,
  setDoNotContact,
  type PeopleFilter,
} from '../services/email/conversationService.js';
import { approveAndSendOutreach, rejectDraft } from '../services/email/outreachService.js';
import { getFollowUpMode, setFollowUpMode } from '../services/email/followUpScheduler.js';
import { ContactModel } from '../models/contact.model.js';

export const conversationsRouter = Router();

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const filterSchema = z.enum(['all', 'needs_reply', 'overdue', 'unread', 'drafts', 'leads', 'new']).catch('all');

conversationsRouter.get(
  '/people',
  asyncHandler(async (req, res) => {
    const filter = filterSchema.parse(req.query.filter) as PeopleFilter;
    res.json({ items: await listPeople(filter, typeof req.query.q === 'string' ? req.query.q : '') });
  }),
);

/** "Needs you": conversations waiting on the team, longest-waiting first, with their message and the AI draft. */
conversationsRouter.get(
  '/queue',
  asyncHandler(async (_req, res) => {
    res.json({ items: await needsYouQueue() });
  }),
);

/** The global follow-up switch: Auto sends due follow-ups by themselves (inside the send window). */
conversationsRouter.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    res.json({ followUpMode: await getFollowUpMode() });
  }),
);

conversationsRouter.put(
  '/settings',
  asyncHandler(async (req, res) => {
    const body = z.object({ followUpMode: z.enum(['auto', 'manual']) }).parse(req.body ?? {});
    await setFollowUpMode(body.followUpMode);
    res.json({ followUpMode: body.followUpMode });
  }),
);

/** One person's follow-up override: auto, manual, or null to follow the global switch. */
conversationsRouter.put(
  '/people/:email/follow-up-mode',
  asyncHandler(async (req, res) => {
    const body = z.object({ value: z.enum(['auto', 'manual']).nullable() }).parse(req.body ?? {});
    const key = req.params.email!.trim().toLowerCase();
    await ContactModel.updateOne({ email: key }, body.value ? { $set: { followUpMode: body.value }, $setOnInsert: { email: key } } : { $unset: { followUpMode: '' } }, { upsert: Boolean(body.value) });
    res.json({ ok: true });
  }),
);

conversationsRouter.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    res.json(await conversationSummary());
  }),
);

conversationsRouter.get(
  '/people/:email',
  asyncHandler(async (req, res) => {
    res.json(await personDetail(req.params.email!));
  }),
);

conversationsRouter.post(
  '/people/:email/to-lead',
  asyncHandler(async (req, res) => {
    const lead = await personToLead(req.params.email!);
    res.json({ leadId: lead.id });
  }),
);

conversationsRouter.put(
  '/people/:email/do-not-contact',
  asyncHandler(async (req, res) => {
    const body = z.object({ value: z.boolean() }).parse(req.body ?? {});
    await setDoNotContact(req.params.email!, body.value);
    res.json({ ok: true });
  }),
);

conversationsRouter.put(
  '/people/:email/auto-reply',
  asyncHandler(async (req, res) => {
    const body = z.object({ value: z.boolean() }).parse(req.body ?? {});
    await setAutoReply(req.params.email!, body.value);
    res.json({ ok: true });
  }),
);

const threadId = (raw: string | undefined) => {
  const id = objectId.safeParse(raw);
  if (!id.success) throw ApiError.badRequest('Invalid conversation id');
  return id.data;
};

conversationsRouter.post(
  '/threads/:id/read',
  asyncHandler(async (req, res) => {
    await markThreadRead(threadId(req.params.id));
    res.json({ ok: true });
  }),
);

/** "No reply needed" — stops it counting as waiting / overdue. */
conversationsRouter.post(
  '/threads/:id/handled',
  asyncHandler(async (req, res) => {
    await markHandled(threadId(req.params.id));
    res.json({ ok: true });
  }),
);

conversationsRouter.post(
  '/threads/:id/reply',
  asyncHandler(async (req, res) => {
    const body = z.object({ body: z.string().min(1).max(20_000) }).parse(req.body ?? {});
    res.json(await replyOnThread(threadId(req.params.id), body.body, req.user?.email));
  }),
);

/** An AI suggestion for the editor — not saved, not sent. */
conversationsRouter.post(
  '/threads/:id/ai-draft',
  asyncHandler(async (req, res) => {
    try {
      res.json(await aiDraftForThread(threadId(req.params.id)));
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      if (timedOut || (error instanceof GeminiHttpError && (error.status === 429 || error.status >= 500))) {
        throw new ApiError(503, error instanceof GeminiHttpError && error.status === 429 ? "The AI's daily limit is used up on every model — write this one by hand, or try again later." : 'The AI is busy right now — try again in a minute.');
      }
      throw error;
    }
  }),
);

/** A waiting AI draft, sent as it is (after the person read it). */
conversationsRouter.post(
  '/threads/:id/send-draft',
  asyncHandler(async (req, res) => {
    res.json(await approveAndSendOutreach(threadId(req.params.id), { sentBy: req.user?.email }));
  }),
);

conversationsRouter.post(
  '/threads/:id/discard-draft',
  asyncHandler(async (req, res) => {
    res.json(await rejectDraft(threadId(req.params.id)));
  }),
);

conversationsRouter.post(
  '/compose',
  asyncHandler(async (req, res) => {
    const body = z.object({ to: z.string().email(), subject: z.string().min(1).max(300), body: z.string().min(1).max(20_000) }).parse(req.body ?? {});
    res.status(201).json(await composeMessage({ ...body, sentBy: req.user?.email }));
  }),
);
