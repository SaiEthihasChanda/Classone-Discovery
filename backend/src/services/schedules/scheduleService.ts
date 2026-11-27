/**
 * Schedules: the team calendar, field visits and demo booking.
 *
 * - Events are created in the app (or by a customer on the public booking page) and can be assigned
 *   to a sales executive, who is emailed the details with a calendar file (.ics) and a map link.
 * - On the day, the executive taps On my way → Check in → Check out on their phone; each step records
 *   the time and one GPS reading (nothing is tracked in between). The office "Field" board shows who
 *   is where from those steps; a visit whose time has passed without a check-in shows as missed.
 * - Each morning (07:30 IST) every executive with visits that day gets the list.
 * - Booking: customers pick a free slot (from the booking settings, minus anything already on the
 *   assignee's calendar); the booking becomes a demo event linked to their lead, a confirmation goes
 *   out from the sales mailbox (it shows in Conversations), and the assignee is told.
 */
import { env } from '../../config/env.js';
import { ApiError } from '../../middleware/errorHandler.js';
import { AppUserModel } from '../../models/appUser.model.js';
import { touchContact } from '../../models/contact.model.js';
import { LeadModel } from '../../models/lead.model.js';
import { ScheduleEventModel, type EventStatus, type EventType } from '../../models/scheduleEvent.model.js';
import { getState, setState } from '../../models/systemState.model.js';
import { repositories } from '../../repositories/index.js';
import { escapeRegex } from '../../utils/regex.js';
import { logActivity } from '../activity/activityService.js';
import { sendOnNewThread } from '../email/outreachService.js';
import { button, esc, shell } from '../email/replyWatch.js';
import { getEmailTransport } from '../email/transports/index.js';

const MIN = 60_000;
const DAY = 86_400_000;
const IST = 330 * MIN;

export interface EventInput {
  title: string;
  type: EventType;
  start: Date;
  end: Date;
  allDay?: boolean;
  leadId?: string;
  contactEmail?: string;
  contactName?: string;
  institution?: string;
  mode?: 'in_person' | 'online';
  address?: string;
  meetingLink?: string;
  assignee?: string | null;
  notes?: string;
  status?: EventStatus;
}

export type EventDoc = Record<string, any> & { id: string };
const toDoc = (d: Record<string, any>): EventDoc => {
  const { _id, ...rest } = d;
  return { id: String(_id), ...rest };
};

// --- Who can be assigned ----------------------------------------------------------------------------

/** Sales executives (and admins) — the people a visit can be assigned to. */
export async function assignableUsers(): Promise<Array<{ email: string; name: string; role: string }>> {
  const users = (await AppUserModel.find({ role: { $in: ['sales', 'admin'] } }, { email: 1, name: 1, role: 1 }).sort({ name: 1 }).lean()) as Array<{ email: string; name?: string; role: string }>;
  return users.filter((u) => u.email && !u.email.endsWith('@localhost')).map((u) => ({ email: u.email.toLowerCase(), name: u.name ?? u.email, role: u.role }));
}

