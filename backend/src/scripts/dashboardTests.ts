/**
 * Tests for the analytics dashboard (services/dashboard/dashboardService.ts). The smoke-test
 * database holds other fixtures, so each check compares the numbers before and after adding
 * known threads rather than asserting absolute totals.
 */
import assert from 'node:assert/strict';

type Check = (name: string, fn: () => Promise<void> | void) => Promise<void>;

export async function runDashboardTests(check: Check): Promise<void> {
  const { buildDashboard } = await import('../services/dashboard/dashboardService.js');
  const { EmailThreadModel } = await import('../models/emailThread.model.js');

  console.log('\nDashboard:\n');
  const H = 3_600_000;
  const now = new Date();
  const ago = (h: number) => new Date(now.getTime() - h * H);
  const seller = 'dash.seller@classone.test';
  const msg = (id: string, direction: 'outbound' | 'inbound', at: Date, extra: Record<string, unknown> = {}) => ({
    messageId: id,
    direction,
    type: direction === 'outbound' ? 'initial_outreach' : 'reply',
    subject: 'Dashboard test',
    bodyText: 'x',
    sentAt: at,
    rfcMessageId: `<${id}@dash>`,
    ...extra,
  });
  const mk = (tid: string, messages: unknown[], extra: Record<string, unknown> = {}) =>
    EmailThreadModel.create({ contactEmail: `${tid}@uni.test`, leadEmailSnapshot: `${tid}@uni.test`, subjectLine: 'Dashboard test', status: 'open', provider: 'gmail', providerThreadId: tid, messages, followUp: { attemptsSent: 0, maxAttempts: 2, replyDetected: false }, ...extra });

  try {
    const before = await buildDashboard('30', now);

    // We wrote (AI draft approved by the seller) 10 h ago, they replied 4 h later.
    await mk('dash-t1', [msg('d1', 'outbound', ago(10), { sentBy: seller, draftedBy: 'ai' }), msg('d2', 'inbound', ago(6))]);
    // We wrote by hand, no reply yet.
    await mk('dash-t2', [msg('d3', 'outbound', ago(20), { sentBy: seller, draftedBy: 'human' })]);
    // They wrote first; the seller answered 2 h later — an answer, not outreach.
    await mk('dash-t3', [msg('d4', 'inbound', ago(5)), msg('d5', 'outbound', ago(3), { type: 'response', sentBy: seller, draftedBy: 'human' })]);
    // An automatic follow-up.
    await mk('dash-t4', [msg('d6', 'outbound', ago(100), { sentBy: seller }), msg('d7', 'outbound', ago(2), { type: 'follow_up_1', sentBy: 'auto-followup', draftedBy: 'ai' })]);

    const after = await buildDashboard('30', now);

    await check('emails sent and received count every message in the period, by kind', () => {
      assert.equal(after.headline.emailsSent.value - before.headline.emailsSent.value, 5);
      assert.equal(after.outreach.received - before.outreach.received, 2);
      assert.equal(after.outreach.sends.automatic - before.outreach.sends.automatic, 1);
      assert.equal(after.outreach.followUps.auto - before.outreach.followUps.auto, 1);
    });

    await check('reply rate only counts conversations we started', () => {
      const r = after.headline.replyRate;
      const b = before.headline.replyRate;
      assert.equal(r.contacted - b.contacted, 3, 'threads 1, 2 and 4 — not 3, where they wrote first');
      assert.equal(r.replied - b.replied, 1);
    });

    await check('team: the seller gets sends, approvals and answer time; automatic sends get their own row', () => {
      const row = after.team.find((t) => t.who === seller);
      assert.ok(row, 'seller row');
      assert.equal(row.sent, 4);
      assert.equal(row.approved, 1);
      assert.equal(row.medianResponseHours, 2);
      const autoRow = after.team.find((t) => t.who === 'Automatic');
      const autoBefore = before.team.find((t) => t.who === 'Automatic');
      assert.equal((autoRow?.sent ?? 0) - (autoBefore?.sent ?? 0), 1);
    });

    await check('trends: weekly buckets for 30 days whose sends add up to the period total', () => {
      assert.equal(after.trends.bucketDays, 7);
      const sum = after.trends.buckets.reduce((n, x) => n + x.manual + x.ai + x.automatic + x.campaign, 0);
      assert.equal(sum, after.headline.emailsSent.value);
      assert.equal(after.funnel.map((s) => s.key).join(','), 'found,verified,scored,leads,approved,contacted,replied');
    });

    await check('the 7-day range uses seven daily buckets', async () => {
      const week = await buildDashboard('7', now);
      assert.equal(week.trends.bucketDays, 1);
      assert.equal(week.trends.buckets.length, 7);
    });
  } finally {
    await EmailThreadModel.deleteMany({ providerThreadId: { $in: ['dash-t1', 'dash-t2', 'dash-t3', 'dash-t4'] } });
  }
}
