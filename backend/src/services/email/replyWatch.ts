/**
 * Keeps people from being left hanging.
 *
 * Overdue digest — once a day (DIGEST_TIME, India time) every sales and admin
 * user gets one email listing each conversation whose message has waited more
 * than OVERDUE_HOURS for a real answer, with the AI's draft reply and a
 * "Review & send" button. The button opens a confirm page (no sign-in needed:
 * the link is signed and only sends that one draft, to that one person); it
 * never sends on the click alone, so link scanners in mail apps can't trigger it.
 *
 * Auto-reply — for people marked "auto reply": once their message is overdue the
 * conversation is marked pending (autoReplyDueAt = now + AUTO_REPLY_DELAY_HOURS);
 * if nobody answers by then, a short AI holding reply goes out — it acknowledges
 * and says the team is on it, and is checked so it never promises, confirms,
 * quotes or answers anything — and the team is emailed what was sent. The
 * conversation still counts as waiting for a real answer, and the AI's draft of
 * that answer is kept. At most one holding reply per message of theirs.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppUserModel } from '../../models/appUser.model.js';
import { ContactModel } from '../../models/contact.model.js';
import { EmailThreadModel } from '../../models/emailThread.model.js';
import { getState, setState } from '../../models/systemState.model.js';
import { repositories } from '../../repositories/index.js';
import type { EmailThread } from '../../types/domain.js';
import { geminiGenerate, geminiModels } from '../ai/geminiProvider.js';
import { logActivity } from '../activity/activityService.js';
import { aiDraftForThread } from './conversationService.js';
import { recipientOf, sendOnThread } from './outreachService.js';
import { getEmailTransport } from './transports/index.js';

const HOUR = 3_600_000;
const NO_ANSWER = new Set(['unsubscribe', 'out_of_office', 'not_interested']);

// --- Who hears about it ----------------------------------------------------------------------------

/** Every sales and admin user; the sales mailbox itself when there are none (local dev). */
export async function teamRecipients(): Promise<string[]> {
  const users = (await AppUserModel.find({ role: { $in: ['sales', 'admin'] } }, { email: 1 }).lean()) as Array<{ email?: string }>;
  const emails = [...new Set(users.map((u) => String(u.email ?? '').toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !e.endsWith('@localhost')))];
  return emails.length ? emails : [env.EMAIL_FROM_ADDRESS];
}

// --- Signed "send this draft" links ------------------------------------------------------------------

const secret = () => env.ACTION_LINK_SECRET ?? env.INTERNAL_API_TOKEN;
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** A link token for one draft: thread id + the draft's creation time + expiry, HMAC-signed. */
export function draftToken(thread: EmailThread, validHours = 72): string | null {
  const s = secret();
  if (!s || !thread.draftCreatedAt) return null;
  const payload = b64u(JSON.stringify({ t: thread.id, d: new Date(thread.draftCreatedAt).getTime(), e: Date.now() + validHours * HOUR }));
  return `${payload}.${b64u(createHmac('sha256', s).update(payload).digest())}`;
}

/** The thread and draft a token names — or why it can't be used. */
export function readDraftToken(token: string): { threadId: string; draftAt: number } | { error: string } {
  const s = secret();
  const [payload, sig] = token.split('.');
  if (!s || !payload || !sig) return { error: 'This link is not valid.' };
  const expected = createHmac('sha256', s).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { error: 'This link is not valid.' };
  const p = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { t: string; d: number; e: number };
  if (Date.now() > p.e) return { error: 'This link has expired — open the conversation in the CRM instead.' };
  return { threadId: p.t, draftAt: p.d };
}

const sendLink = (thread: EmailThread) => {
  const t = draftToken(thread);
  return t ? `${env.appUrl}/act/send?token=${encodeURIComponent(t)}` : undefined;
};
export const crmLink = (email: string) => `${env.appUrl}/conversations?person=${encodeURIComponent(email)}`;

// --- Making sure there is a draft --------------------------------------------------------------------

/** The AI's draft of the real answer, kept on the thread; written now if there isn't one. Null if the AI is unavailable. */
async function ensureDraft(thread: EmailThread): Promise<EmailThread | null> {
  if (thread.draftBody && thread.draftType === 'response') return thread;
  try {
    const d = await aiDraftForThread(thread.id);
    const lastIn = [...thread.messages].reverse().find((m) => m.direction === 'inbound');
    const subject = lastIn?.subject ?? thread.subjectLine;
    return await repositories.threads.updateById(thread.id, {
      status: 'draft',
      draftType: 'response',
      draftSubject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      draftBody: d.body,
      draftModel: d.model,
      draftCreatedAt: new Date(),
      ...(lastIn?.intent ? { draftIntent: lastIn.intent } : {}),
    });
  } catch (error) {
    console.warn(`[reply-watch] no AI draft for ${thread.id}:`, error instanceof Error ? error.message.split('\n')[0] : error);
    return null;
  }
}