async function nameOf(email?: string | null): Promise<string | undefined> {
  if (!email) return undefined;
  const u = (await AppUserModel.findOne({ email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' } }, { name: 1 }).lean()) as { name?: string } | null;
  return u?.name ?? email;
}

// --- Events ---------------------------------------------------------------------------------------

/** A visit whose time has passed with no check-in is shown as missed (not stored, so it can still be checked in late). */
export function displayStatus(e: { status: EventStatus; end: Date; type: EventType }, now = new Date()): EventStatus | 'missed' {
  if ((e.type === 'visit' || e.type === 'demo') && (e.status === 'scheduled' || e.status === 'on_the_way') && new Date(e.end).getTime() < now.getTime() - 30 * MIN) return 'missed';
  return e.status;
}

export async function listEvents(q: { from: Date; to: Date; assignee?: string; leadId?: string }): Promise<EventDoc[]> {
  const filter: Record<string, unknown> = { start: { $lt: q.to }, end: { $gt: q.from } };
  if (q.assignee) filter.assignee = q.assignee.toLowerCase();
  if (q.leadId) filter.leadId = q.leadId;
  const docs = (await ScheduleEventModel.find(filter).sort({ start: 1 }).limit(2000).lean()).map(toDoc);
  const now = new Date();
  return docs.map((d) => ({ ...d, displayStatus: displayStatus(d as never, now) }));
}

export async function getEvent(id: string): Promise<EventDoc> {
  if (!/^[a-f\d]{24}$/i.test(id)) throw ApiError.notFound('Event');
  const d = await ScheduleEventModel.findById(id).lean();
  if (!d) throw ApiError.notFound('Event');
  return { ...toDoc(d), displayStatus: displayStatus(d as never) };
}

async function withLeadDetails(input: Partial<EventInput>): Promise<Partial<EventInput>> {
  if (!input.leadId) return input;
  const l = (await LeadModel.findById(input.leadId, { person: 1, institution: 1 }).lean()) as { person?: { name?: string; email?: string }; institution?: { name?: string } } | null;
  if (!l) throw new ApiError(400, 'That lead no longer exists.');
  return { ...input, contactName: input.contactName ?? l.person?.name, contactEmail: input.contactEmail ?? l.person?.email, institution: input.institution ?? l.institution?.name };
}

function checkTimes(start: Date, end: Date) {
  if (!(start instanceof Date) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new ApiError(400, 'A start and end time are needed.');
  if (end <= start) throw new ApiError(400, 'The end must be after the start.');
  if (end.getTime() - start.getTime() > 14 * DAY) throw new ApiError(400, 'An event can last at most two weeks.');
}

export async function createEvent(input: EventInput, createdBy?: string): Promise<EventDoc> {
  checkTimes(input.start, input.end);
  const data = await withLeadDetails(input);
  const assignee = data.assignee?.toLowerCase() || undefined;
  const doc = await ScheduleEventModel.create({ ...data, assignee, assigneeName: await nameOf(assignee), createdBy, source: 'app' });
  const e = toDoc(doc.toObject());
  await logActivity({
    type: assignee ? 'visit_assigned' : 'visit_updated',
    message: `${assignee ? `${e.assigneeName} assigned: ` : 'Added to the calendar: '}${e.title}${e.contactName ? ` — ${e.contactName}` : ''} on ${fmtWhen(e.start)}`,
    relatedLeadId: e.leadId,
  });
  if (assignee) await notifyAssignee(e).catch((err) => console.error('[schedules] could not email the assignee:', err instanceof Error ? err.message : err));
  return { ...e, displayStatus: displayStatus(e as never) };
}

export async function updateEvent(id: string, patch: Partial<EventInput>): Promise<EventDoc> {
  const before = await getEvent(id);
  const start = patch.start ?? before.start;
  const end = patch.end ?? before.end;
  checkTimes(new Date(start), new Date(end));
  const data = await withLeadDetails(patch);
  const assignee = patch.assignee === undefined ? before.assignee : patch.assignee?.toLowerCase() || null;
  const set: Record<string, unknown> = { ...data, assignee: assignee ?? undefined, assigneeName: assignee ? await nameOf(assignee) : undefined };
  const unset: Record<string, ''> = {};
  for (const [k, v] of Object.entries(set)) if (v === undefined || v === null) (unset[k] = ''), delete set[k];
  await ScheduleEventModel.updateOne({ _id: id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  const after = await getEvent(id);
  // The executive hears again when the visit becomes theirs, or when its time or place changes.
  const moved = String(before.start) !== String(after.start) || before.address !== after.address || before.meetingLink !== after.meetingLink;
  if (after.assignee && after.status !== 'cancelled' && (after.assignee !== before.assignee || moved)) {
    await notifyAssignee(after, after.assignee === before.assignee ? 'changed' : 'new').catch((err) => console.error('[schedules] could not email the assignee:', err instanceof Error ? err.message : err));
  }
  if (patch.status === 'cancelled' && before.status !== 'cancelled' && after.assignee) {
    await notifyAssignee(after, 'cancelled').catch(() => {});
  }
  if (after.assignee !== before.assignee && after.assignee) {
    await logActivity({ type: 'visit_assigned', message: `${after.assigneeName} assigned: ${after.title}${after.contactName ? ` — ${after.contactName}` : ''} on ${fmtWhen(after.start)}`, relatedLeadId: after.leadId });
  }
  return after;
}

export async function deleteEvent(id: string): Promise<void> {
  const e = await getEvent(id);
  await ScheduleEventModel.deleteOne({ _id: id });
  if (e.assignee && e.status !== 'cancelled' && new Date(e.end) > new Date()) await notifyAssignee(e, 'cancelled').catch(() => {});
}

// --- Field steps -----------------------------------------------------------------------------------

export type FieldStep = 'on_the_way' | 'check_in' | 'check_out';
const STEP_FIELD = { on_the_way: 'onTheWay', check_in: 'checkIn', check_out: 'checkOut' } as const;
const STEP_STATUS: Record<FieldStep, EventStatus> = { on_the_way: 'on_the_way', check_in: 'checked_in', check_out: 'done' };

/** One step of a visit, by its assignee (or an admin): the time and one GPS reading. */
export async function fieldStep(id: string, step: FieldStep, by: { email: string; role: string }, point: { lat?: number; lng?: number; accuracy?: number; note?: string }): Promise<EventDoc> {
  const e = await getEvent(id);
  if (e.status === 'cancelled') throw new ApiError(400, 'This visit was cancelled.');
  if (e.assignee && e.assignee !== by.email.toLowerCase() && by.role !== 'admin') throw new ApiError(403, `This visit is assigned to ${e.assigneeName ?? e.assignee}.`);
  const at = new Date();
  const set: Record<string, unknown> = { status: STEP_STATUS[step], [STEP_FIELD[step]]: { at, lat: point.lat, lng: point.lng, accuracy: point.accuracy, note: point.note } };
  if (step === 'check_out' && point.note?.trim()) set.outcome = point.note.trim();
  if (!e.assignee) Object.assign(set, { assignee: by.email.toLowerCase(), assigneeName: await nameOf(by.email) });
  await ScheduleEventModel.updateOne({ _id: id }, { $set: set });
  const after = await getEvent(id);
  const where = point.lat != null && point.lng != null ? ` (${mapLink(point.lat, point.lng)})` : '';
  const what = step === 'on_the_way' ? 'is on the way to' : step === 'check_in' ? 'checked in at' : 'finished';
  await logActivity({
    type: step === 'check_out' ? 'visit_checked_out' : 'visit_checked_in',
    message: `${after.assigneeName ?? by.email} ${what} ${after.title}${after.contactName ? ` — ${after.contactName}` : ''}${step === 'check_in' ? where : ''}${step === 'check_out' && after.outcome ? `: ${after.outcome}` : ''}`,
    relatedLeadId: after.leadId,
    metadata: { eventId: id, lat: point.lat, lng: point.lng },
  });
  return after;
}

/** Who is where today: each executive's visits for the day, and where they are now from their last step. */
export async function fieldBoard(day: Date, now = new Date()) {
  const start = istDayStart(day);
  const end = new Date(start.getTime() + DAY);
  const events = await listEvents({ from: start, to: end });
  const users = await assignableUsers();
  const emails = new Set([...users.map((u) => u.email), ...events.map((e) => e.assignee).filter(Boolean)]);
  return [...emails].map((email) => {
    const mine = events.filter((e) => e.assignee === email && e.status !== 'cancelled' && e.type !== 'blocked');
    const at = mine.find((e) => e.status === 'checked_in');
    const going = mine.find((e) => e.status === 'on_the_way');
    const next = mine.find((e) => (e.status === 'scheduled' || e.status === 'on_the_way') && new Date(e.end) > now);
    const steps = mine.flatMap((e) => (['checkOut', 'checkIn', 'onTheWay'] as const).filter((k) => e[k]?.at).map((k) => ({ ...e[k], eventTitle: e.title, kind: k })));
    const last = steps.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())[0];
    const user = users.find((u) => u.email === email);
    return {
      email,
      name: user?.name ?? mine[0]?.assigneeName ?? email,
      state: at ? 'at_visit' : going ? 'on_the_way' : next ? 'scheduled' : mine.length ? 'done_for_day' : 'free',
      current: at ?? going ?? null,
      next: next && next !== going ? next : null,
      lastLocation: last && last.lat != null ? { lat: last.lat, lng: last.lng, at: last.at, eventTitle: last.eventTitle, kind: last.kind } : null,
      visits: mine,
    };
  });
}

// --- Emails ------------------------------------------------------------------------------------------

const fmtWhen = (d: Date | string) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const fmtTime = (d: Date | string) => new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
export const mapLink = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;
const mapSearch = (address: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsTime = (d: Date | string) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** A calendar file for one event, so it can be added to any calendar app. */
export function eventIcs(e: EventDoc, method: 'PUBLISH' | 'CANCEL' = 'PUBLISH'): string {
  const where = e.mode === 'online' ? (e.meetingLink ?? 'Online') : (e.address ?? e.institution ?? '');
  const desc = [e.contactName && `With: ${e.contactName}${e.institution ? `, ${e.institution}` : ''}`, e.contactEmail && `Email: ${e.contactEmail}`, e.notes].filter(Boolean).join('\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Class One Systems//ClassOne Discovery//EN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${e.id}@classone-discovery`,
    `DTSTAMP:${icsTime(new Date())}`,
    `DTSTART:${icsTime(e.start)}`,
    `DTEND:${icsTime(e.end)}`,
    `SUMMARY:${icsText(e.title)}`,
    where ? `LOCATION:${icsText(where)}` : '',
    desc ? `DESCRIPTION:${icsText(desc)}` : '',
    method === 'CANCEL' ? 'STATUS:CANCELLED' : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n');
}

function eventDetailsHtml(e: EventDoc): string {
  const rows: Array<[string, string]> = [
    ['When', esc(`${fmtWhen(e.start)} – ${fmtTime(e.end)}`)],
    ...(e.contactName ? ([['With', esc(`${e.contactName}${e.institution ? `, ${e.institution}` : ''}`)]] as Array<[string, string]>) : []),
    ...(e.contactEmail ? ([['Email', esc(e.contactEmail)]] as Array<[string, string]>) : []),
    ...(e.mode === 'online'
      ? ([['Where', e.meetingLink ? `<a href="${esc(e.meetingLink)}">${esc(e.meetingLink)}</a>` : 'Online']] as Array<[string, string]>)
      : e.address
        ? ([['Where', `${esc(e.address)} · <a href="${esc(mapSearch(e.address))}">Map</a>`]] as Array<[string, string]>)
        : []),
    ...(e.notes ? ([['Notes', esc(e.notes).replace(/\n/g, '<br>')]] as Array<[string, string]>) : []),
  ];
  return `<table style="border-collapse:collapse;margin:0 0 14px">${rows.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#6b7280;vertical-align:top">${k}</td><td style="padding:4px 0">${v}</td></tr>`).join('')}</table>`;
}

/** Tells the executive about a visit that is now theirs (or changed, or was cancelled), with a calendar file. */
export async function notifyAssignee(e: EventDoc, kind: 'new' | 'changed' | 'cancelled' = 'new'): Promise<void> {
  if (!e.assignee) return;
  const verb = kind === 'new' ? 'assigned to you' : kind === 'changed' ? 'changed' : 'cancelled';
  const html = shell(
    `${e.type === 'visit' ? 'Visit' : e.type === 'demo' ? 'Demo' : 'Event'} ${verb}: ${e.title}`,
    kind === 'cancelled' ? 'This is off — the calendar file removes it from your calendar.' : 'The details are below; open the attached file to add it to your calendar. On the day, use My visits to check in and out.',
    `${eventDetailsHtml(e)}<p>${button(`${env.appUrl}/schedules?view=mine`, 'Open My visits')}</p>`,
  );
  const text = `${e.title} — ${verb}\nWhen: ${fmtWhen(e.start)} – ${fmtTime(e.end)}${e.contactName ? `\nWith: ${e.contactName}` : ''}${e.address ? `\nWhere: ${e.address}` : ''}\n\nMy visits: ${env.appUrl}/schedules?view=mine`;
  await getEmailTransport().send({
    to: e.assignee,
    subject: `${kind === 'cancelled' ? 'Cancelled' : kind === 'changed' ? 'Changed' : 'New'}: ${e.title} · ${fmtWhen(e.start)}`,
    html,
    text,
    internal: true,
    attachments: [{ filename: 'invite.ics', content: Buffer.from(eventIcs(e, kind === 'cancelled' ? 'CANCEL' : 'PUBLISH')), contentType: 'text/calendar; charset=utf-8' }],
  });
  await ScheduleEventModel.updateOne({ _id: e.id }, { $set: { notifiedAssignee: e.assignee } });
}

const istDayStart = (d: Date) => {
  const ist = new Date(d.getTime() + IST);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST);
};
const istDayKey = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 10);

/** 07:30 IST: each executive gets their visits for the day (once per day). */
export async function morningDigest(now = new Date()): Promise<number> {
  const ist = new Date(now.getTime() + IST);
  if (ist.getUTCHours() * 60 + ist.getUTCMinutes() < 7 * 60 + 30) return 0;
  const key = istDayKey(now);
  if ((await getState<string>('scheduleDigestDay')) === key) return 0;
  await setState('scheduleDigestDay', key);
  const start = istDayStart(now);
  const events = (await listEvents({ from: start, to: new Date(start.getTime() + DAY) })).filter((e) => e.assignee && e.status !== 'cancelled' && e.type !== 'blocked');
  const by = new Map<string, EventDoc[]>();
  for (const e of events) by.set(e.assignee, [...(by.get(e.assignee) ?? []), e]);
  for (const [to, list] of by) {
    const html = shell(
      `Today: ${list.length} ${list.length === 1 ? 'appointment' : 'appointments'}`,
      'Your schedule for today. Check in and out from My visits.',
      `${list.map((e) => `<h3 style="margin:14px 0 4px;font-size:15px">${esc(fmtTime(e.start))} · ${esc(e.title)}</h3>${eventDetailsHtml(e)}`).join('')}<p>${button(`${env.appUrl}/schedules?view=mine`, 'Open My visits')}</p>`,
    );
    await getEmailTransport()
      .send({ to, subject: `Today: ${list.map((e) => `${fmtTime(e.start)} ${e.title}`).join(' · ').slice(0, 140)}`, html, text: list.map((e) => `${fmtTime(e.start)} ${e.title}${e.address ? ` — ${e.address}` : ''}`).join('\n'), internal: true })
      .catch((err) => console.error(`[schedules] morning list to ${to} failed:`, err instanceof Error ? err.message : err));
  }
  return by.size;
}

// --- Demo booking --------------------------------------------------------------------------------------

export interface BookingSettings {
  enabled: boolean;
  title: string;
  /** Weekdays offered, 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** IST, "HH:MM". */
  startTime: string;
  endTime: string;
  durationMinutes: number;
  bufferMinutes: number;
  /** How far ahead slots are offered, and how much notice is needed. */
  horizonDays: number;
  noticeHours: number;
  mode: 'online' | 'in_person';
  /** Whose calendar decides what is free, and who runs the demo. */
  assignee?: string;
  intro: string;
}

const DEFAULT_BOOKING: BookingSettings = {
  enabled: false,
  title: 'Product demo with Class One Systems',
  days: [1, 2, 3, 4, 5],
  startTime: '10:00',
  endTime: '17:00',
  durationMinutes: 30,
  bufferMinutes: 15,
  horizonDays: 21,
  noticeHours: 18,
  mode: 'online',
  intro: 'Pick a time for a short online demo of our electrochemical instruments. We will send the meeting link by email.',
};

export async function getBookingSettings(): Promise<BookingSettings> {
  return { ...DEFAULT_BOOKING, ...((await getState<Partial<BookingSettings>>('bookingSettings')) ?? {}) };
}

export async function setBookingSettings(patch: Partial<BookingSettings>): Promise<BookingSettings> {
  const next = { ...(await getBookingSettings()), ...patch };
  if (!/^\d{2}:\d{2}$/.test(next.startTime) || !/^\d{2}:\d{2}$/.test(next.endTime) || next.endTime <= next.startTime) throw new ApiError(400, 'Booking hours must be a start and a later end, like 10:00 and 17:00.');
  await setState('bookingSettings', next);
  return next;
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Free demo slots: the offered hours, minus the notice period and anything on the assignee's calendar. */
export async function freeSlots(now = new Date(), s?: BookingSettings): Promise<Array<{ start: string; end: string }>> {
  const settings = s ?? (await getBookingSettings());
  if (!settings.enabled) return [];
  const earliest = now.getTime() + settings.noticeHours * 3_600_000;
  const horizonEnd = new Date(istDayStart(now).getTime() + (settings.horizonDays + 1) * DAY);
  const busyFilter: Record<string, unknown> = { status: { $ne: 'cancelled' }, start: { $lt: horizonEnd }, end: { $gt: now } };
  busyFilter.$or = settings.assignee ? [{ assignee: settings.assignee }, { type: 'demo', source: 'booking' }] : [{ type: { $in: ['demo', 'blocked'] } }];
  const busy = (await ScheduleEventModel.find(busyFilter, { start: 1, end: 1 }).lean()) as Array<{ start: Date; end: Date }>;
  const buffer = settings.bufferMinutes * MIN;
  const out: Array<{ start: string; end: string }> = [];
  for (let d = 0; d <= settings.horizonDays; d++) {
    const dayStart = new Date(istDayStart(now).getTime() + d * DAY);
    const weekday = new Date(dayStart.getTime() + IST).getUTCDay();
    if (!settings.days.includes(weekday)) continue;
    for (let m = minutesOf(settings.startTime); m + settings.durationMinutes <= minutesOf(settings.endTime); m += settings.durationMinutes) {
      const st = dayStart.getTime() + m * MIN;
      const en = st + settings.durationMinutes * MIN;
      if (st < earliest) continue;
      if (busy.some((b) => new Date(b.start).getTime() < en + buffer && new Date(b.end).getTime() > st - buffer)) continue;
      out.push({ start: new Date(st).toISOString(), end: new Date(en).toISOString() });
    }
  }
  return out;
}

export interface BookingRequest {
  start: string;
  name: string;
  email: string;
  institution?: string;
  phone?: string;
  message?: string;
}

/** A customer books a slot: a demo event linked to their lead, a confirmation from the sales mailbox, and the assignee told. */
export async function book(req: BookingRequest, now = new Date()): Promise<EventDoc> {
  const settings = await getBookingSettings();
  if (!settings.enabled) throw new ApiError(400, 'Booking is not open right now — please email us instead.');
  const slot = (await freeSlots(now, settings)).find((s) => s.start === new Date(req.start).toISOString());
  if (!slot) throw new ApiError(409, 'That time was just taken — please pick another.');
  const email = req.email.trim().toLowerCase();
  const leadDoc = (await LeadModel.findOne({ 'person.email': { $regex: `^${escapeRegex(email)}$`, $options: 'i' } }, { _id: 1 }).lean()) as { _id: unknown } | null;
  const leadId = leadDoc ? String(leadDoc._id) : undefined;
  const assignee = settings.assignee?.toLowerCase();
  const doc = await ScheduleEventModel.create({
    title: `${settings.mode === 'online' ? 'Online demo' : 'Demo'} — ${req.name.trim()}`,
    type: 'demo',
    start: new Date(slot.start),
    end: new Date(slot.end),
    leadId,
    contactEmail: email,
    contactName: req.name.trim(),
    institution: req.institution?.trim() || undefined,
    mode: settings.mode,
    assignee,
    assigneeName: await nameOf(assignee),
    notes: req.message?.trim() || undefined,
    source: 'booking',
    booking: { name: req.name.trim(), email, phone: req.phone?.trim(), institution: req.institution?.trim(), message: req.message?.trim() },
  });
  const e = toDoc(doc.toObject());
  if (!leadId) await touchContact(email, { name: req.name.trim(), institution: req.institution?.trim(), phone: req.phone?.trim(), lastMessageAt: now });
  await logActivity({ type: 'booking_created', message: `${req.name.trim()}${req.institution ? `, ${req.institution}` : ''} booked a demo for ${fmtWhen(e.start)}`, relatedLeadId: leadId });

  // Confirmation to them, from the sales mailbox, on a conversation of its own (so the team sees it).
  const when = `${fmtWhen(e.start)} – ${fmtTime(e.end)} IST`;
  const body = `Dear ${req.name.trim()},\n\nThank you for booking a demo with Class One Systems. It is confirmed for ${when}.\n\n${settings.mode === 'online' ? 'We will email you the meeting link before the demo.' : 'We will confirm the meeting place with you.'} If you need to change the time, just reply to this email.\n\nTeam Class One Systems`;
  const thread = await repositories.threads.create({
    leadId,
    contactEmail: email,
    contactName: req.name.trim(),
    leadEmailSnapshot: email,
    subjectLine: `Your demo with Class One Systems — ${fmtWhen(e.start)}`,
    status: 'open',
    provider: 'gmail',
    messages: [],
    followUp: { attemptsSent: 0, maxAttempts: 0, replyDetected: false },
  });
  await sendOnNewThread(thread, {
    to: email,
    subject: thread.subjectLine,
    body,
    type: 'manual',
    draftedBy: 'human',
    sentBy: 'booking',
    noFollowUp: true,
    attachments: [{ filename: 'demo.ics', content: Buffer.from(eventIcs(e)), contentType: 'text/calendar; charset=utf-8' }],
  }).catch((err) => console.error('[booking] confirmation email failed:', err instanceof Error ? err.message : err));

  if (assignee) await notifyAssignee(e).catch(() => {});
  else {
    const { sendToTeam } = await import('../email/replyWatch.js');
    await sendToTeam(`Demo booked: ${req.name.trim()} · ${fmtWhen(e.start)}`, shell(`Demo booked: ${req.name.trim()}`, 'Booked on the public booking page. Nobody is set to run booked demos — assign it in Schedules.', `${eventDetailsHtml(e)}<p>${button(`${env.appUrl}/schedules`, 'Open Schedules')}</p>`), `${req.name.trim()} booked a demo for ${when}.`).catch(() => {});
  }
  return e;
}

// --- Ticker ---------------------------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
export function startScheduleJobs(): void {
  const tick = () => void morningDigest().then((n) => n && console.log(`[schedules] morning list sent to ${n} executive${n === 1 ? '' : 's'}`)).catch((e) => console.error('[schedules] morning list failed:', e instanceof Error ? e.message : e));
  timer = setInterval(tick, 10 * MIN);
  setTimeout(tick, 2 * MIN);
}
export function stopScheduleJobs(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
