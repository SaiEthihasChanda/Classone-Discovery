/** Tests for funding alerts (services/funding/fundingAlerts.ts), with a fake OpenAlex and a stub AI. */
import assert from 'node:assert/strict';

type Check = (name: string, fn: () => Promise<void> | void) => Promise<void>;

export async function runFundingTests(check: Check, base = 'http://localhost:4999/api'): Promise<void> {
  const f = await import('../services/funding/fundingAlerts.js');
  const { LeadModel } = await import('../models/lead.model.js');
  const { EmailThreadModel } = await import('../models/emailThread.model.js');
  const { SystemStateModel } = await import('../models/systemState.model.js');
  const { repositories } = await import('../repositories/index.js');
  const { normalizeNameKey } = await import('../utils/normalize.js');
  const { approveAndSendOutreach, rejectDraft } = await import('../services/email/outreachService.js');
  const { setEmailTransport } = await import('../services/email/transports/index.js');
  const { needsYouQueue } = (await import('../services/email/conversationService.js')) as unknown as { needsYouQueue?: () => Promise<Array<{ threadId: string; draft?: { type?: string } }>> };

  console.log('\nFunding alerts:\n');
  const now = new Date();
  const year = new Date(now.getTime() + 330 * 60_000).getUTCFullYear();
  const emails: string[] = [];
  const mk = async (name: string, authorId: string, extra: Record<string, unknown> = {}) => {
    const email = `${name.toLowerCase().replace(/\W+/g, '.')}@funding.test`;
    emails.push(email);
    return repositories.leads.create({ status: 'approved', source: { type: 'faculty_roster', sourceRecordId: authorId, discoveredAt: now }, person: { name, normalizedNameKey: normalizeNameKey(name), email, title: 'Professor' }, institution: { name: 'IIT Funding' }, research: { topics: [], recentPublications: [], recentGrants: [], instruments: [] }, aiScoring: { recommendedProductIds: [] }, review: {}, followUpStatusSummary: 'not_started', tags: ['test'], ...extra } as never);
  };
  const serb = (awardId: string, y: number) => ({ agency: 'serb' as const, funder: 'Science and Engineering Research Board', awardId, scheme: 'Core Research Grant', year: y, papers: 1, workTitle: 'Sodium-ion cathodes at scale', workYear: year });
  const grants = new Map<string, ReturnType<typeof serb>[]>();
  f.setFundingSeams({ fetcher: async (id) => grants.get(id) ?? [], writer: async ({ lead, grant }) => ({ subject: 'Congratulations on your SERB grant', body: `Dear Prof. ${String(lead.person.name).split(' ').pop()},\n\nCongratulations on the ${grant.scheme}…\n\nTeam Class One Systems`, model: 'stub' }) });
  const sent: Array<{ to: string }> = [];
  setEmailTransport({ name: 'gmail', send: async (m) => (sent.push(m), { providerMessageId: `f-${sent.length}`, threadId: 'gt-f', rfcMessageId: '<f@t>' }) });

  const funded = await mk('Funded Iyer', 'https://openalex.org/A5000000001');
  const quiet = await mk('Old Grant Rao', 'https://openalex.org/A5000000002');
  const optout = await mk('Optout Shah', 'https://openalex.org/A5000000003', { doNotContact: true });
  const noId = await mk('No Author Menon', 'manual-123');
  grants.set('https://openalex.org/A5000000001', [serb('CRG/2023/001111', year - 3)]);
  grants.set('https://openalex.org/A5000000002', [serb('CRG/2022/002222', year - 4)]);
  grants.set('https://openalex.org/A5000000003', []);
  await SystemStateModel.deleteOne({ key: 'fundingAlertsBaseline' });

  try {
    await check('the first run only records what is already acknowledged — no alerts', async () => {
      const r = await f.runFundingCheck(now);
      assert.equal(r.firstRun, true);
      assert.equal(r.newSignals, 0);
      assert.equal(((await LeadModel.findById(funded.id).lean()) as any).research.funding.length, 1);
      assert.equal(await f.FundingSignalModel.countDocuments({ leadId: { $in: [funded.id, quiet.id, optout.id, noId.id] } }), 0);
    });

    await check('a new recent grant becomes a signal, a badge and a note drafted for approval; an old one does not', async () => {
      grants.get('https://openalex.org/A5000000001')!.push(serb('CRG/2026/009999', year));
      grants.get('https://openalex.org/A5000000002')!.push(serb('CRG/2021/003333', year - 5));
      grants.set('https://openalex.org/A5000000003', [serb('SRG/2026/004444', year)]);
      const r = await f.runFundingCheck(now);
      assert.equal(r.firstRun, false);
      const sig = (await f.FundingSignalModel.findOne({ leadId: funded.id }).lean()) as any;
      assert.equal(sig.key, 'serb:CRG/2026/009999');
      assert.equal(sig.status, 'drafted');
      assert.ok(((await LeadModel.findById(funded.id).lean()) as any).fundingAlertAt, 'CRM badge');
      assert.equal(await f.FundingSignalModel.countDocuments({ leadId: quiet.id }), 0, 'a five-year-old grant is not news');
      const t = (await EmailThreadModel.findById(sig.threadId).lean()) as any;
      assert.equal(t.status, 'draft');
      assert.equal(t.draftType, 'grant_note');
      assert.match(t.draftBody, /Congratulations/);
      assert.equal(sent.length, 0, 'nothing is sent by itself');
    });

    await check('nobody marked do-not-contact gets a note — their signal is kept as skipped', async () => {
      const s = (await f.FundingSignalModel.findOne({ leadId: optout.id }).lean()) as any;
      assert.equal(s.status, 'skipped');
      assert.equal(s.reason, 'Asked not to be contacted');
    });

    await check('the note shows in Needs you even without an earlier conversation; sending it marks the signal sent', async () => {
      const sig = (await f.FundingSignalModel.findOne({ leadId: funded.id }).lean()) as any;
      if (needsYouQueue) {
        const q = await needsYouQueue();
        assert.ok(q.some((i) => i.threadId === sig.threadId && i.draft?.type === 'grant_note'));
      }
      const after = await approveAndSendOutreach(sig.threadId);
      assert.equal(sent.length, 1);
      assert.equal(after.followUp.nextCheckAt, undefined, 'no automatic follow-ups after it');
      assert.equal(((await f.FundingSignalModel.findById(sig._id).lean()) as any).status, 'sent');
    });

    await check('the CRM can list only people with new funding', async () => {
      const res = (await (await fetch(`${base}/leads?newFunding=1&limit=200`)).json()) as { items: Array<{ id: string }> };
      const ids = res.items.map((l) => l.id);
      assert.ok(ids.includes(funded.id));
      assert.ok(!ids.includes(quiet.id));
    });

    await check('a discarded note marks the signal dismissed', async () => {
      const other = await mk('Second Funded', 'https://openalex.org/A5000000005');
      grants.set('https://openalex.org/A5000000005', []);
      await f.FundingSignalModel.create({ leadId: other.id, key: 'dst:X/1', agency: 'dst', funder: 'DST', awardId: 'X/1', year, detectedAt: now, status: 'new' });
      await f.draftPendingNotes(now);
      const sig = (await f.FundingSignalModel.findOne({ leadId: other.id }).lean()) as any;
      await rejectDraft(sig.threadId);
      assert.equal(((await f.FundingSignalModel.findById(sig._id).lean()) as any).status, 'dismissed');
      assert.equal(await EmailThreadModel.countDocuments({ _id: sig.threadId }), 0, 'the empty conversation that only held the draft is removed');
    });
  } finally {
    f.setFundingSeams({ fetcher: null, writer: null });
    setEmailTransport(null);
    const leads = await LeadModel.find({ 'person.email': { $in: emails } }, { _id: 1 }).lean();
    await f.FundingSignalModel.deleteMany({ leadId: { $in: leads.map((l) => String(l._id)) } });
    await EmailThreadModel.deleteMany({ leadEmailSnapshot: { $in: emails } });
    await LeadModel.deleteMany({ 'person.email': { $in: emails } });
    await SystemStateModel.deleteOne({ key: 'fundingAlertsBaseline' });
  }
}
