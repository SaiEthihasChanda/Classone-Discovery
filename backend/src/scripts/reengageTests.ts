/** Tests for re-engagement check-ins (services/email/reengage.ts). */
import assert from 'node:assert/strict';

type Check = (name: string, fn: () => Promise<void> | void) => Promise<void>;

export async function runReengageTests(check: Check): Promise<void> {
  const r = await import('../services/email/reengage.js');
  const { repositories } = await import('../repositories/index.js');
  const { EmailThreadModel } = await import('../models/emailThread.model.js');
  const { LeadModel } = await import('../models/lead.model.js');
  const { normalizeNameKey } = await import('../utils/normalize.js');
  const { approveAndSendOutreach, rejectDraft } = await import('../services/email/outreachService.js');
  const { setEmailTransport } = await import('../services/email/transports/index.js');
  const { setState } = await import('../models/systemState.model.js');

  console.log('\nRe-engagement check-ins:\n');
  const now = new Date();
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
  const emails: string[] = [];
  const mkLead = async (name: string, extra: Record<string, unknown> = {}) => {
    const email = `${name.toLowerCase().replace(/\W+/g, '.')}@reengage.test`;
    emails.push(email);
    return repositories.leads.create({
      status: 'approved',
      source: { type: 'manual', discoveredAt: ago(400) },
      person: { name, normalizedNameKey: normalizeNameKey(name), email, title: 'Professor' },
      institution: { name: 'IIT Test' },
      research: { topics: [], recentPublications: [], recentGrants: [], instruments: [] },
      aiScoring: { recommendedProductIds: [] },
      review: {},
      followUpStatusSummary: 'closed',
      tags: ['test'],
      ...extra,
    } as never);
  };
  const mkThread = (lead: { id: string; person: { email?: string } }, lastDaysAgo: number, extra: Record<string, unknown> = {}, lastIntent?: string) =>
    EmailThreadModel.create({
      leadId: lead.id,
      leadEmailSnapshot: lead.person.email,
      contactEmail: lead.person.email,
      subjectLine: 'Electrochemical instrumentation',
      status: 'replied',
      provider: 'gmail',
      messages: [
        { messageId: `o-${lead.id}`, direction: 'outbound', type: 'initial_outreach', subject: 'Electrochemical instrumentation', bodyText: 'Hello', sentAt: ago(lastDaysAgo + 3) },
        { messageId: `i-${lead.id}`, direction: 'inbound', type: 'reply', subject: 'Re: Electrochemical instrumentation', bodyText: 'Maybe next year', sentAt: ago(lastDaysAgo), intent: lastIntent },
      ],
      followUp: { attemptsSent: 0, maxAttempts: 2, replyDetected: true },
      ...extra,
    });

  const quiet = await mkLead('Quiet Qureshi');
  const recent = await mkLead('Recent Reddy');
  const declined = await mkLead('Declined Das');
  const dnc = await mkLead('Optout Oberoi', { doNotContact: true });
  const busy = await mkLead('Busy Bose');
  await mkThread(quiet, 120);
  await mkThread(recent, 20);
  await mkThread(declined, 120, {}, 'not_interested');
  await mkThread(dnc, 120);
  await mkThread(busy, 120, { status: 'draft', draftType: 'response', draftBody: 'x', draftSubject: 'x' });

  let wrote: Array<{ lastSubject: string; newProducts: string[] }> = [];
  r.setCheckInWriter(async (i) => (wrote.push(i), { subject: `Re: ${i.lastSubject}`, body: 'Dear Prof. Qureshi,\n\nHow are your plans shaping up?\n\nTeam Class One Systems', model: 'stub' }));
  const sent: Array<{ to: string }> = [];
  setEmailTransport({ name: 'gmail', send: async (m) => (sent.push(m), { providerMessageId: `ck-${sent.length}`, threadId: 'gt-ck', rfcMessageId: '<ck@t>' }) });
  await setState('reengageSettings', { enabled: true, quietDays: 90, dailyMax: 10 });

  try {
    await check('only people quiet for 90+ days, reachable, with nothing pending, are due — "not interested" waits 180 days', async () => {
      const c = await r.checkInCandidates(now, await r.getReengageSettings(), 50);
      const ids = c.map((x) => x.leadId);
      assert.ok(ids.includes(quiet.id), 'quiet for 120 days');
      for (const l of [recent, declined, dnc, busy]) assert.ok(!ids.includes(l.id), `${l.person.name} is not due`);
    });

    await check('a check-in is drafted on their latest conversation, for approval, and not again for 180 days', async () => {
      wrote = [];
      await r.draftCheckIns(now);
      const t = (await EmailThreadModel.findOne({ leadId: quiet.id }).lean()) as any;
      assert.equal(t.status, 'draft');
      assert.equal(t.draftType, 'check_in');
      assert.equal(t.draftSubject, 'Re: Re: Electrochemical instrumentation');
      assert.ok(wrote.some((w) => w.lastSubject === 'Re: Electrochemical instrumentation'));
      assert.ok(((await LeadModel.findById(quiet.id).lean()) as any).lastCheckInAt);
      const again = await r.checkInCandidates(now, await r.getReengageSettings(), 50);
      assert.ok(!again.some((x) => x.leadId === quiet.id));
      assert.equal(sent.length, 0, 'nothing is sent by itself');
    });

    await check('approving a check-in sends it once, with no automatic follow-ups after it', async () => {
      const t = (await EmailThreadModel.findOne({ leadId: quiet.id }).lean()) as any;
      const after = await approveAndSendOutreach(String(t._id));
      assert.equal(sent.length, 1);
      assert.equal(after.messages.at(-1)!.type, 'check_in');
      assert.equal(after.followUp.nextCheckAt, undefined);
      assert.equal(after.followUp.attemptsSent, 0, 'not counted as a follow-up');
    });

    await check('turning check-ins off drafts nothing; a discarded check-in leaves the conversation quiet', async () => {
      await r.setReengageSettings({ enabled: false });
      assert.equal(await r.draftCheckIns(now), 0);
      await r.setReengageSettings({ enabled: true });
      const other = await mkLead('Second Sharma');
      const th = await mkThread(other, 150);
      await r.draftCheckIns(now);
      const discarded = await rejectDraft(String(th._id));
      assert.equal(discarded.status, 'replied');
      assert.equal(discarded.draftBody, undefined);
    });
  } finally {
    r.setCheckInWriter(null);
    setEmailTransport(null);
    await EmailThreadModel.deleteMany({ leadEmailSnapshot: { $in: emails } });
    await LeadModel.deleteMany({ 'person.email': { $in: emails } });
  }
}