// --- Holding replies ---------------------------------------------------------------------------------

const HOLDING_PROMPT = `You write a short holding reply from the Class One Systems sales team (an Indian supplier of electrochemical research instrumentation). The person's message is still being looked at by the team; this reply only lets them know it was received and is being handled, so they are not left without a response.

Write 40-90 words: a greeting by name, thanks for their message, a mention of its topic in general words (show it was read), and that the team is looking into it and will get back to them. Sign off "Team Class One Systems".

You must NOT:
- answer any question, or give or confirm any fact, specification, compatibility, price, discount, quotation, stock, delivery, date, time or deadline;
- agree to, schedule or confirm a meeting, call, demo, visit, trial or sample;
- promise anything or give any timeframe ("today", "within 24 hours", "by Monday", "shortly", "soon");
- ask them for information, attach anything, or mention AI or automation.
Plain text only, no markdown.`;

/** Phrases a holding reply must not contain — the model's output is checked, not trusted. */
const FORBIDDEN = [
  /[₹$€£]|\brs\.?\s*\d|\binr\b|\busd\b/i,
  /\d+\s*(%|percent|hours?|hrs?|days?|weeks?|working)/i,
  /\b(price|pricing|cost|discount|quot(e|ation)|invoice|proforma|gst|payment)\b/i,
  /\b(deliver(y|ed)?|dispatch|ship(ping|ped)?|in stock|stock|available|availability)\b/i,
  /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week|shortly|soon|asap|within)\b/i,
  /\b(confirm(ed)?|guarantee|we will (send|ship|deliver|arrange|schedule|book|call)|scheduled|booked|meeting is|demo is)\b/i,
  /\b(compatible|supports?|specification|resolution|range)\b/i,
];

export function holdingReplyIsSafe(text: string): boolean {
  return text.trim().length > 20 && !FORBIDDEN.some((rx) => rx.test(text));
}

const firstName = (name: string) => name.replace(/^(dr|prof|mr|ms|mrs)\.?\s+/i, '').split(/\s+/)[0] || name;

/** The fixed text used when the model's reply doesn't pass the check (or the AI is unavailable). */
export function fallbackHoldingReply(name: string, subject: string): string {
  const topic = subject.replace(/^(re|fwd?):\s*/i, '').trim();
  const write = (about: string) =>
    `Dear ${name.match(/^(dr|prof)\.?\s/i) ? name : firstName(name)},\n\nThank you for your message${about}. Our team is looking into it and will get back to you.\n\nTeam Class One Systems`;
  // Their subject is echoed only when it trips none of the checks ("Quote for…" would read as an offer).
  const withTopic = topic ? write(` about "${topic}"`) : '';
  return withTopic && holdingReplyIsSafe(withTopic) ? withTopic : write('');
}

type HoldingWriter = (name: string, lastIn: EmailThread['messages'][number]) => Promise<{ text: string; model: string } | null>;
let holdingWriter: HoldingWriter | null = null;
/** Test seam: replace the AI call (return null to simulate the AI being unavailable). */
export function setHoldingReplyWriter(fn: HoldingWriter | null): void {
  holdingWriter = fn;
}

async function writeHoldingReply(name: string, lastIn: EmailThread['messages'][number]): Promise<{ text: string; model: string }> {
  if (holdingWriter) {
    const r = await holdingWriter(name, lastIn);
    if (r && holdingReplyIsSafe(r.text)) return r;
    return { text: fallbackHoldingReply(name, lastIn.subject), model: 'fixed-text' };
  }
  if (env.GEMINI_API_KEY) {
    try {
      const { text, model } = await geminiGenerate({
        apiKey: env.GEMINI_API_KEY.trim(),
        models: geminiModels(),
        systemPrompt: HOLDING_PROMPT,
        userPrompt: `Their name: ${name}\nSubject: ${lastIn.subject}\nTheir message:\n${lastIn.bodyText.slice(0, 2500)}`,
        generationConfig: { temperature: 0.3 },
        timeoutMs: 45_000,
      });
      if (holdingReplyIsSafe(text)) return { text: text.trim(), model };
      console.warn('[reply-watch] holding reply failed the safety check — using the fixed text');
    } catch (error) {
      console.warn('[reply-watch] AI unavailable for a holding reply — using the fixed text:', error instanceof Error ? error.message.split('\n')[0] : error);
    }
  }
  return { text: fallbackHoldingReply(name, lastIn.subject), model: 'fixed-text' };
}

