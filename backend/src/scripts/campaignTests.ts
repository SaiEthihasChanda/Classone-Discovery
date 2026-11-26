/**
 * Campaign tests (services/campaigns) — run from the smoke test, with a fake mail transport.
 * Checks rendering (personalisation, inline images), who the audience leaves out, the queue
 * (pace, daily cap, pause, finishing), skipping someone who unsubscribed mid-campaign, and that
 * a reply to a campaign mail lands in that person's conversation.
 */
import assert from 'node:assert/strict';

type Check = (name: string, fn: () => Promise<void> | void) => Promise<void>;

export async function runCampaignTests(check: Check): Promise<void> {
  const svc = await import('../services/campaigns/campaignService.js');
  const { personalise, renderCampaign } = await import('../services/campaigns/campaignRender.js');
  const { CampaignRecipientModel } = await import('../models/campaign.model.js');
  const { repositories } = await import('../repositories/index.js');
  const { setEmailTransport } = await import('../services/email/transports/index.js');
  const { normalizeNameKey } = await import('../utils/normalize.js');
  const { env } = await import('../config/env.js');

  console.log('\nCampaigns:\n');

  const sent: Array<{ to: string; subject: string; html?: string; attachments?: unknown[]; listUnsubscribe?: string; threadId?: string }> = [];
  setEmailTransport({
    name: 'gmail',
    send: async (m) => {
      sent.push(m);
      return { providerMessageId: `camp-${sent.length}`, threadId: `camp-thread-${sent.length}`, rfcMessageId: `<camp${sent.length}@test>` };
    },
  });

  const mkLead = (name: string, email: string | undefined, extra: Record<string, unknown> = {}) =>
    repositories.leads.create({
      status: 'approved',
      source: { type: 'manual', discoveredAt: new Date() },
      person: { name, normalizedNameKey: normalizeNameKey(name), ...(email ? { email } : {}) },
      institution: { name: 'Campaign Test Institute', department: 'Chemistry' },
      research: { topics: [], recentPublications: [], recentGrants: [], instruments: [] },
      aiScoring: { relevanceScore: 70, recommendedProductIds: [] },
      review: {},
      followUpStatusSummary: 'not_started',
      tags: ['campaign-test'],
      ...extra,
    } as never);

  try {
    await check('fields are filled per person, with fallbacks', () => {
      assert.equal(personalise('Dear {title|Dr.} {last_name}, at {institute}', { name: 'Dr. Asha Verma', institute: 'IIT X' }), 'Dear Dr. Verma, at IIT X');
      assert.equal(personalise('Hi {first_name|there}', {}), 'Hi there');
      assert.equal(personalise('Keep {unknown}', {}), 'Keep {unknown}');
    });

    await check('an image block becomes an inline (cid:) attachment in the email, and a data URL in the preview', async () => {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      const asset = await svc.saveAsset({ filename: 'poster.png', contentType: 'image/png', data: png.toString('base64') });
      const blocks = [{ id: 'i', type: 'image' as const, assetId: asset.id, alt: 'Poster' }, { id: 't', type: 'text' as const, text: 'Hello {first_name}' }];
      const ctxAssets = new Map([[asset.id, { id: asset.id, filename: 'poster.png', contentType: 'image/png', data: png }]]);
      const email = renderCampaign({ subject: 'S', blocks }, { name: 'Asha Verma' }, { assets: ctxAssets, products: new Map(), mode: 'email' });
      assert.match(email.html, new RegExp(`src="cid:img-${asset.id}@classone"`));
      assert.equal(email.attachments.length, 1);
      assert.match(email.html, /Hello Asha/);
      assert.match(email.text, /unsubscribe/);
      const preview = await svc.previewCampaign({ subject: 'S', blocks });
      assert.match(preview.html, /src="data:image\/png;base64,/);
    });

    await mkLead('Asha Verma', 'asha@campaign.test');
    await mkLead('Ben Roy', 'ben@campaign.test');
    await mkLead('No Email', undefined);
    await mkLead('Said No', 'said.no@campaign.test', { doNotContact: true });
    await mkLead('Rejected Person', 'rejected@campaign.test', { status: 'rejected' });
    await mkLead('Still Filling', 'filling@campaign.test', { inPipeline: true });
    const audience = { tags: ['campaign-test'] };

    await check('the audience leaves out no-email, do-not-contact, rejected and still-on-the-conveyor leads', async () => {
      const p = await svc.previewAudience(audience);
      assert.equal(p.count, 2);
      assert.deepEqual(p.sample.map((s) => s.email).sort(), ['asha@campaign.test', 'ben@campaign.test']);
    });

    let sentTo = '';
    const c = await svc.createCampaign({ name: 'Test campaign', createdBy: 'rep@classone.test' });
    await svc.updateCampaign(c.id, { subject: 'News for {first_name}', audience, paceSeconds: 30, blocks: [{ id: 't', type: 'text', text: 'Hello {first_name}' }] });

    await check('starting queues the audience; one email per tick, each waiting its pace; then done', async () => {
      await svc.startCampaign(c.id);
      assert.equal(await CampaignRecipientModel.countDocuments({ campaignId: c.id, status: 'queued' }), 2);
      const t0 = new Date();
      assert.equal(await svc.campaignTick(t0), 'sent');
      assert.equal(await svc.campaignTick(new Date(t0.getTime() + 5_000)), 'idle', 'pace: not yet');
      // Whoever is still waiting unsubscribes before their turn: skipped, not sent.
      const waiting = (await CampaignRecipientModel.findOne({ campaignId: c.id, status: 'queued' }).lean())!;
      const first = waiting.email === 'ben@campaign.test' ? 'asha@campaign.test' : 'ben@campaign.test';
      await repositories.leads.updateById(waiting.leadId!, { doNotContact: true });
      assert.equal(await svc.campaignTick(new Date(t0.getTime() + 31_000)), 'sent');
      assert.equal(await svc.campaignTick(new Date(t0.getTime() + 62_000)), 'idle');
      assert.equal((await svc.getCampaign(c.id)).status, 'done');
      const rows = await svc.campaignRecipients(c.id);
      const byEmail = new Map(rows.map((r) => [r.email, r]));
      assert.equal(byEmail.get(first)!.status, 'sent');
      assert.equal(byEmail.get(waiting.email)!.status, 'skipped');
      const mail = sent.find((m) => m.to === first)!;
      assert.equal(mail.subject, first.startsWith('asha') ? 'News for Asha' : 'News for Ben');
      assert.match(mail.listUnsubscribe!, /^<mailto:/);
      const thread = (await repositories.threads.findById(byEmail.get(first)!.threadId!))!;
      assert.equal(thread.messages[0]!.type, 'campaign');
      assert.equal(thread.followUp.nextCheckAt, undefined, 'campaign mails get no automatic follow-up');
      await repositories.leads.updateById(waiting.leadId!, {}, { unset: ['doNotContact'] });
      sentTo = first;
    });

    await check('a reply to a campaign mail lands in that person’s conversation', async () => {
      const { pollInbox } = await import('../services/email/inboxPoller.js');
      const { setTriageFn } = await import('../services/email/inboundTriage.js');
      setTriageFn(async () => ({ intent: 'product_enquiry', summary: 'interested', urgency: 'normal', productIds: [], contact: {}, shouldReply: true, replyBody: 'Thanks', model: 'stub' }));
      const row = (await svc.campaignRecipients(c.id)).find((r) => r.email === sentTo)!;
      const thread = (await repositories.threads.findById(row.threadId!))!;
      const reply = { gmailId: `camp-reply-${Date.now()}`, gmailThreadId: thread.providerThreadId, from: sentTo, subject: 'Re: News', bodyText: 'Tell me more', receivedAt: new Date() };
      await pollInbox({ listRecentIds: async () => [reply.gmailId], get: async () => reply });
      setTriageFn(null);
      const after = (await repositories.threads.findById(thread.id))!;
      assert.equal(after.messages.at(-1)!.direction, 'inbound');
      const list = await svc.listCampaigns();
      assert.equal(list.find((x) => x.id === c.id)!.stats.replied, 1);
    });

    await check('pause holds the queue; the daily cap stops all sending until tomorrow', async () => {
      const c2 = await svc.createCampaign({ name: 'Second' });
      await svc.updateCampaign(c2.id, { subject: 'Again', audience, paceSeconds: 10 });
      await svc.startCampaign(c2.id);
      await svc.pauseCampaign(c2.id);
      const before = sent.length;
      assert.equal(await svc.campaignTick(new Date(Date.now() + 120_000)), 'idle');
      assert.equal(sent.length, before);
      await svc.startCampaign(c2.id);
      // Pretend the cap is already used up today.
      const cap = env.CAMPAIGN_DAILY_CAP;
      (env as { CAMPAIGN_DAILY_CAP: number }).CAMPAIGN_DAILY_CAP = 1;
      assert.equal(await svc.campaignTick(new Date(Date.now() + 240_000)), 'capped');
      (env as { CAMPAIGN_DAILY_CAP: number }).CAMPAIGN_DAILY_CAP = cap;
      await svc.cancelCampaign(c2.id);
      assert.equal(await CampaignRecipientModel.countDocuments({ campaignId: c2.id, status: 'queued' }), 0);
    });
  } finally {
    setEmailTransport(null);
  }
}
