/** Tests for the Monday weekly summary email (services/reports/weeklySummary.ts). */
import assert from 'node:assert/strict';

type Check = (name: string, fn: () => Promise<void> | void) => Promise<void>;

export async function runWeeklySummaryTests(check: Check): Promise<void> {
  const w = await import('../services/reports/weeklySummary.js');
  const { setState } = await import('../models/systemState.model.js');
  const { SystemStateModel } = await import('../models/systemState.model.js');
  const { setEmailTransport } = await import('../services/email/transports/index.js');

  console.log('\nWeekly summary:\n');
  // Times in IST: Monday 30 Nov 2026.
  const ist = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 10, d, h, m) - 330 * 60_000);
  const sent: Array<{ to: string; subject: string; html?: string }> = [];
  setEmailTransport({ name: 'gmail', send: async (m) => (sent.push(m), { providerMessageId: 'x', threadId: 'y', rfcMessageId: '<z@t>' }) });

  try {
    await check('weeks start on Monday, IST', () => {
      assert.equal(w.istWeekStart(ist(30, 9)), '2026-11-30');
      assert.equal(w.istWeekStart(ist(29, 23, 59)), '2026-11-23', 'Sunday night is still the week before');
      assert.equal(w.istWeekStart(ist(30, 0, 5)), '2026-11-30', 'just after midnight IST on Monday');
    });

    await check('due from Monday 09:00 IST once a week; the first check only marks the week', async () => {
      await SystemStateModel.deleteOne({ key: 'weeklySummaryWeek' });
      assert.equal(await w.weeklySummaryDue(ist(26, 12)), false, 'first check: marks this week, sends nothing');
      assert.equal(await w.weeklySummaryDue(ist(30, 8, 59)), false, 'Monday before 09:00');
      assert.equal(await w.weeklySummaryDue(ist(30, 9, 1)), true);
      await setState('weeklySummaryWeek', '2026-11-30');
      assert.equal(await w.weeklySummaryDue(ist(30, 10)), false, 'already sent this week');
    });

    await check('the summary has the numbers, what needs attention and a link to the dashboard; it goes to the team', async () => {
      const s = await w.buildWeeklySummary();
      assert.match(s.subject, /^Weekly summary: \d+ sent, \d+ replies, \d+ enquiries$/);
      assert.match(s.html, /Emails sent/);
      assert.match(s.html, /Needs attention/);
      assert.match(s.html, /Open the dashboard/);
      assert.match(s.text, /Dashboard: /);
      await w.sendWeeklySummary(ist(30, 9, 30));
      assert.ok(sent.length >= 1);
      assert.equal(sent[0]!.subject, s.subject);
    });
  } finally {
    setEmailTransport(null);
    await SystemStateModel.deleteOne({ key: 'weeklySummaryWeek' });
  }
}