/** Threads whose message has waited at least OVERDUE_HOURS for a real answer. */
async function overdueThreads(now: Date): Promise<EmailThread[]> {
  const docs = await EmailThreadModel.find({ status: { $ne: 'closed' }, awaitingReplySince: { $lte: new Date(now.getTime() - env.OVERDUE_HOURS * HOUR) } }, { _id: 1 })
    .sort({ awaitingReplySince: 1 })
    .lean();
  return (await Promise.all(docs.map((d) => repositories.threads.findById(String(d._id))))).filter((t): t is EmailThread => Boolean(t));
}

/** Marks auto-reply conversations pending once overdue, and sends the holding replies that are due. Returns how many went out. */
export async function autoReplyTick(now = new Date()): Promise<number> {
  const autoPeople = new Set(((await ContactModel.find({ autoReply: true }, { email: 1 }).lean()) as Array<{ email: string }>).map((c) => c.email));
  if (!autoPeople.size) return 0;
  let sent = 0;
  for (const thread of await overdueThreads(now)) {
    // One broken conversation must not stop the others: it is logged and tried again an hour later.
    try {
      if (await holdingReplyFor(thread, autoPeople, now)) sent += 1;
    } catch (error) {
      console.error(`[reply-watch] holding reply for thread ${thread.id} failed:`, error instanceof Error ? error.message : error);
      await EmailThreadModel.updateOne({ _id: thread.id }, { $set: { autoReplyDueAt: new Date(now.getTime() + HOUR) } }).catch(() => {});
    }
  }
  return sent;
}

/** Sends one holding reply if this conversation is due one. Returns whether it sent. */
async function holdingReplyFor(thread: EmailThread, autoPeople: Set<string>, now: Date): Promise<boolean> {
  {
    const { email, lead, contact } = await recipientOf(thread);
    if (!email || !autoPeople.has(email.toLowerCase()) || contact.doNotContact) return false;
    // One holding reply per message of theirs.
    if (thread.autoReplySentAt && thread.awaitingReplySince && new Date(thread.autoReplySentAt) >= new Date(thread.awaitingReplySince)) return false;
    const lastIn = [...thread.messages].reverse().find((m) => m.direction === 'inbound');
    if (!lastIn || NO_ANSWER.has(lastIn.intent ?? '')) return false;

    if (!thread.autoReplyDueAt) {
      await EmailThreadModel.updateOne({ _id: thread.id }, { $set: { autoReplyDueAt: new Date(now.getTime() + env.AUTO_REPLY_DELAY_HOURS * HOUR) } });
      if (env.AUTO_REPLY_DELAY_HOURS > 0) return false;
    } else if (new Date(thread.autoReplyDueAt) > now) return false;

    const draftKept = await ensureDraft(thread);
    const { text, model } = await writeHoldingReply(contact.name, lastIn);
    const subject = /^re:/i.test(lastIn.subject) ? lastIn.subject : `Re: ${lastIn.subject || thread.subjectLine}`;
    const after = await sendOnThread(draftKept ?? thread, { to: email, subject, body: text, type: 'response', draftedBy: 'ai', aiDraftModel: model, sentBy: 'auto-reply', holding: true });
    await logActivity({ type: 'email_sent', message: `Holding reply sent automatically to ${contact.name}`, relatedLeadId: lead?.id, relatedThreadId: thread.id, metadata: { auto: true } });
    await notifyHoldingReply(after, contact.name, email, lastIn, text).catch((e) => console.error('[reply-watch] could not notify the team:', e instanceof Error ? e.message : e));
    return true;
  }
}

// --- Team emails -------------------------------------------------------------------------------------

export const NAVY = '#16265c';
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const para = (s: string) => esc(s).replace(/\n/g, '<br>');
export const button = (href: string, label: string, primary = true) =>
  `<a href="${esc(href)}" style="display:inline-block;padding:9px 16px;margin:0 8px 0 0;border-radius:7px;text-decoration:none;font-weight:600;font-size:14px;${primary ? `background:${NAVY};color:#fff` : `background:#eef1f8;color:${NAVY}`}">${esc(label)}</a>`;
