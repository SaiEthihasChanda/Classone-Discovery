/**
 * Tests for automatic follow-ups, the website catalog watcher and new-product launches — run
 * from the smoke test with a fake website, stubbed AI and a fake mail transport.
 */
import assert from 'node:assert/strict';

type Check = (name: string, fn: () => Promise<void> | void) => Promise<void>;

export async function runLaunchTests(check: Check): Promise<void> {
  const fu = await import('../services/email/followUpScheduler.js');
  const watcher = await import('../services/catalog/catalogWatcher.js');
  const launch = await import('../services/campaigns/productLaunch.js');
  const { inSendWindow, nextSendWindow } = await import('../utils/sendWindow.js');
  const { setEmailTransport } = await import('../services/email/transports/index.js');
  const { setTriageFn } = await import('../services/email/inboundTriage.js');
  const { repositories } = await import('../repositories/index.js');
  const { ProductModel } = await import('../models/productCatalog.model.js');
  const { CampaignModel, CampaignRecipientModel } = await import('../models/campaign.model.js');
  const { ContactModel } = await import('../models/contact.model.js');
  const { EmailThreadModel } = await import('../models/emailThread.model.js');
  const { setState } = await import('../models/systemState.model.js');
  const { buildKeywordGroups } = await import('../services/discovery/keywords.js');
  const { normalizeNameKey } = await import('../utils/normalize.js');

  console.log('\nAuto follow-ups, website catalog & product launches:\n');

  const sent: Array<{ to: string; subject: string; text: string; internal?: boolean }> = [];
  setEmailTransport({ name: 'gmail', send: async (m) => (sent.push(m as never), { providerMessageId: `l-${sent.length}`, threadId: m.threadId ?? `lt-${sent.length}`, rfcMessageId: `<l${sent.length}@t>` }) });
  // Outreach drafting calls Gemini: stub it through the triage seam's sibling — draftOutreachEmail is used, so give the lead a draft directly instead.
  const IST = 330 * 60_000;
  const istAt = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi) - IST);

  const mkLead = (name: string, email: string, extra: Record<string, unknown> = {}) =>
    repositories.leads.create({
      status: 'approved',
      source: { type: 'manual', discoveredAt: new Date() },
      person: { name, normalizedNameKey: normalizeNameKey(name), email },
      institution: { name: 'Launch Test Institute' },
      research: { topics: [], recentPublications: [], recentGrants: [], instruments: [], summary: '' },
      aiScoring: { relevanceScore: 60, recommendedProductIds: [] },
      review: {},
      followUpStatusSummary: 'not_started',
      tags: ['launch-test'],
      ...extra,
    } as never);

  try {
    await check('the send window is Mon–Sat 09:00–18:00 IST, and the next opening skips Sunday', () => {
      assert.equal(inSendWindow(istAt(2026, 11, 27, 10)), true, 'Friday 10:00');
      assert.equal(inSendWindow(istAt(2026, 11, 27, 18, 30)), false, 'Friday 18:30');
      assert.equal(inSendWindow(istAt(2026, 11, 29, 11)), false, 'Sunday');
      assert.equal(nextSendWindow(istAt(2026, 11, 28, 19)).getTime(), istAt(2026, 11, 30, 9).getTime(), 'Saturday evening → Monday 09:00');
      assert.equal(nextSendWindow(istAt(2026, 11, 27, 7)).getTime(), istAt(2026, 11, 27, 9).getTime(), 'early → same day 09:00');
    });

    // A lead with a follow-up draft waiting (as the follow-up check would leave it).
    const lead = await mkLead('Follow Person', 'follow.person@uni.test');
    const thread = await repositories.threads.create({
      leadId: lead.id,
      contactEmail: 'follow.person@uni.test',
      leadEmailSnapshot: 'follow.person@uni.test',
      subjectLine: 'Instruments for your lab',
      status: 'draft',
      provider: 'gmail',
      providerThreadId: 'ft-1',
      messages: [{ messageId: 'm0', direction: 'outbound', type: 'initial_outreach', subject: 'Instruments for your lab', bodyText: 'Hello', sentAt: new Date(Date.now() - 7 * 86_400_000), rfcMessageId: '<m0@t>' }],
      followUp: { attemptsSent: 0, maxAttempts: 2, replyDetected: false },
      draftType: 'follow_up_1',
      draftSubject: 'Re: Instruments for your lab',
      draftBody: 'Just a short note following up.',
      draftCreatedAt: new Date(),
    });
    const friday = istAt(2026, 11, 27, 11);

    await check('Manual mode: a follow-up draft waits; nothing is sent', async () => {
      await fu.setFollowUpMode('manual');
      const r = await fu.runFollowUpCheck(friday);
      assert.equal(r.sent, 0);
      assert.equal((await repositories.threads.findById(thread.id))!.status, 'draft');
    });

    await check('a "Never auto" person is skipped even when follow-ups are Auto; outside the window nothing goes', async () => {
      await fu.setFollowUpMode('auto');
      await ContactModel.updateOne({ email: 'follow.person@uni.test' }, { $set: { followUpMode: 'manual' } }, { upsert: true });
      assert.equal((await fu.runFollowUpCheck(friday)).sent, 0);
      await ContactModel.updateOne({ email: 'follow.person@uni.test' }, { $unset: { followUpMode: '' } });
      assert.equal((await fu.runFollowUpCheck(istAt(2026, 11, 29, 11))).sent, 0, 'Sunday: waits');
    });

    await check('Auto mode inside the window: the follow-up is sent, counted, and the team is told', async () => {
      const before = sent.length;
      const r = await fu.runFollowUpCheck(friday);
      assert.equal(r.sent, 1);
      const toThem = sent.slice(before).find((m) => m.to === 'follow.person@uni.test')!;
      assert.match(toThem.text, /following up/);
      assert.ok(sent.slice(before).some((m) => m.internal && /Follow-up sent to Follow Person/.test(m.subject)), 'team emailed');
      const t = (await repositories.threads.findById(thread.id))!;
      assert.equal(t.followUp.attemptsSent, 1);
      assert.equal(t.messages.at(-1)!.sentBy, 'auto-followup');
      await fu.setFollowUpMode('manual');
    });

    await check('a "do not contact" person is never followed up automatically', async () => {
      await fu.setFollowUpMode('auto');
      const l2 = await mkLead('Quiet Person', 'quiet.person@uni.test', { doNotContact: true });
      await repositories.threads.create({ leadId: l2.id, contactEmail: 'quiet.person@uni.test', leadEmailSnapshot: 'quiet.person@uni.test', subjectLine: 'x', status: 'draft', provider: 'gmail', messages: [{ messageId: 'q0', direction: 'outbound', type: 'initial_outreach', subject: 'x', bodyText: 'x', sentAt: new Date() }], followUp: { attemptsSent: 0, maxAttempts: 2, replyDetected: false }, draftType: 'follow_up_1', draftSubject: 'Re: x', draftBody: 'y', draftCreatedAt: new Date() });
      const before = sent.length;
      await fu.runFollowUpCheck(friday);
      assert.equal(sent.slice(before).some((m) => m.to === 'quiet.person@uni.test'), false);
      await fu.setFollowUpMode('manual');
    });

    // --- Website catalog --------------------------------------------------------------------------------------
    const site = [
      { slug: 'launch-test-existing', title: 'Existing Thing', group: 'sensing', category: 'x', tags: [], images: [] as string[] },
    ];
    watcher.setCatalogWatcherDeps({
      source: { list: async () => site },
      classifier: async (p) => ({ category: 'battery_equipment', applicationAreas: p.title.includes('Cycler') ? ['sodium-ion batteries', 'battery cycling'] : ['general'], keywords: ['coin cell cycling'], sdkSupport: [] }),
    });
    await setState('websiteCatalogBaseline', null);
    await setState('websiteKnownSlugs', null);

    await check('the first run records what the website has — no launches', async () => {
      const { ProductLaunchModel } = watcher;
      const before = await ProductLaunchModel.countDocuments();
      const r = await watcher.syncWebsiteCatalog();
      assert.equal(r.firstRun, true);
      assert.equal(await ProductLaunchModel.countDocuments(), before);
      assert.ok(await ProductModel.exists({ productId: 'launch-test-existing' }));
    });

    await check('a new product: classified by the AI, added to the catalog and discovery keywords, and a launch recorded', async () => {
      site.push({ slug: 'launch-test-cycler', title: 'Launch Test Cycler', group: 'energy', category: 'battery', tags: [], images: [] });
      const r = await watcher.syncWebsiteCatalog();
      assert.deepEqual(r.added, ['Launch Test Cycler']);
      const p = (await ProductModel.findOne({ productId: 'launch-test-cycler' }).lean())!;
      assert.equal(p.aiDerived, true);
      assert.deepEqual(p.applicationAreas, ['sodium-ion batteries', 'battery cycling']);
      assert.ok(await watcher.ProductLaunchModel.exists({ productId: 'launch-test-cycler', status: 'pending' }));
      const areas = buildKeywordGroups().find((g) => g.key === 'application_areas')!.phrases;
      assert.ok(areas.includes('sodium-ion batteries'), 'discovery searches the new area');
    });

    await check('a product taken off the website becomes inactive in the CRM', async () => {
      site.splice(0, 1);
      const r = await watcher.syncWebsiteCatalog();
      assert.ok(r.deactivated.includes('Existing Thing'));
      assert.equal((await ProductModel.findOne({ productId: 'launch-test-existing' }).lean())!.isActive, false);
    });

    // --- Launch ------------------------------------------------------------------------------------------------
    const match1 = await mkLead('Battery Bhatt', 'battery.bhatt@uni.test', { research: { topics: ['sodium-ion batteries'], recentPublications: [], recentGrants: [], instruments: [], applicationAreas: ['sodium-ion batteries'], summary: 'Sodium-ion cathodes' } });
    const match2 = await mkLead('Cell Chowdhury', 'cell.c@uni.test', { research: { topics: ['battery cycling'], recentPublications: [], recentGrants: [], instruments: [], summary: 'Coin cells' } });
    await mkLead('Bio Bose', 'bio.bose@uni.test', { research: { topics: ['protein folding'], recentPublications: [], recentGrants: [], instruments: [], summary: 'Proteins' } });
    await mkLead('Opted Out', 'opted.out@uni.test', { doNotContact: true, research: { topics: ['sodium-ion batteries'], recentPublications: [], recentGrants: [], instruments: [], summary: 'Batteries' } });
    let rated: string[] = [];
    launch.setLaunchAi({
      copy: async (p) => ({ subject: `Meet the ${p.name}`, preheader: 'New', heading: p.name, paragraphs: ['Dear {title|Dr.} {last_name|},', 'It cycles coin cells.'], buttonLabel: 'See the product' }),
      rate: async (_p, people) => {
        rated = rated.concat(people.map((c) => c.name));
        return new Map(people.map((c) => [c.id, c.name === 'Battery Bhatt' ? 92 : c.name === 'Cell Chowdhury' ? 55 : 30]));
      },
    });

    await check('Manual mode: the AI-written campaign waits as a draft for the matched, reachable people only; the team is told', async () => {
      await launch.setLaunchSettings({ mode: 'manual', minRelevance: 50, maxRecipients: 1 });
      const before = sent.length;
      assert.equal(await launch.processPendingLaunches(), 1);
      assert.ok(!rated.includes('Bio Bose'), 'unrelated research is not even rated');
      assert.ok(!rated.includes('Opted Out'), 'do-not-contact excluded');
      const l = (await watcher.ProductLaunchModel.findOne({ productId: 'launch-test-cycler' }).lean())!;
      assert.equal(l.status, 'ready');
      assert.equal(l.recipients, 1, 'capped at 1, best first');
      const c = (await CampaignModel.findById(l.campaignId).lean())!;
      assert.equal(c.status, 'draft');
      assert.equal(c.kind, 'product_launch');
      assert.deepEqual((c.audience as { leadIds: string[] }).leadIds, [match1.id]);
      assert.deepEqual((c.blocks as Array<{ type: string }>).map((b) => b.type), ['heading', 'text', 'product', 'button']);
      assert.ok(sent.slice(before).some((m) => m.internal && /New product: Launch Test Cycler/.test(m.subject)));
      assert.ok(match2);
    });

    await check('Auto mode: scheduled 24 h out, inside the send window, with its recipients queued', async () => {
      site.push({ slug: 'launch-test-cycler-2', title: 'Launch Test Cycler Two', group: 'energy', category: 'battery', tags: [], images: [] });
      await watcher.syncWebsiteCatalog();
      await launch.setLaunchSettings({ mode: 'auto', minRelevance: 50, maxRecipients: 200 });
      const at = istAt(2026, 11, 28, 15); // Saturday 15:00 → +24 h is Sunday → Monday 09:00
      assert.equal(await launch.processPendingLaunches(at), 1);
      const l = (await watcher.ProductLaunchModel.findOne({ productId: 'launch-test-cycler-2' }).lean())!;
      const c = (await CampaignModel.findById(l.campaignId).lean())!;
      assert.equal(c.status, 'scheduled');
      assert.equal(new Date(c.sendAt!).getTime(), istAt(2026, 11, 30, 9).getTime());
      assert.equal(await CampaignRecipientModel.countDocuments({ campaignId: l.campaignId, status: 'queued' }), 2);
      await launch.setLaunchSettings({ mode: 'manual' });
    });

    await check('a product taken off the website before its announcement goes out: the campaign is cancelled, the launch withdrawn', async () => {
      const l = (await watcher.ProductLaunchModel.findOne({ productId: 'launch-test-cycler-2' }).lean())!;
      const i = site.findIndex((p) => p.slug === 'launch-test-cycler-2');
      site.splice(i, 1);
      await watcher.syncWebsiteCatalog();
      assert.equal((await CampaignModel.findById(l.campaignId).lean())!.status, 'cancelled');
      assert.equal(await CampaignRecipientModel.countDocuments({ campaignId: l.campaignId, status: 'queued' }), 0);
      assert.equal((await watcher.ProductLaunchModel.findById(l._id).lean())!.status, 'withdrawn');
    });
  } finally {
    watcher.setCatalogWatcherDeps({ source: null, classifier: null });
    launch.setLaunchAi({ copy: null, rate: null });
    setTriageFn(null);
    setEmailTransport(null);
    await EmailThreadModel.deleteMany({ providerThreadId: 'ft-1' });
  }
}
