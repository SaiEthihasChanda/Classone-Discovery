/**
 * Schedules (services/schedules/scheduleService.ts): the team calendar, field visits with check-in,
 * the "who is where" board, and demo booking settings. The public booking page has its own routes
 * in public.routes.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler } from '../middleware/errorHandler.js';
import { EVENT_STATUSES, EVENT_TYPES } from '../models/scheduleEvent.model.js';
import {
  assignableUsers,
  createEvent,
  deleteEvent,
  fieldBoard,
  fieldStep,
  freeSlots,
  getBookingSettings,
  getEvent,
  listEvents,
  setBookingSettings,
  updateEvent,
} from '../services/schedules/scheduleService.js';

export const schedulesRouter = Router();

const eventBody = z.object({
  title: z.string().trim().min(1).max(200),
  type: z.enum(EVENT_TYPES),
  start: z.coerce.date(),
  end: z.coerce.date(),
  allDay: z.boolean().optional(),
  leadId: z.string().regex(/^[a-f\d]{24}$/i).optional().nullable(),
  contactEmail: z.string().email().optional().or(z.literal('')),
  contactName: z.string().max(200).optional(),
  institution: z.string().max(300).optional(),
  mode: z.enum(['in_person', 'online']).optional(),
  address: z.string().max(500).optional(),
  meetingLink: z.string().url().max(500).optional().or(z.literal('')),
  assignee: z.string().email().optional().nullable().or(z.literal('')),
  notes: z.string().max(4000).optional(),
  status: z.enum(EVENT_STATUSES).optional(),
});

const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === '' ? undefined : v])) as T;

schedulesRouter.get(
  '/events',
  asyncHandler(async (req, res) => {
    const q = z.object({ from: z.coerce.date(), to: z.coerce.date(), assignee: z.string().optional(), leadId: z.string().optional() }).parse(req.query);
    if (q.to.getTime() - q.from.getTime() > 120 * 86_400_000) throw new ApiError(400, 'Ask for at most four months at a time.');
    res.json({ events: await listEvents(q) });
  }),
);

schedulesRouter.get(
  '/events/:id',
  asyncHandler(async (req, res) => {
    res.json(await getEvent(String(req.params.id)));
  }),
);

schedulesRouter.post(
  '/events',
  asyncHandler(async (req, res) => {
    const body = clean(eventBody.parse(req.body ?? {}));
    res.status(201).json(await createEvent({ ...body, leadId: body.leadId ?? undefined }, req.user?.email));
  }),
);

schedulesRouter.put(
  '/events/:id',
  asyncHandler(async (req, res) => {
    const body = clean(eventBody.partial().parse(req.body ?? {}));
    res.json(await updateEvent(String(req.params.id), { ...body, leadId: body.leadId ?? undefined }));
  }),
);

/** Deleting is admin-only (every DELETE is); others cancel instead, which keeps the history. */
schedulesRouter.delete(
  '/events/:id',
  asyncHandler(async (req, res) => {
    await deleteEvent(String(req.params.id));
    res.status(204).end();
  }),
);

const point = z.object({ lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(), accuracy: z.number().min(0).optional(), note: z.string().max(4000).optional() });
for (const [path, step] of [
  ['on-the-way', 'on_the_way'],
  ['check-in', 'check_in'],
  ['check-out', 'check_out'],
] as const) {
  schedulesRouter.post(
    `/events/:id/${path}`,
    asyncHandler(async (req, res) => {
      const p = point.parse(req.body ?? {});
      res.json(await fieldStep(String(req.params.id), step, { email: req.user!.email, role: req.user!.role }, p));
    }),
  );
}

/** Who is where: each executive's visits for a day (default today) and their state now. */
schedulesRouter.get(
  '/board',
  asyncHandler(async (req, res) => {
    const day = req.query.date ? new Date(String(req.query.date)) : new Date();
    res.json({ people: await fieldBoard(day) });
  }),
);

/** The people a visit can be assigned to. */
schedulesRouter.get(
  '/people',
  asyncHandler(async (_req, res) => {
    res.json({ people: await assignableUsers() });
  }),
);

schedulesRouter.get(
  '/booking',
  asyncHandler(async (_req, res) => {
    const settings = await getBookingSettings();
    res.json({ settings, slots: (await freeSlots(new Date(), settings)).length });
  }),
);

schedulesRouter.put(
  '/booking',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        enabled: z.boolean().optional(),
        title: z.string().trim().min(1).max(200).optional(),
        days: z.array(z.number().int().min(0).max(6)).min(1).optional(),
        startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        durationMinutes: z.number().int().min(15).max(240).optional(),
        bufferMinutes: z.number().int().min(0).max(120).optional(),
        horizonDays: z.number().int().min(1).max(90).optional(),
        noticeHours: z.number().int().min(0).max(168).optional(),
        mode: z.enum(['online', 'in_person']).optional(),
        assignee: z.string().email().optional().or(z.literal('')),
        intro: z.string().max(1000).optional(),
      })
      .parse(req.body ?? {});
    res.json(await setBookingSettings({ ...body, assignee: body.assignee === '' ? undefined : body.assignee }));
  }),
);