export const shell = (title: string, intro: string, body: string) => `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1a2033;max-width:680px">
<h2 style="margin:0 0 4px;font-size:19px;color:${NAVY}">${esc(title)}</h2><p style="margin:0 0 18px;color:#4b5563">${intro}</p>${body}
<p style="margin:20px 0 0;color:#9aa1ad;font-size:12px">From ClassOne Discovery.${body.includes('Review &amp; send') ? ' "Review &amp; send" opens a page to check the reply and send it — nothing is sent from this email by itself.' : ''}</p></div>`;
const daysSince = (d: Date | string, now: Date) => Math.max(1, Math.floor((now.getTime() - new Date(d).getTime()) / (24 * HOUR)));

export async function sendToTeam(subject: string, html: string, text: string): Promise<void> {
  for (const to of await teamRecipients()) await getEmailTransport().send({ to, subject, html, text, internal: true });
}

export async function notifyHoldingReply(thread: EmailThread, name: string, email: string, lastIn: EmailThread['messages'][number], holding: string): Promise<void> {
  const link = thread.draftBody ? sendLink(thread) : undefined;
  const html = shell(
    `Holding reply sent to ${name}`,
    `${esc(name)} (${esc(email)}) had waited ${daysSince(thread.awaitingReplySince ?? lastIn.sentAt, new Date())} day(s). Auto-reply is on for them, so this went out. <strong>They still need a real answer.</strong>`,
    `<p style="margin:0 0 4px;font-weight:600">They wrote — "${esc(lastIn.subject)}"</p>
<div style="border-left:3px solid #d9dee7;padding:6px 12px;margin:0 0 14px;color:#374151">${para(lastIn.bodyText.slice(0, 1200))}</div>
<p style="margin:0 0 4px;font-weight:600">Sent automatically</p>
<div style="background:#f3f5f9;border-radius:8px;padding:10px 14px;margin:0 0 14px">${para(holding)}</div>
${thread.draftBody ? `<p style="margin:0 0 4px;font-weight:600">AI draft of the real answer — not sent</p><div style="background:#faf7ff;border:1px dashed #b9a5f0;border-radius:8px;padding:10px 14px;margin:0 0 14px">${para(thread.draftBody)}</div>` : ''}
<p>${link ? button(link, 'Review & send the answer') : ''}${button(crmLink(email), 'Open in the CRM', !link)}</p>`,
  );
  const text = [`Holding reply sent automatically to ${name} <${email}>. They still need a real answer.`, '', `They wrote: ${lastIn.bodyText.slice(0, 800)}`, '', `Sent: ${holding}`, '', thread.draftBody ? `AI draft of the answer (not sent): ${thread.draftBody}` : '', link ? `Review & send: ${link}` : '', `Open in the CRM: ${crmLink(email)}`].filter(Boolean).join('\n');
  await sendToTeam(`Holding reply sent to ${name}`, html, text);
}

