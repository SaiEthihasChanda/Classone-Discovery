/** Tests for campaign results: clicks, booking-page visits, bookings, replies, and the nudge (campaignResults.ts). */
import assert from 'node:assert/strict';

type Check = (name: string, fn: () => Promise<void> | void) => Promise<void>;

export async function runResultsTests(check: Check): Promise<void> {
  const r = await import('../services/campaigns/campaignResults.js');
  const { CampaignModel, CampaignRecipientModel } = await import('../models/campaign.model.js');
  const { EmailThreadModel } = await import('../models/emailThread.model.js');
  const { ScheduleEventModel } = await import('../models/scheduleEvent.model.js');

  console.log('\nCampaign results:\n');
  const H = 3_600_000;
  const t0 = new Date(Date.now() - 48 * H);
  const camp = await CampaignModel.create({ name: 'Results test', subject: 'See PalmSens4', blocks: [], audience: { statuses: ['approved'] }, status: 'done' });
  const cid = String(camp._id);
  const book = 'https://discovery.test/book';
  const product = 'https://classonesystems.in/product/palmsens4';
  const people = [
    { email: 'booker@uni.test', clicks: [product, book], booked: true },
    { email: 'looker@uni.test', clicks: [book], booked: false },
    { email: 'reader@uni.test', clicks: [product], booked: false, replied: true },
    { email: 'silent@uni.test', clicks: [], booked: false, opened: false },
  ];
  const threadIds: string[] = [];
  for (const p of people) {
    const th = await EmailThreadModel.create({
      leadEmailSnapshot: p.email,
      contactEmail: p.email,
      subjectLine: 'See PalmSens4',
      status: p.replied ? 'replied' : 'open',
      provider: 'gmail',
      messages: [
        { messageId: `c-${p.email}`, direction: 'outbound', type: 'campaign', subject: 'See PalmSens4', bodyText: 'x', sentAt: t0 },
        ...(p.replied ? [{ messageId: `r-${p.email}`, direction: 'inbound', type: 'reply', subject: 'Re', bodyText: 'Price?', sentAt: new Date(t0.getTime() + H) }] : []),
      ],
      followUp: { attemptsSent: 0, maxAttempts: 0, replyDetected: Boolean(p.replied) },
    });
    threadIds.push(String(th._id));
    await CampaignRecipientModel.create({
      campaignId: cid,
      email: p.email,
      name: p.email.split('@')[0],
      status: 'sent',
      sentAt: t0,
      threadId: String(th._id),
      ...(p.opened === false ? {} : { openedAt: new Date(t0.getTime() + H), opens: 1 }),
      ...(p.clicks.length ? { clicks: p.clicks.length, clickedAt: new Date(t0.getTime() + H), clickLog: p.clicks.map((url) => ({ url, at: new Date(t0.getTime() + H) })) } : {}),
    });
    if (p.booked) await ScheduleEventModel.create({ title: 'Demo', type: 'demo', start: new Date(Date.now() + 24 * H), end: new Date(Date.now() + 25 * H), contactEmail: p.email, source: 'booking' });
  }

  try {
    await check('results show, per person, the links clicked, the booking page, bookings and replies', async () => {
      const { rows, summary } = await r.campaignResults(cid);
      assert.deepEqual(summary, { sent: 4, opened: 3, clicked: 3, clickedBooking: 2, booked: 1, clickedNotBooked: 1, replied: 1 });
      const booker = rows.find((x) => x.email === 'booker@uni.test')!;
      assert.equal(booker.clickedBooking, true);
      assert.ok(booker.booked);
      assert.equal(rows.find((x) => x.email === 'looker@uni.test')!.booked, null);
      assert.equal(rows.find((x) => x.email === 'reader@uni.test')!.replied, true);
      assert.equal(r.isBookingLink('https://x.test/book?a=1'), true);
      assert.equal(r.isBookingLink('https://classonesystems.in/booking-info'), false);
    });

    await check('the nudge drafts a follow-up only for people who opened the booking page and did not book — once', async () => {
      assert.equal(await r.nudgeNonBookers(cid), 1);
      const looker = (await EmailThreadModel.findOne({ contactEmail: 'looker@uni.test' }).lean()) as any;
      assert.equal(looker.status, 'draft');
      assert.equal(looker.draftType, 'follow_up_1');
      assert.match(looker.draftBody, /none of the demo times suited you/);
      assert.equal(((await EmailThreadModel.findOne({ contactEmail: 'booker@uni.test' }).lean()) as any).status, 'open', 'the booker is left alone');
      assert.equal(await r.nudgeNonBookers(cid), 0, 'not twice');
    });

    await check('the dashboard counts the same journey across all campaigns in the period', async () => {
      const e = await r.engagementSince(new Date(t0.getTime() - H));
      assert.ok(e.emailed >= 4);
      assert.ok(e.clickedBooking >= 2);
      assert.ok(e.bookedAfterClick >= 1);
      assert.ok(e.clickedNotBooked >= 1);
    });
  } finally {
    await CampaignModel.deleteOne({ _id: cid });
    await CampaignRecipientModel.deleteMany({ campaignId: cid });
    await EmailThreadModel.deleteMany({ _id: { $in: threadIds } });
    await ScheduleEventModel.deleteMany({ contactEmail: 'booker@uni.test' });
  }
}
