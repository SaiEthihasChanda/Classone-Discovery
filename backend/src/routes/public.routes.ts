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

// --- Campaign tracking (services/campaigns/tracking.ts) ------------------------------------------------
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** An open: the 1×1 image in a campaign email. Always answers with the image. */
publicRouter.get(
  '/t/o/:token',
  asyncHandler(async (req, res) => {
    const { readOpenToken, recordOpen } = await import('../services/campaigns/tracking.js');
    const rid = readOpenToken(String(req.params.token));
    if (rid) await recordOpen(rid).catch(() => {});
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' }).send(PIXEL);
  }),
);

/** A click: recorded, then on to the link — only links that were signed into that email. */
publicRouter.get(
  '/t/c/:rid',
  asyncHandler(async (req, res) => {
    const { recordClick } = await import('../services/campaigns/tracking.js');
    const to = await recordClick(String(req.params.rid), String(req.query.u ?? ''), String(req.query.s ?? '')).catch(() => null);
    res.redirect(302, to ?? 'https://classonesystems.in');
  }),
);

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

// --- Demo booking (public page /book) ---------------------------------------------------------------
const bookings = new Map<string, number[]>();
/** At most 5 bookings per address per hour — enough for a person, not for a script. */
function allowBooking(ip: string): boolean {
  const now = Date.now();
  const recent = (bookings.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= 5) return false;
  bookings.set(ip, [...recent, now]);
  return true;
}

publicRouter.get(
  '/booking',
  asyncHandler(async (_req, res) => {
    const { getBookingSettings, freeSlots } = await import('../services/schedules/scheduleService.js');
    const s = await getBookingSettings();
    res.json({ open: s.enabled, title: s.title, intro: s.intro, durationMinutes: s.durationMinutes, mode: s.mode, slots: await freeSlots(new Date(), s) });
  }),
);

publicRouter.post(
  '/booking',
  asyncHandler(async (req, res) => {
    const { z } = await import('zod');
    const body = z
      .object({
        start: z.string().min(10).max(40),
        name: z.string().trim().min(2).max(120),
        email: z.string().trim().email().max(200),
        institution: z.string().trim().max(200).optional(),
        phone: z.string().trim().max(40).optional(),
        message: z.string().trim().max(2000).optional(),
        /** Honeypot: hidden on the page, so only bots fill it. */
        website: z.string().optional(),
      })
      .parse(req.body ?? {});
    if (body.website) return void res.status(201).json({ ok: true });
    if (!allowBooking(req.ip ?? 'unknown')) throw new ApiError(429, 'Too many bookings from here — please email us instead.');
    const { book } = await import('../services/schedules/scheduleService.js');
    const e = await book(body);
    res.status(201).json({ ok: true, start: e.start, end: e.end, mode: e.mode });
  }),
);
