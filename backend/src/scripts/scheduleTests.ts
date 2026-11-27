/** Tests for Schedules: calendar events, field visits, the board, and demo booking (services/schedules). */
import assert from 'node:assert/strict';

type Check = (name: string, fn: () => Promise<void> | void) => Promise<void>;

export async function runScheduleTests(check: Check, base = 'http://localhost:4999/api'): Promise<void> {
  const s = await import('../services/schedules/scheduleService.js');
  const { ScheduleEventModel } = await import('../models/scheduleEvent.model.js');
  const { AppUserModel } = await import('../models/appUser.model.js');
  const { EmailThreadModel } = await import('../models/emailThread.model.js');
  const { SystemStateModel } = await import('../models/systemState.model.js');
  const { setEmailTransport } = await import('../services/email/transports/index.js');
  const { repositories } = await import('../repositories/index.js');
  const { normalizeNameKey } = await import('../utils/normalize.js');

  console.log('\nSchedules:\n');
  const exec = 'field.exec@classone.test';
  await AppUserModel.updateOne({ uid: 'sched-exec' }, { $set: { uid: 'sched-exec', email: exec, name: 'Field Exec', role: 'sales' } }, { upsert: true });
  const sent: Array<{ to: string; subject: string; attachments?: Array<{ filename: string; content: Buffer }> }> = [];
  setEmailTransport({ name: 'gmail', send: async (m) => (sent.push(m as never), { providerMessageId: `s-${sent.length}`, threadId: `gt-s-${sent.length}`, rfcMessageId: `<s${sent.length}@t>` }) });
  const lead = await repositories.leads.create({
    status: 'approved',
    source: { type: 'manual', discoveredAt: new Date() },
    person: { name: 'Dr. Visit Varma', normalizedNameKey: normalizeNameKey('Dr. Visit Varma'), email: 'visit.varma@uni.test' },
    institution: { name: 'NIT Schedules' },
    research: { topics: [], recentPublications: [], recentGrants: [], instruments: [] },
    aiScoring: { recommendedProductIds: [] },
    review: {},
    followUpStatusSummary: 'not_started',
    tags: ['test'],
  });
  const H = 3_600_000;
  const inHours = (h: number) => new Date(Date.now() + h * H);

  try {
    let visitId = '';
    await check('a visit assigned to an executive takes the lead’s details and emails them a calendar file', async () => {
      const e = await s.createEvent({ title: 'Lab visit', type: 'visit', start: inHours(2), end: inHours(3), leadId: lead.id, address: 'Dept of Chemistry, NIT', assignee: exec }, 'boss@classone.test');
      visitId = e.id;
      assert.equal(e.contactName, 'Dr. Visit Varma');
      assert.equal(e.institution, 'NIT Schedules');
      assert.equal(e.assigneeName, 'Field Exec');
      const mail = sent.find((m) => m.to === exec)!;
      assert.match(mail.subject, /^New: Lab visit/);
      const ics = mail.attachments![0]!.content.toString();
      assert.match(ics, /BEGIN:VEVENT/);
      assert.match(ics, /SUMMARY:Lab visit/);
      assert.match(ics, /LOCATION:Dept of Chemistry\\, NIT/);
    });

    await check('moving a visit tells the executive again; times must make sense', async () => {
      const before = sent.length;
      await s.updateEvent(visitId, { start: inHours(4), end: inHours(5) });
      assert.equal(sent.length, before + 1);
      assert.match(sent.at(-1)!.subject, /^Changed: /);
      await assert.rejects(() => s.updateEvent(visitId, { end: inHours(3) }), /end must be after the start/);
    });

    await check('only the assigned executive (or an admin) can check in; each step records time and one location', async () => {
      await assert.rejects(() => s.fieldStep(visitId, 'check_in', { email: 'someone.else@classone.test', role: 'sales' }, {}), /assigned to Field Exec/);
      await s.fieldStep(visitId, 'on_the_way', { email: exec, role: 'sales' }, { lat: 13.01, lng: 80.23 });
      const at = await s.fieldStep(visitId, 'check_in', { email: exec, role: 'sales' }, { lat: 13.0101, lng: 80.2302, accuracy: 25 });
      assert.equal(at.status, 'checked_in');
      assert.equal(at.checkIn.lat, 13.0101);
      const board = await s.fieldBoard(new Date());
      const me = board.find((p) => p.email === exec)!;
      assert.equal(me.state, 'at_visit');
      assert.equal(me.lastLocation!.kind, 'checkIn');
      const done = await s.fieldStep(visitId, 'check_out', { email: exec, role: 'sales' }, { note: 'Wants a quote for EmStat4S' });
      assert.equal(done.status, 'done');
      assert.equal(done.outcome, 'Wants a quote for EmStat4S');
    });

    await check('a visit whose time passed without a check-in shows as missed', () => {
      assert.equal(s.displayStatus({ status: 'scheduled', end: new Date(Date.now() - 2 * H), type: 'visit' }), 'missed');
      assert.equal(s.displayStatus({ status: 'scheduled', end: new Date(Date.now() + H), type: 'visit' }), 'scheduled');
      assert.equal(s.displayStatus({ status: 'scheduled', end: new Date(Date.now() - 2 * H), type: 'meeting' }), 'scheduled');
    });

    await check('booking: slots follow the settings, leave out busy time and the notice period', async () => {
      await s.setBookingSettings({ enabled: true, days: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '23:30', durationMinutes: 30, bufferMinutes: 0, noticeHours: 2, horizonDays: 2, assignee: exec });
      const slots = await s.freeSlots();
      assert.ok(slots.length > 20);
      assert.ok(slots.every((x) => new Date(x.start).getTime() >= Date.now() + 2 * H - 60_000), 'nothing inside the notice period');
      const busy = await s.createEvent({ title: 'Busy', type: 'blocked', start: new Date(slots[3]!.start), end: new Date(slots[5]!.end), assignee: exec });
      const after = await s.freeSlots();
      assert.ok(!after.some((x) => x.start === slots[4]!.start), 'busy time is not offered');
      await s.deleteEvent(busy.id);
    });

    await check('a booking becomes a demo linked to the lead, with a confirmation in Conversations; a taken slot is refused', async () => {
      const slot = (await s.freeSlots())[0]!;
      const e = await s.book({ start: slot.start, name: 'Dr. Visit Varma', email: 'Visit.Varma@uni.test', institution: 'NIT Schedules', message: 'Show me EIS' });
      assert.equal(e.type, 'demo');
      assert.equal(e.source, 'booking');
      assert.equal(e.leadId, lead.id);
      assert.equal(e.assignee, exec);
      const thread = (await EmailThreadModel.findOne({ contactEmail: 'visit.varma@uni.test', subjectLine: /Your demo/ }).lean()) as any;
      assert.ok(thread, 'confirmation on a conversation');
      assert.equal(thread.messages[0].type, 'manual');
      assert.equal(thread.followUp.nextCheckAt, undefined, 'no follow-ups on a confirmation');
      await assert.rejects(() => s.book({ start: slot.start, name: 'Someone', email: 'someone@uni.test' }), /just taken/);
    });

    await check('the public booking page: closed when switched off; the honeypot drops bots silently', async () => {
      const open = (await (await fetch(`${base}/public/booking`)).json()) as { open: boolean; slots: unknown[] };
      assert.equal(open.open, true);
      const bot = await fetch(`${base}/public/booking`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start: new Date().toISOString(), name: 'Bot', email: 'bot@spam.test', website: 'http://spam' }) });
      assert.equal(bot.status, 201);
      assert.equal(await ScheduleEventModel.countDocuments({ contactEmail: 'bot@spam.test' }), 0);
      await s.setBookingSettings({ enabled: false });
      assert.deepEqual(await s.freeSlots(), []);
      await assert.rejects(() => s.book({ start: new Date().toISOString(), name: 'X', email: 'x@uni.test' }), /not open/);
    });
  } finally {
    setEmailTransport(null);
    await ScheduleEventModel.deleteMany({ $or: [{ assignee: exec }, { contactEmail: { $in: ['visit.varma@uni.test', 'bot@spam.test'] } }] });
    await EmailThreadModel.deleteMany({ contactEmail: 'visit.varma@uni.test' });
    await AppUserModel.deleteOne({ uid: 'sched-exec' });
    await repositories.leads.deleteById(lead.id);
    await SystemStateModel.deleteOne({ key: 'bookingSettings' });
  }
}
