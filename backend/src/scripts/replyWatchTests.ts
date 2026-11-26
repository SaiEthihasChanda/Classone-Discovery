/**
 * Overdue digest and auto-reply tests (services/email/replyWatch.ts) — run from the smoke test,
 * with a fake mail transport, a fake inbox and stubbed AI.
 */
import assert from 'node:assert/strict';

type Check = (name: string, fn: () => Promise<void> | void) => Promise<void>;

export async function runReplyWatchTests(check: Check): Promise<void> {
  const watch = await import('../services/email/replyWatch.js');
  const conv = await import('../services/email/conversationService.js');
  const { pollInbox } = await import('../services/email/inboxPoller.js');
  const { setTriageFn } = await import('../services/email/inboundTriage.js');
  const { setEmailTransport } = await import('../services/email/transports/index.js');
  const { repositories } = await import('../repositories/index.js');
  const { EmailThreadModel } = await import('../models/emailThread.model.js');
  const { setState } = await import('../models/systemState.model.js');
  const { env } = await import('../config/env.js');

  console.log('\nOverdue replies & auto-reply:\n');

  const sent: Array<{ to: string; subject: string; text: string; html?: string; internal?: boolean; threadId?: string }> = [];
  setEmailTransport({ name: 'gmail', send: async (m) => (sent.push(m as never), { providerMessageId: `w-${sent.length}`, threadId: m.threadId ?? `wt-${sent.length}`, rfcMessageId: `<w${sent.length}@test>` }) });
  setTriageFn(async (mail) => ({ intent: (/\[(\w+)\]/.exec(mail.subject)?.[1] ?? 'product_enquiry') as never, summary: mail.subject, urgency: 'normal', productIds: [], contact: {}, shouldReply: true, replyBody: `Proper answer about ${mail.subject}`, model: 'stub' }));
  const HOUR = 3_600_000;
  const now = Date.now();
  let n = 0;
  const receive = async (from: string, subject: string, ageHours: number, gmailThreadId?: string) => {
    n += 1;
    const m = { gmailId: `rw-${n}-${now}`, gmailThreadId: gmailThreadId ?? `rwt-${n}`, from, subject, bodyText: `Body of ${subject}`, receivedAt: new Date(now - ageHours * HOUR), rfcMessageId: `<rw${n}@x>` };
    await pollInbox({ listRecentIds: async () => [m.gmailId], get: async () => m });
    const rec = (await EmailThreadModel.findOne({ providerThreadId: m.gmailThreadId }).lean())!;
    return String(rec._id);
  };

  try {
    await check('their message starts the waiting clock; a real reply stops it; an out-of-office does not start it', async () => {
      const t1 = await receive('wait.one@uni.test', 'Price for EmStat4S?', 1);
      assert.ok((await repositories.threads.findById(t1))!.awaitingReplySince);
      await conv.replyOnThread(t1, 'Here you go.');
      assert.equal((await repositories.threads.findById(t1))!.awaitingReplySince, undefined);
      const t2 = await receive('wait.two@uni.test', '[out_of_office] Away', 1);
      assert.equal((await repositories.threads.findById(t2))!.awaitingReplySince, undefined);
    });

    const overdueThread = await receive('late.person@uni.test', 'Need a quote for 3 units', 60);

    await check('Conversations counts it as overdue', async () => {
      const p = (await conv.listPeople('overdue')).find((x) => x.email === 'late.person@uni.test');
      assert.ok(p);
      assert.equal(p!.overdue, 1);
    });

    await check('the daily digest goes to the team once, with the AI draft and a signed Review & send link', async () => {
      await setState('overdueDigestDay', null);
      const before = sent.length;
      const at = new Date(now);
      const count = await watch.digestTick(at, true);
      assert.ok(count && count >= 1);
      const mails = sent.slice(before);
      assert.ok(mails.length >= 1 && mails.every((m) => m.internal), 'tagged as an internal note');
      const digest = mails[0]!;
      assert.match(digest.html!, /late\.person@uni\.test/);
      assert.match(digest.html!, /Proper answer about Need a quote for 3 units/);
      const link = /\/act\/send\?token=([^"&]+)/.exec(digest.html!)?.[1];
      assert.ok(link, 'has a send link');
      const token = decodeURIComponent(link!);
      const read = watch.readDraftToken(token);
      assert.ok(!('error' in read) && read.threadId === overdueThread);
      assert.equal(await watch.digestTick(new Date(now + 60_000)), null, 'not twice the same day');
      // A tampered token is refused.
      assert.ok('error' in watch.readDraftToken(token.slice(0, -2) + 'xx'));
    });

    await check('the team notice is never filed as a conversation by the inbox sync', async () => {
      const notice = { gmailId: `rw-notice-${now}`, gmailThreadId: `rw-notice-t-${now}`, from: env.EMAIL_FROM_ADDRESS, to: 'colleague@classone.test', subject: '1 person is waiting', bodyText: 'x', receivedAt: new Date(), internal: true };
      await pollInbox({ listRecentIds: async () => [notice.gmailId], get: async () => notice });
      assert.equal((await conv.listPeople('all')).some((p) => p.email === 'colleague@classone.test'), false);
    });

    await check('the send link sends that draft once; afterwards it stops working', async () => {
      const t = (await repositories.threads.findById(overdueThread))!;
      const token = watch.draftToken(t)!;
      const { approveAndSendOutreach } = await import('../services/email/outreachService.js');
      // What POST /public/drafts/:token/send does after checking the token against the current draft:
      const r = watch.readDraftToken(token);
      assert.ok(!('error' in r) && new Date(t.draftCreatedAt!).getTime() === r.draftAt);
      await approveAndSendOutreach(t.id, { sentBy: 'email-link' });
      const after = (await repositories.threads.findById(t.id))!;
      assert.equal(after.draftBody, undefined);
      assert.equal(after.awaitingReplySince, undefined, 'answered');
      assert.equal(after.messages.at(-1)!.sentBy, 'email-link');
    });

    await check('a holding reply is checked: promises, prices, dates and confirmations are refused', () => {
      assert.equal(watch.holdingReplyIsSafe('Dear Asha,\n\nThanks — we will send the quotation within 2 days.\n\nTeam'), false);
      assert.equal(watch.holdingReplyIsSafe('Dear Asha, the price is Rs 40,000.'), false);
      assert.equal(watch.holdingReplyIsSafe('Dear Asha, your demo is confirmed for Monday.'), false);
      assert.equal(watch.holdingReplyIsSafe('Dear Asha, the EmStat4S is compatible with that cell.'), false);
      assert.equal(watch.holdingReplyIsSafe(watch.fallbackHoldingReply('Dr. Asha Verma', 'Re: Quote for EmStat4S')), true);
      assert.equal(watch.holdingReplyIsSafe('Dear Asha,\n\nThank you for your message about the potentiostat. Our team is looking into it and will get back to you.\n\nTeam Class One Systems'), true);
    });

    await check('auto-reply: overdue → pending → (after the wait) one holding reply, the team told; the real answer stays owed', async () => {
      const t = await receive('auto.person@uni.test', 'Can you demo the TOB crimper?', 60);
      await conv.setAutoReply('auto.person@uni.test', true);
      watch.setHoldingReplyWriter(async () => ({ text: 'Dear Auto,\n\nThank you for your message about the crimper. Our team is looking into it and will get back to you.\n\nTeam Class One Systems', model: 'stub' }));
      const before = sent.length;
      assert.equal(await watch.autoReplyTick(new Date(now)), 0, 'first: only marked pending');
      const pending = (await repositories.threads.findById(t))!;
      assert.ok(pending.autoReplyDueAt);
      assert.ok((await conv.listPeople('all')).find((p) => p.email === 'auto.person@uni.test')!.autoReplyDueAt, 'pending shows on the panel');
      assert.equal(sent.length, before);

      assert.equal(await watch.autoReplyTick(new Date(now + (env.AUTO_REPLY_DELAY_HOURS + 0.1) * 3_600_000)), 1);
      const toThem = sent.slice(before).find((m) => m.to === 'auto.person@uni.test')!;
      assert.match(toThem.text, /looking into it/);
      const notice = sent.slice(before).find((m) => m.internal)!;
      assert.match(notice.subject, /Holding reply sent/);
      const after = (await repositories.threads.findById(t))!;
      assert.ok(after.awaitingReplySince, 'still waiting for a real answer');
      assert.ok(after.draftBody, 'the AI draft of the real answer is kept');
      assert.equal(after.messages.at(-1)!.sentBy, 'auto-reply');
      assert.equal(await watch.autoReplyTick(new Date(now + 48 * HOUR)), 0, 'never twice for the same message');
    });

    await check('a holding reply that fails the check is replaced by the fixed text', async () => {
      const t = await receive('auto.two@uni.test', 'Quote please', 60);
      await conv.setAutoReply('auto.two@uni.test', true);
      watch.setHoldingReplyWriter(async () => ({ text: 'Dear Two, we will send the quotation tomorrow at a 10% discount.', model: 'stub' }));
      await watch.autoReplyTick(new Date(now));
      const before = sent.length;
      await watch.autoReplyTick(new Date(now + (env.AUTO_REPLY_DELAY_HOURS + 0.1) * 3_600_000));
      const toThem = sent.slice(before).find((m) => m.to === 'auto.two@uni.test')!;
      assert.doesNotMatch(toThem.text, /discount|tomorrow/);
      assert.match(toThem.text, /looking into it/);
      assert.ok((await repositories.threads.findById(t))!.autoReplySentAt);
    });

    await check('"No reply needed" takes it off the waiting and overdue lists', async () => {
      const t = await receive('handled@uni.test', 'Thanks for the brochure', 60);
      await conv.markHandled(t);
      const p = (await conv.listPeople('all')).find((x) => x.email === 'handled@uni.test')!;
      assert.deepEqual([p.needsReply, p.overdue], [0, 0]);
    });
  } finally {
    watch.setHoldingReplyWriter(null);
    setTriageFn(null);
    setEmailTransport(null);
  }
}