/** Today's date in India time, YYYY-MM-DD. */
const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const istMinutes = (d: Date) => {
  const ist = new Date(d.getTime() + 330 * 60_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
};

/** The daily digest of overdue replies. Sent once a day at/after DIGEST_TIME; returns how many conversations it listed (null = not due). */
export async function digestTick(now = new Date(), force = false): Promise<number | null> {
  const [hh, mm] = env.DIGEST_TIME.split(':').map(Number) as [number, number];
  if (!force && (istMinutes(now) < hh * 60 + mm || (await getState<string>('overdueDigestDay')) === istDay(now))) return null;
  await setState('overdueDigestDay', istDay(now));

  const overdue = await overdueThreads(now);
  if (!overdue.length) return 0;
  const rows: string[] = [];
  const textRows: string[] = [];
  for (const t of overdue) {
    const { email, contact } = await recipientOf(t);
    if (!email) continue;
    const withDraft = (await ensureDraft(t)) ?? t;
    const lastIn = [...t.messages].reverse().find((m) => m.direction === 'inbound');
    const days = daysSince(t.awaitingReplySince!, now);
    const link = withDraft.draftBody ? sendLink(withDraft) : undefined;
    const auto = (await ContactModel.exists({ email: email.toLowerCase(), autoReply: true })) ? (t.autoReplySentAt ? ' · holding reply already sent' : t.autoReplyDueAt ? ` · holding reply goes out ${new Date(t.autoReplyDueAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}` : ' · auto-reply on') : '';
    rows.push(`<div style="border:1px solid #e8ebf0;border-radius:10px;padding:14px 16px;margin:0 0 14px">
<div style="font-weight:700;font-size:15px">${esc(contact.name)} <span style="font-weight:400;color:#6b7280;font-size:13px">· ${esc(email)}</span></div>
<div style="color:#b45309;font-size:13px;margin:2px 0 8px">Waiting ${days} day${days === 1 ? '' : 's'}${esc(auto)}</div>
${lastIn ? `<div style="font-weight:600;margin-bottom:2px">"${esc(lastIn.subject)}"</div><div style="border-left:3px solid #d9dee7;padding:4px 10px;margin:0 0 10px;color:#374151">${para(lastIn.bodyText.slice(0, 600))}${lastIn.bodyText.length > 600 ? '…' : ''}</div>` : ''}
${withDraft.draftBody ? `<div style="font-size:12px;font-weight:700;color:#6d28d9;margin-bottom:2px">AI DRAFT REPLY</div><div style="background:#faf7ff;border:1px dashed #b9a5f0;border-radius:8px;padding:10px 12px;margin:0 0 10px">${para(withDraft.draftBody)}</div>` : '<div style="color:#6b7280;margin-bottom:10px">The AI could not draft a reply right now — write one in the CRM.</div>'}
${link ? button(link, 'Review & send') : ''}${button(crmLink(email), 'Open in the CRM', !link)}</div>`);
    textRows.push(`- ${contact.name} <${email}>, waiting ${days} day(s)${auto}\n  ${link ? `Review & send: ${link}` : `Open: ${crmLink(email)}`}`);
  }
  if (!rows.length) return 0;
  const n = rows.length;
  await sendToTeam(
    `${n} ${n === 1 ? 'person is' : 'people are'} waiting for a reply`,
    shell(`${n} ${n === 1 ? 'person has' : 'people have'} waited over ${Math.round(env.OVERDUE_HOURS / 24)} days for a reply`, 'Each has an AI-drafted reply ready. Check it and send it — from here or from the CRM.', rows.join('')),
    [`${n} people are waiting for a reply:`, '', ...textRows].join('\n'),
  );
  return n;
}

// --- Start-up and ticker -----------------------------------------------------------------------------

/**
 * Once: conversations from before this feature get their "waiting since" from their last message
 * (theirs, wanting an answer, not closed). Later changes are kept up to date by the poller and sends.
 */
export async function backfillAwaiting(): Promise<number> {
  if (await getState<boolean>('awaitingBackfilled')) return 0;
  const docs = (await EmailThreadModel.find({ status: { $ne: 'closed' }, awaitingReplySince: { $exists: false } }, { messages: { $slice: -1 } }).lean()) as Array<{
    _id: unknown;
    messages: Array<{ direction: string; intent?: string; sentAt: Date }>;
  }>;
  let n = 0;
  for (const d of docs) {
    const last = d.messages[0];
    if (last?.direction === 'inbound' && !NO_ANSWER.has(last.intent ?? '')) {
      await EmailThreadModel.updateOne({ _id: d._id }, { $set: { awaitingReplySince: last.sentAt } });
      n += 1;
    }
  }
  await setState('awaitingBackfilled', true);
  return n;
}

let timer: NodeJS.Timeout | null = null;
let busy = false;

export function startReplyWatch(): void {
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      try {
        const n = await autoReplyTick();
        if (n) console.log(`[reply-watch] ${n} holding repl${n === 1 ? 'y' : 'ies'} sent`);
      } catch (error) {
        console.error('[reply-watch] holding replies failed:', error instanceof Error ? error.message : error);
      }
      try {
        const d = await digestTick();
        if (d) console.log(`[reply-watch] overdue digest sent (${d} conversation${d === 1 ? '' : 's'})`);
      } catch (error) {
        console.error('[reply-watch] digest failed:', error instanceof Error ? error.message : error);
      }
    } finally {
      busy = false;
    }
  };
  void backfillAwaiting()
    .then((n) => n && console.log(`[reply-watch] ${n} existing conversation(s) marked as waiting for a reply`))
    .catch(() => {})
    .finally(() => void tick());
  timer = setInterval(() => void tick(), 5 * 60_000);
  console.log(`[reply-watch] overdue after ${env.OVERDUE_HOURS} h · digest daily at ${env.DIGEST_TIME} IST · holding replies ${env.AUTO_REPLY_DELAY_HOURS} h after overdue`);
}

export function stopReplyWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
