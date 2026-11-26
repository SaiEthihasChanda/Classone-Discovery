/**
 * Incoming-mail tests (services/email/inboxPoller.ts + inboundTriage.ts) — run
 * from the smoke test. Gmail is a fake InboxSource and the AI a stub that
 * answers from the mail's subject, so this checks the app's own rules: which
 * lead and conversation a mail lands on, what each kind of mail does, that a
 * mail is handled once, that a failed AI call is retried, that follow-ups stop
 * once they've replied, and that our answer is threaded under their mail.
 */
import assert from 'node:assert/strict';

type Check = (name: string, fn: () => Promise<void> | void) => Promise<void>;

export async function runInboxTests(check: Check): Promise<void> {
  const { pollInbox, stripQuoted } = await import('../services/email/inboxPoller.js');
  const { setTriageFn } = await import('../services/email/inboundTriage.js');
  const { InboundEmailModel } = await import('../models/inboundEmail.model.js');
  const { repositories } = await import('../repositories/index.js');
  const { approveAndSendOutreach, rejectDraft } = await import('../services/email/outreachService.js');
  const { setEmailTransport } = await import('../services/email/transports/index.js');
  const { runFollowUpCheck } = await import('../services/email/followUpScheduler.js');
  const { normalizeNameKey } = await import('../utils/normalize.js');

  console.log('\nIncoming mail:\n');

  // The stub AI: the subject names the intent ("[quote_request] …"); every intent but the no-reply ones gets a draft.
  let aiDown = false;
  setTriageFn(async (mail) => {
    if (aiDown) throw new Error('Gemini 429 Too Many Requests (test): quota');
    const intent = (/\[(\w+)\]/.exec(mail.subject)?.[1] ?? 'other') as never;
    const noReply = intent === ('unsubscribe' as never) || intent === ('out_of_office' as never);
    return {
      intent,
      summary: `about ${mail.subject}`,
      urgency: 'normal',
      productIds: [],
      contact: { name: 'Priya Stranger', institution: 'NIT Test', title: 'Assistant Professor' },
      shouldReply: !noReply,
      replyBody: noReply ? undefined : `Thanks for your mail about ${mail.subject}.\n\nTeam Class One Systems`,
      outOfOfficeUntil: intent === ('out_of_office' as never) ? new Date(Date.now() + 3 * 86_400_000) : undefined,
      model: 'stub',
    };
  });

  // A fake inbox: mails are added per test; get() returns them by id.
  const box = new Map<string, Parameters<typeof pollInbox>[0] extends { get(id: string): Promise<infer M> } ? NonNullable<M> : never>();
  const source = { listRecentIds: async () => [...box.keys()].reverse(), get: async (id: string) => box.get(id) ?? null };
  let n = 0;
  const mail = (from: string, subject: string, extra: Record<string, unknown> = {}) => {
    n += 1;
    const m = { gmailId: `g${n}-${Date.now()}`, from, subject, bodyText: `Body of ${subject}`, receivedAt: new Date(), rfcMessageId: `<in${n}@test>`, ...extra };
    box.set(m.gmailId, m as never);
    return m;
  };

  const lead = await repositories.leads.create({
    status: 'approved',
    source: { type: 'manual', discoveredAt: new Date() },
    person: { name: 'Inbox Test Lead', normalizedNameKey: normalizeNameKey('Inbox Test Lead'), email: 'Lead.Person@Example.org' },
    institution: { name: 'IIT Test' },
    research: { topics: [], recentPublications: [], recentGrants: [], instruments: [] },
    aiScoring: { recommendedProductIds: [] },
    review: {},
    followUpStatusSummary: 'not_started',
    tags: ['test'],
  });

  const sent: Array<{ to: string; subject: string; threadId?: string; inReplyToMessageId?: string }> = [];
  setEmailTransport({
    name: 'gmail',
    send: async (m) => {
      sent.push(m);
      return { providerMessageId: `out-${sent.length}`, threadId: m.threadId ?? `gthread-new-${sent.length}`, rfcMessageId: `<out${sent.length}@test>` };
    },
  });

  try {
    await check('quoted history is cut from a reply, keeping only what they wrote', () => {
      const text = 'Yes please send a quote.\n\nRegards\nPriya\n\nOn Mon, 24 Nov 2026 at 10:00, Team <x@y.com>\nwrote:\n> earlier text\n> more';
      assert.equal(stripQuoted(text), 'Yes please send a quote.\n\nRegards\nPriya');
    });

    await check('a mail from a known lead (any letter case) lands on that lead, with a reply drafted for approval', async () => {
      const m = mail('lead.person@example.org', '[product_enquiry] Which potentiostat for EIS?', { gmailThreadId: 'gt-enquiry' });
      assert.deepEqual(await pollInbox(source), { processed: 1, failed: 0 });
      const rec = (await InboundEmailModel.findOne({ gmailId: m.gmailId }).lean()) as any;
      assert.equal(rec.leadId, lead.id);
      assert.equal(rec.matchedBy, 'email');
      assert.equal(rec.intent, 'product_enquiry');
      const thread = (await repositories.threads.findById(rec.threadId))!;
      assert.equal(thread.status, 'draft');
      assert.equal(thread.draftType, 'response');
      assert.equal(thread.draftSubject, 'Re: [product_enquiry] Which potentiostat for EIS?');
      assert.equal(thread.messages[0]!.direction, 'inbound');
      assert.equal(thread.followUp.replyDetected, true);
      assert.equal(sent.length, 0, 'nothing is sent without approval');
    });

    await check('the same mail is never handled twice', async () => {
      assert.deepEqual(await pollInbox(source), { processed: 0, failed: 0 });
    });

    await check('approving the reply sends it threaded under their mail; the conversation re-opens for a later follow-up', async () => {
      const rec = (await InboundEmailModel.findOne({ intent: 'product_enquiry' }).lean()) as any;
      await approveAndSendOutreach(rec.threadId);
      const out = sent.at(-1)!;
      assert.equal(out.to.toLowerCase(), 'lead.person@example.org');
      assert.equal(out.threadId, 'gt-enquiry', 'same Gmail conversation');
      assert.equal(out.inReplyToMessageId, rec.rfcMessageId, 'In-Reply-To their mail');
      const thread = (await repositories.threads.findById(rec.threadId))!;
      assert.equal(thread.status, 'open');
      assert.equal(thread.followUp.attemptsSent, 0);
      assert.ok(thread.followUp.nextCheckAt);
    });

    await check('a reply on our Gmail conversation is matched by the conversation, and replaces a waiting follow-up draft', async () => {
      const rec = (await InboundEmailModel.findOne({ intent: 'product_enquiry' }).lean()) as any;
      // A follow-up draft was waiting when they wrote back.
      await repositories.threads.updateById(rec.threadId, { status: 'draft', draftType: 'follow_up_1', draftSubject: 'Re: x', draftBody: 'Just following up', draftCreatedAt: new Date() });
      const m = mail('someone-else@forwarded.org', '[quote_request] Price for 2 units', { gmailThreadId: 'gt-enquiry' });
      await pollInbox(source);
      const r = (await InboundEmailModel.findOne({ gmailId: m.gmailId }).lean()) as any;
      assert.equal(r.matchedBy, 'thread');
      assert.equal(r.threadId, rec.threadId);
      const thread = (await repositories.threads.findById(rec.threadId))!;
      assert.equal(thread.draftType, 'response', 'the follow-up gave way to answering them');
      assert.equal(thread.draftIntent, 'quote_request');
    });

    await check('discarding a reply draft leaves them as "replied" — never chased by follow-ups', async () => {
      const rec = (await InboundEmailModel.findOne({ intent: 'quote_request' }).lean()) as any;
      await rejectDraft(rec.threadId);
      const thread = (await repositories.threads.findById(rec.threadId))!;
      assert.equal(thread.status, 'replied');
      await repositories.threads.updateById(thread.id, { followUp: { nextCheckAt: new Date(Date.now() - 1000) } });
      const before = (await repositories.threads.findById(thread.id))!.draftBody;
      await runFollowUpCheck();
      assert.equal((await repositories.threads.findById(thread.id))!.draftBody, before, 'no follow-up drafted');
    });

    await check('a mail from an unknown sender creates a lead (To review, tagged inbound-enquiry) from the signature', async () => {
      const m = mail('priya@nit-test.ac.in', '[meeting_request] Demo next week?', { fromName: 'Priya S', gmailThreadId: 'gt-new' });
      await pollInbox(source);
      const r = (await InboundEmailModel.findOne({ gmailId: m.gmailId }).lean()) as any;
      assert.equal(r.matchedBy, 'new_lead');
      const created = (await repositories.leads.findById(r.leadId))!;
      assert.equal(created.status, 'pending_review');
      assert.equal(created.source.type, 'inbound_email');
      assert.ok(created.tags.includes('inbound-enquiry'));
      assert.equal(created.person.name, 'Priya Stranger');
      assert.equal(created.institution.name, 'NIT Test');
      assert.equal((await repositories.threads.findById(r.threadId))!.draftType, 'response');
    });

    await check('service mail is ignored; a stranger who is not asking for anything becomes a contact, not a lead', async () => {
      const leadsBefore = await repositories.leads.count([]);
      const bulk = mail('team@newsletter.example', '[product_enquiry] Our new webinar', { bulk: true });
      const noreply = mail('payments-noreply@google.com', '[other] Update your tax info');
      const chatter = mail('random@stranger.org', '[other] Catching up after the conference', { fromName: 'Ravi K', gmailThreadId: 'gt-chatter' });
      await pollInbox(source);
      for (const m of [bulk, noreply]) assert.equal(((await InboundEmailModel.findOne({ gmailId: m.gmailId }).lean()) as any).status, 'ignored');
      const c = (await InboundEmailModel.findOne({ gmailId: chatter.gmailId }).lean()) as any;
      assert.equal(c.status, 'processed');
      assert.equal(c.matchedBy, 'contact');
      assert.equal(await repositories.leads.count([]), leadsBefore, 'no lead created');
      const t = (await repositories.threads.findById(c.threadId))!;
      assert.equal(t.leadId, undefined);
      assert.equal(t.contactEmail, 'random@stranger.org');
    });

    await check('Conversations: people with unread / needs-reply / draft counts; opening marks read; a typed reply is sent threaded', async () => {
      const conv = await import('../services/email/conversationService.js');
      const people = await conv.listPeople('all');
      const ravi = people.find((p) => p.email === 'random@stranger.org')!;
      assert.ok(ravi, 'a contact shows as a person');
      assert.equal(ravi.leadId, undefined);
      assert.equal(ravi.unread, 1);
      assert.equal(ravi.drafts, 1, 'the AI drafted a reply');
      assert.ok((await conv.listPeople('new')).some((p) => p.email === ravi.email));
      assert.ok(!(await conv.listPeople('leads')).some((p) => p.email === ravi.email));

      const detail = await conv.personDetail('random@stranger.org');
      const thread = detail.threads[0]!;
      await conv.markThreadRead(thread.id);
      assert.equal((await conv.listPeople('unread')).some((p) => p.email === ravi.email), false, 'read now');

      const before = sent.length;
      await conv.replyOnThread(thread.id, 'Great to hear from you, Ravi.', 'rep@classone.test');
      const out = sent.at(-1)!;
      assert.equal(sent.length, before + 1);
      assert.equal(out.to, 'random@stranger.org');
      assert.equal(out.threadId, 'gt-chatter');
      assert.match(out.subject, /^Re: /);
      const after = (await repositories.threads.findById(thread.id))!;
      assert.equal(after.draftBody, undefined, 'the waiting AI draft is cleared by a typed reply');
      assert.equal(after.messages.at(-1)!.sentBy, 'rep@classone.test');
      const p = (await conv.listPeople('all')).find((x) => x.email === ravi.email)!;
      assert.deepEqual([p.needsReply, p.drafts], [0, 0]);
    });

    await check('Draft with AI returns text without saving or sending', async () => {
      const conv = await import('../services/email/conversationService.js');
      const m = mail('random@stranger.org', '[product_enquiry] Do you stock Ag/AgCl electrodes?', { gmailThreadId: 'gt-chatter' });
      await pollInbox(source);
      const t = (await InboundEmailModel.findOne({ gmailId: m.gmailId }).lean()) as any;
      await rejectDraft(t.threadId);
      const before = sent.length;
      const d = await conv.aiDraftForThread(t.threadId);
      assert.match(d.body, /Ag\/AgCl/);
      assert.equal(sent.length, before, 'not sent');
      assert.equal((await repositories.threads.findById(t.threadId))!.draftBody, undefined, 'not saved');
    });

    await check('mail written in Gmail itself shows on the person’s conversation as ours, and clears their waiting draft', async () => {
      const t0 = (await InboundEmailModel.findOne({ intent: 'meeting_request' }).lean()) as any;
      assert.equal((await repositories.threads.findById(t0.threadId))!.status, 'draft');
      const { env } = await import('../config/env.js');
      const s = mail(env.EMAIL_FROM_ADDRESS, 'Re: [meeting_request] Demo next week?', { gmailThreadId: 'gt-new', to: 'priya@nit-test.ac.in', bodyText: 'Tuesday 3pm works.' });
      await pollInbox(source);
      const rec = (await InboundEmailModel.findOne({ gmailId: s.gmailId }).lean()) as any;
      assert.equal(rec.direction, 'outbound');
      assert.equal(rec.matchedBy, 'sent');
      const t = (await repositories.threads.findById(t0.threadId))!;
      assert.equal(t.messages.at(-1)!.direction, 'outbound');
      assert.equal(t.messages.at(-1)!.bodyText, 'Tuesday 3pm works.');
      assert.equal(t.status, 'open');
      assert.equal(t.draftBody, undefined);
    });

    await check('a new message to someone new creates their conversation; Add to CRM turns them into a lead', async () => {
      const conv = await import('../services/email/conversationService.js');
      const before = sent.length;
      const t = await conv.composeMessage({ to: 'New.Person@Uni.edu', subject: 'Hello', body: 'Nice meeting you.', sentBy: 'rep@classone.test' });
      assert.equal(sent.length, before + 1);
      assert.equal(t.contactEmail, 'new.person@uni.edu');
      assert.ok((await conv.listPeople('new')).some((p) => p.email === 'new.person@uni.edu'));
      const lead = await conv.personToLead('new.person@uni.edu');
      assert.equal(lead.status, 'pending_review');
      assert.equal((await repositories.threads.findById(t.id))!.leadId, lead.id);
      assert.ok((await conv.listPeople('leads')).some((p) => p.email === 'new.person@uni.edu'));
    });

    await check('an unsubscribe marks the lead do-not-contact, drafts nothing, and blocks further outreach', async () => {
      const m = mail('lead.person@example.org', '[unsubscribe] Please remove me', { gmailThreadId: 'gt-unsub' });
      await pollInbox(source);
      const r = (await InboundEmailModel.findOne({ gmailId: m.gmailId }).lean()) as any;
      const after = (await repositories.leads.findById(lead.id))!;
      assert.equal(after.doNotContact, true);
      const thread = (await repositories.threads.findById(r.threadId))!;
      assert.equal(thread.status, 'closed');
      assert.equal(thread.draftBody, undefined);
      const { draftOutreachForLead } = await import('../services/email/outreachService.js');
      await assert.rejects(() => draftOutreachForLead(lead.id), /asked not to be emailed/);
      await repositories.leads.updateById(lead.id, {}, { unset: ['doNotContact'] });
    });

    await check('an out-of-office reply drafts nothing and moves the next follow-up past their return', async () => {
      const m = mail('lead.person@example.org', '[out_of_office] Away until Friday', { gmailThreadId: 'gt-ooo' });
      await pollInbox(source);
      const r = (await InboundEmailModel.findOne({ gmailId: m.gmailId }).lean()) as any;
      const thread = (await repositories.threads.findById(r.threadId))!;
      assert.equal(thread.draftBody, undefined);
      assert.ok(new Date(thread.followUp.nextCheckAt!).getTime() > Date.now() + 3 * 86_400_000, 'after the return date');
    });

    await check('our own mail and bounces are ignored; a bounce closes the conversation', async () => {
      const { env } = await import('../config/env.js');
      const t = await repositories.threads.create({ leadId: lead.id, leadEmailSnapshot: 'x@y.z', subjectLine: 's', status: 'open', provider: 'gmail', providerThreadId: 'gt-bounce', messages: [], followUp: { attemptsSent: 0, maxAttempts: 2, replyDetected: false } });
      const own = mail(env.EMAIL_FROM_ADDRESS, 'our own');
      const bounce = mail('mailer-daemon@googlemail.com', 'Delivery Status Notification (Failure)', { gmailThreadId: 'gt-bounce' });
      assert.deepEqual(await pollInbox(source), { processed: 2, failed: 0 });
      assert.equal((await repositories.threads.findById(t.id))!.closedReason, 'bounced');
      assert.equal(await InboundEmailModel.countDocuments({ gmailId: { $in: [own.gmailId, bounce.gmailId] }, status: 'ignored' }), 2);
    });

    await check('when the AI cannot read a mail it is kept as failed and retried on the next poll', async () => {
      aiDown = true;
      const m = mail('lead.person@example.org', '[support_request] Error 42 on my EmStat');
      assert.deepEqual(await pollInbox(source), { processed: 0, failed: 1 });
      let r = (await InboundEmailModel.findOne({ gmailId: m.gmailId }).lean()) as any;
      assert.equal(r.status, 'failed');
      assert.match(r.error, /429/);
      assert.equal(r.attempts, 1);
      aiDown = false;
      assert.deepEqual(await pollInbox(source), { processed: 1, failed: 0 });
      r = (await InboundEmailModel.findOne({ gmailId: m.gmailId }).lean()) as any;
      assert.equal(r.status, 'processed');
      assert.equal(r.intent, 'support_request');
    });
  } finally {
    setTriageFn(null);
    setEmailTransport(null);
  }
}
