/**
 * Keeps the app in step with the sales mailbox, both ways.
 *
 * Every INBOX_POLL_SECONDS:
 *  - Incoming (Primary inbox, not from us): find the conversation — their reply on
 *    a known Gmail thread, else their address matches a lead or contact — let the
 *    AI read it (inboundTriage.ts) and act: a reply draft waits in Conversations;
 *    an unsubscribe marks them do-not-contact; an out-of-office pushes the next
 *    follow-up past their return; any real reply stops the follow-ups. A stranger
 *    becomes a contact (shown in Conversations), and also a lead in To review when
 *    they're asking for something (an enquiry, quote, support or meeting).
 *  - Sent (written in Gmail itself, not through the app): recorded on that
 *    person's conversation, so Conversations shows both sides.
 * Nothing is ever sent from here.
 *
 * Every mail handled is kept in `inbound_emails` (both directions) — the
 * "already seen" record. A mail the AI couldn't read is kept as `failed` and
 * retried on later polls, up to MAX_ATTEMPTS. Needs gmail.readonly at least
 * (gmail.modify to also mark mail read in Gmail) — run `npm run gmail:auth`.
 */
import { google, type gmail_v1 } from 'googleapis';
import { env } from '../../config/env.js';
import { InboundEmailModel } from '../../models/inboundEmail.model.js';
import { LeadModel } from '../../models/lead.model.js';
import { EmailThreadModel } from '../../models/emailThread.model.js';
import { repositories } from '../../repositories/index.js';
import type { EmailThread, Lead } from '../../types/domain.js';
import { normalizeInstitutionKey, normalizeNameKey } from '../../utils/normalize.js';
import { touchContact } from '../../models/contact.model.js';
import { logActivity } from '../activity/activityService.js';
import { triageInbound, type TriageResult } from './inboundTriage.js';
import { oauthClient } from './transports/gmailTransport.js';

const MAX_ATTEMPTS = 5;
const DRAFT_FIELDS = ['draftType', 'draftSubject', 'draftBody', 'draftModel', 'draftCreatedAt', 'draftIntent'];

/** One mail as the poller needs it — what a Gmail message is parsed into. */
export interface RawMail {
  gmailId: string;
  gmailThreadId?: string;
  rfcMessageId?: string;
  from: string;
  fromName?: string;
  subject: string;
  bodyText: string;
  receivedAt: Date;
  /** Auto-Submitted / Precedence headers: an automatic message (out-of-office, list mail). */
  automatic?: boolean;
  /** Newsletters, notifications, service mail: Gmail's Promotions/Updates/Social/Forums tabs or mailing-list headers. */
  bulk?: boolean;
  /** Gmail's UNREAD label. Undefined = treat as unread. */
  unread?: boolean;
  /** Sent mail: the (first) recipient. */
  to?: string;
  toName?: string;
  attachments?: Array<{ filename: string; mimeType?: string; size?: number }>;
  /** Our own note to the team (X-ClassOne-Notice header): never a conversation. */
  internal?: boolean;
}

/** Where mail comes from — Gmail in the app, a fake in tests. */
export interface InboxSource {
  /** Incoming mail worth reading (Primary inbox, not from us), newest first. */
  listRecentIds(): Promise<string[]>;
  /** Mail sent from the mailbox, newest first — optional (tests may leave it out). */
  listSentIds?(): Promise<string[]>;
  get(id: string): Promise<RawMail | null>;
  /** Marks messages read in the mailbox itself. Optional; best effort. */
  markRead?(ids: string[]): Promise<void>;
}

// --- Gmail ---------------------------------------------------------------------------------------

const decode = (data?: string | null) => (data ? Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : '');

function partText(part: gmail_v1.Schema$MessagePart | undefined, mime: string): string {
  if (!part) return '';
  if (part.mimeType === mime && part.body?.data) return decode(part.body.data);
  for (const p of part.parts ?? []) {
    const t = partText(p, mime);
    if (t) return t;
  }
  return '';
}

const htmlToText = (html: string) =>
  html
    .replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');

/** Keeps only what they wrote this time: cuts the quoted history below "On … wrote:" and "> " lines. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const joined = `${line} ${lines[i + 1] ?? ''}`; // Gmail wraps "On …, X <x@y> wrote:" over two lines
    if (/^On .{4,200}wrote:\s*$/.test(line.trim()) || /^On .{4,200}wrote:\s*$/.test(joined.trim()) || /^-{2,}\s*(Original|Forwarded) Message/i.test(line) || (/^From: /.test(line) && /^(Sent|Date): /.test(lines[i + 1] ?? ''))) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function attachmentsOf(part: gmail_v1.Schema$MessagePart | undefined, out: NonNullable<RawMail['attachments']> = []): NonNullable<RawMail['attachments']> {
  if (!part) return out;
  if (part.filename) out.push({ filename: part.filename, mimeType: part.mimeType ?? undefined, size: part.body?.size ?? undefined });
  for (const p of part.parts ?? []) attachmentsOf(p, out);
  return out;
}

function parseFrom(header: string): { from: string; fromName?: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(header);
  if (m) return { from: m[2]!.trim().toLowerCase(), fromName: m[1]!.trim() || undefined };
  return { from: header.trim().toLowerCase() };
}

export function gmailInboxSource(): InboxSource {
  const gmail = google.gmail({ version: 'v1', auth: oauthClient() });
  return {
    async listRecentIds() {
      // Primary tab only: service notifications, newsletters and promotions are not sales conversations.
      const res = await gmail.users.messages.list({ userId: 'me', q: 'in:inbox -from:me newer_than:2d -category:promotions -category:social -category:updates -category:forums', maxResults: 50 });
      return (res.data.messages ?? []).map((m) => m.id!).filter(Boolean);
    },
    async listSentIds() {
      const res = await gmail.users.messages.list({ userId: 'me', q: 'in:sent newer_than:2d', maxResults: 50 });
      return (res.data.messages ?? []).map((m) => m.id!).filter(Boolean);
    },
    async markRead(ids) {
      if (!ids.length) return;
      await gmail.users.messages.batchModify({ userId: 'me', requestBody: { ids, removeLabelIds: ['UNREAD'] } });
    },
    async get(id) {
      const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const msg = res.data;
      const headers = new Map((msg.payload?.headers ?? []).map((h) => [h.name?.toLowerCase() ?? '', h.value ?? '']));
      const { from, fromName } = parseFrom(headers.get('from') ?? '');
      const firstTo = (headers.get('to') ?? '').split(',')[0] ?? '';
      const { from: to, fromName: toName } = parseFrom(firstTo);
      const plain = partText(msg.payload, 'text/plain') || htmlToText(partText(msg.payload, 'text/html')) || msg.snippet || '';
      return {
        gmailId: msg.id!,
        gmailThreadId: msg.threadId ?? undefined,
        rfcMessageId: headers.get('message-id') || undefined,
        from,
        fromName,
        subject: headers.get('subject') ?? '',
        bodyText: stripQuoted(plain),
        receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)) : new Date(),
        unread: (msg.labelIds ?? []).includes('UNREAD'),
        to: to || undefined,
        toName,
        attachments: attachmentsOf(msg.payload),
        internal: headers.has('x-classone-notice'),
        automatic: /auto-(replied|generated)/i.test(headers.get('auto-submitted') ?? '') || /^(bulk|list|junk)$/i.test(headers.get('precedence') ?? ''),
        bulk:
          (msg.labelIds ?? []).some((l) => /^CATEGORY_(PROMOTIONS|UPDATES|SOCIAL|FORUMS)$/.test(l)) ||
          headers.has('list-unsubscribe') ||
          headers.has('list-id') ||
          /^(bulk|list|junk)$/i.test(headers.get('precedence') ?? ''),
      };
    },
  };
}

// --- Processing ----------------------------------------------------------------------------------

const BOUNCE = /^(mailer-daemon|postmaster)@/i;
// "noreply", "payments-noreply", "do-not-reply", "notifications", "mailer"… anywhere in the local part.
const NO_REPLY = /^[^@]*(no-?reply|do-?not-?reply|notification|mailer|bounce)[^@]*@/i;
/** These make a stranger's mail worth a new lead (in To review), not just a contact. */
const ENQUIRY = new Set(['product_enquiry', 'quote_request', 'support_request', 'meeting_request']);
/** Messages that don't wait for an answer from us. */
const NO_ANSWER_INTENTS = new Set(['unsubscribe', 'out_of_office', 'not_interested']);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function findLeadByEmail(email: string): Promise<Lead | null> {
  const doc = await LeadModel.findOne({ 'person.email': { $regex: `^${escapeRegex(email)}$`, $options: 'i' } }).sort({ createdAt: 1 }).lean();
  return doc ? repositories.leads.findById(String(doc._id)) : null;
}

async function createLeadFromMail(mail: RawMail, t: TriageResult): Promise<Lead> {
  const name = t.contact.name || mail.fromName || mail.from.split('@')[0]!;
  return repositories.leads.create({
    status: 'pending_review',
    source: { type: 'inbound_email', sourceRecordId: mail.from, discoveredAt: mail.receivedAt },
    person: { name, normalizedNameKey: normalizeNameKey(name), email: mail.from, title: t.contact.title, phone: t.contact.phone },
    institution: {
      name: t.contact.institution,
      normalizedNameKey: t.contact.institution ? normalizeInstitutionKey(t.contact.institution) : undefined,
      department: t.contact.department,
    },
    research: { summary: `Wrote to us: ${t.summary}`, topics: [], recentPublications: [], recentGrants: [], instruments: [] },
    aiScoring: { recommendedProductIds: t.productIds },
    review: {},
    followUpStatusSummary: 'in_progress',
    tags: ['inbound-enquiry'],
  });
}

/** The conversation a mail belongs to: its Gmail thread, else (no conversation id) the person's newest open one. */
async function findThread(gmailThreadId: string | undefined, email: string): Promise<EmailThread | null> {
  if (gmailThreadId) {
    const t = await EmailThreadModel.findOne({ providerThreadId: gmailThreadId }).sort({ updatedAt: -1 }).lean();
    if (t) return repositories.threads.findById(String(t._id));
    return null; // a fresh Gmail conversation gets its own thread, so answers go back into it
  }
  const t = await EmailThreadModel.findOne({ $or: [{ contactEmail: email }, { leadEmailSnapshot: email }], status: { $ne: 'closed' } }).sort({ updatedAt: -1 }).lean();
  return t ? repositories.threads.findById(String(t._id)) : null;
}

async function newThread(email: string, name: string | undefined, lead: Lead | null, mail: RawMail, status: EmailThread['status']): Promise<EmailThread> {
  return repositories.threads.create({
    leadId: lead?.id,
    contactEmail: email,
    contactName: lead?.person.name ?? name,
    leadEmailSnapshot: email,
    subjectLine: mail.subject || '(no subject)',
    status,
    provider: 'gmail',
    providerThreadId: mail.gmailThreadId,
    messages: [],
    followUp: { attemptsSent: 0, maxAttempts: env.FOLLOWUP_MAX_ATTEMPTS, replyDetected: status !== 'open' },
  });
}

const ACTION_LABEL = {
  reply: 'Reply drafted — ready in Conversations',
  none: 'No reply needed',
  unsubscribe: 'Marked do-not-contact — no more outreach',
  ooo: 'Out of office — next follow-up moved past their return',
} as const;

/** Handles one incoming mail end to end. Throws on failure (the caller records it for a retry). */
export async function processMail(mail: RawMail): Promise<void> {
  const ours = mail.from === env.EMAIL_FROM_ADDRESS.toLowerCase();
  if (ours || mail.internal || NO_REPLY.test(mail.from) || BOUNCE.test(mail.from) || mail.bulk) {
    if (BOUNCE.test(mail.from) && mail.gmailThreadId) {
      // Our mail bounced: close that conversation, the address is bad.
      await EmailThreadModel.updateOne({ providerThreadId: mail.gmailThreadId }, { $set: { status: 'closed', closedReason: 'bounced' } });
    }
    await InboundEmailModel.updateOne(
      { gmailId: mail.gmailId },
      { $set: { ...mailFields(mail), direction: 'inbound', status: 'ignored', action: ours ? 'Sent by us' : mail.internal ? 'Team notification' : BOUNCE.test(mail.from) ? 'Delivery failure — thread closed as bounced' : mail.bulk ? 'Newsletter / notification' : 'Automated sender' } },
      { upsert: true },
    );
    return;
  }

  // 1. Which conversation and person.
  let thread = await findThread(mail.gmailThreadId, mail.from);
  let lead: Lead | null = thread?.leadId ? await repositories.leads.findById(thread.leadId) : null;
  let matchedBy: 'thread' | 'email' | 'new_lead' | 'contact' = 'thread';
  if (!lead) {
    lead = await findLeadByEmail(mail.from);
    if (!thread) matchedBy = lead ? 'email' : 'contact';
  }

  // 2. What it says (also gives the contact details read from the signature).
  const catalog = await repositories.products.findActive();
  const triage = await triageInbound(mail, lead, thread, catalog);
  if (!lead && ENQUIRY.has(triage.intent)) {
    lead = await createLeadFromMail(mail, triage);
    matchedBy = 'new_lead';
  }
  const name = lead?.person.name ?? triage.contact.name ?? mail.fromName;
  await touchContact(mail.from, {
    name,
    title: triage.contact.title,
    institution: lead?.institution.name ?? triage.contact.institution,
    department: triage.contact.department,
    phone: triage.contact.phone,
    leadId: lead?.id,
    lastMessageAt: mail.receivedAt,
    ...(triage.intent === 'unsubscribe' ? { doNotContact: true } : {}),
  });

  if (!thread) thread = await newThread(mail.from, name, lead, mail, 'replied');
  else if (lead && !thread.leadId) await repositories.threads.updateById(thread.id, { leadId: lead.id });

  // 3. Record it on the thread.
  await repositories.threads.appendMessage(thread.id, {
    messageId: mail.gmailId,
    direction: 'inbound',
    type: 'reply',
    subject: mail.subject || '(no subject)',
    bodyText: mail.bodyText || '(empty)',
    sentAt: mail.receivedAt,
    rfcMessageId: mail.rfcMessageId,
    fromAddress: mail.from,
    intent: triage.intent,
    summary: triage.summary,
    attachments: mail.attachments?.length ? mail.attachments : undefined,
    // Already opened in Gmail itself: don't count it as unread here.
    ...(mail.unread === false ? { readAt: mail.receivedAt } : {}),
  });

  // 4. Act on it. A message that wants an answer starts (or keeps) the "waiting for us" clock.
  const now = new Date();
  if (!mail.automatic && !NO_ANSWER_INTENTS.has(triage.intent)) {
    await EmailThreadModel.updateOne({ _id: thread.id, awaitingReplySince: { $exists: false } }, { $set: { awaitingReplySince: mail.receivedAt } });
  }
  const base = { providerThreadId: thread.providerThreadId ?? mail.gmailThreadId, provider: 'gmail' as const, contactEmail: thread.contactEmail ?? mail.from };
  let action: keyof typeof ACTION_LABEL;
  if (triage.intent === 'out_of_office' || mail.automatic) {
    // Not a real reply: keep following up, but only after they're back.
    const back = triage.outOfOfficeUntil ?? new Date(now.getTime() + 7 * 86_400_000);
    await repositories.threads.updateById(thread.id, { ...base, ...(thread.status === 'draft' ? {} : { status: 'open' }), followUp: { nextCheckAt: new Date(back.getTime() + 86_400_000) } });
    action = 'ooo';
  } else if (triage.intent === 'unsubscribe') {
    await repositories.threads.updateById(thread.id, { ...base, status: 'closed', closedReason: 'replied', followUp: { replyDetected: true, replyDetectedAt: now, replyDetectionMethod: 'gmail' } }, { unset: DRAFT_FIELDS });
    if (lead) await repositories.leads.updateById(lead.id, { doNotContact: true, followUpStatusSummary: 'closed' });
    action = 'unsubscribe';
  } else {
    const replied = { replyDetected: true, replyDetectedAt: now, replyDetectionMethod: 'gmail' as const };
    if (triage.shouldReply && triage.replyBody) {
      // Replaces any follow-up draft that was waiting: answering them comes first.
      await repositories.threads.updateById(thread.id, {
        ...base,
        status: 'draft',
        followUp: replied,
        draftType: 'response',
        draftSubject: /^re:/i.test(mail.subject) ? mail.subject : `Re: ${mail.subject || thread.subjectLine}`,
        draftBody: triage.replyBody,
        draftModel: triage.model,
        draftCreatedAt: now,
        draftIntent: triage.intent,
      });
      action = 'reply';
    } else {
      await repositories.threads.updateById(thread.id, { ...base, status: 'replied', followUp: replied }, { unset: DRAFT_FIELDS });
      action = 'none';
    }
    if (lead) await repositories.leads.updateById(lead.id, { followUpStatusSummary: 'in_progress', activeThreadId: thread.id });
  }

  await logActivity({
    type: 'reply_detected',
    message: `${name ?? mail.from} wrote: ${triage.summary} (${triage.intent.replace(/_/g, ' ')})${matchedBy === 'new_lead' ? ' — new lead created' : ''}`,
    relatedLeadId: lead?.id,
    relatedThreadId: thread.id,
    metadata: { intent: triage.intent, urgency: triage.urgency, gmailId: mail.gmailId },
  });

  await InboundEmailModel.updateOne(
    { gmailId: mail.gmailId },
    {
      $set: { ...mailFields(mail), direction: 'inbound', leadId: lead?.id, threadId: thread.id, matchedBy, intent: triage.intent, summary: triage.summary, urgency: triage.urgency, action: ACTION_LABEL[action], status: 'processed' },
      $unset: { error: '' },
    },
    { upsert: true },
  );
}

/**
 * A mail sent from the mailbox outside the app (written in Gmail itself): put it on the person's
 * conversation as ours, so Conversations shows both sides. Answering them that way also clears any
 * reply draft that was waiting. No AI involved.
 */
export async function processSentMail(mail: RawMail): Promise<void> {
  const to = mail.to?.toLowerCase();
  const record = (patch: Record<string, unknown>) =>
    InboundEmailModel.updateOne({ gmailId: mail.gmailId }, { $set: { ...mailFields(mail), from: to ?? 'unknown', direction: 'outbound', ...patch }, $unset: { error: '' } }, { upsert: true });

  // Sent through the app: already on its thread.
  if (await EmailThreadModel.exists({ 'messages.messageId': mail.gmailId })) return void (await record({ status: 'ignored', action: 'Sent from the app' }));
  if (mail.internal) return void (await record({ status: 'ignored', action: 'Team notification' }));
  if (!to || to === env.EMAIL_FROM_ADDRESS.toLowerCase()) return void (await record({ status: 'ignored', action: 'No outside recipient' }));

  let thread = await findThread(mail.gmailThreadId, to);
  const lead = thread?.leadId ? await repositories.leads.findById(thread.leadId) : await findLeadByEmail(to);
  if (!thread) thread = await newThread(to, mail.toName, lead, mail, 'open');

  await repositories.threads.appendMessage(thread.id, {
    messageId: mail.gmailId,
    direction: 'outbound',
    type: 'manual',
    subject: mail.subject || '(no subject)',
    bodyText: mail.bodyText || '(empty)',
    sentAt: mail.receivedAt,
    rfcMessageId: mail.rfcMessageId,
    draftedBy: 'human',
    sentBy: 'gmail',
    attachments: mail.attachments?.length ? mail.attachments : undefined,
  });
  await repositories.threads.updateById(
    thread.id,
    {
      ...(thread.status === 'closed' ? {} : { status: 'open' as const }),
      providerThreadId: thread.providerThreadId ?? mail.gmailThreadId,
      contactEmail: thread.contactEmail ?? to,
      followUp: { attemptsSent: 0, lastOutboundAt: mail.receivedAt, nextCheckAt: new Date(mail.receivedAt.getTime() + env.FOLLOWUP_WAIT_DAYS * 86_400_000) },
    },
    // Answered from Gmail itself: no longer waiting for us.
    { unset: [...DRAFT_FIELDS, 'awaitingReplySince', 'autoReplyDueAt'] },
  );
  await touchContact(to, { name: lead?.person.name ?? mail.toName, leadId: lead?.id, lastMessageAt: mail.receivedAt });
  await record({ status: 'processed', leadId: lead?.id, threadId: thread.id, matchedBy: 'sent', action: 'Sent from Gmail — added to the conversation' });
}

function mailFields(mail: RawMail) {
  return {
    gmailThreadId: mail.gmailThreadId,
    rfcMessageId: mail.rfcMessageId,
    from: mail.from,
    fromName: mail.fromName,
    subject: mail.subject,
    bodyText: mail.bodyText,
    receivedAt: mail.receivedAt,
  };
}

/** One poll: new mail both ways, plus earlier failures still worth retrying. Returns how many were handled. */
export async function pollInbox(source: InboxSource): Promise<{ processed: number; failed: number }> {
  const incoming = await source.listRecentIds();
  const sent = source.listSentIds ? await source.listSentIds() : [];
  const all = [...incoming, ...sent];
  const known = new Set(
    ((await InboundEmailModel.find({ gmailId: { $in: all }, status: { $ne: 'failed' } }, { gmailId: 1 }).lean()) as Array<{ gmailId: string }>).map((d) => d.gmailId),
  );
  const retry = ((await InboundEmailModel.find({ status: 'failed', attempts: { $lt: MAX_ATTEMPTS } }, { gmailId: 1 }).lean()) as Array<{ gmailId: string }>).map((d) => d.gmailId);
  const sentSet = new Set(sent);
  // Oldest first, so a conversation's mails are handled in the order they were written.
  const todo = [...new Set([...all.filter((id) => !known.has(id)), ...retry])];
  const mails: RawMail[] = [];
  let processed = 0;
  let failed = 0;
  const fail = async (id: string, error: unknown, mail?: RawMail) => {
    failed += 1;
    const message = error instanceof Error ? error.message.split('\n')[0]! : String(error);
    console.error(`[inbox] could not handle ${id}:`, message);
    await InboundEmailModel.updateOne(
      { gmailId: id },
      { $set: { ...(mail ? mailFields(mail) : { from: 'unknown', receivedAt: new Date() }), status: 'failed', error: message }, $inc: { attempts: 1 } },
      { upsert: true },
    );
  };
  for (const id of todo) {
    try {
      const mail = await source.get(id);
      if (mail) mails.push(mail);
    } catch (error) {
      await fail(id, error);
    }
  }
  mails.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  for (const mail of mails) {
    try {
      if (sentSet.has(mail.gmailId) || mail.from === env.EMAIL_FROM_ADDRESS.toLowerCase()) await processSentMail(mail);
      else await processMail(mail);
      processed += 1;
    } catch (error) {
      await fail(mail.gmailId, error, mail);
    }
  }
  return { processed, failed };
}

let activeSource: InboxSource | null = null;

/** Marks messages read in the mailbox too, when the poller is running with a source that can. Best effort. */
export async function markReadInMailbox(ids: string[]): Promise<void> {
  if (!activeSource?.markRead || !ids.length) return;
  try {
    await activeSource.markRead(ids);
  } catch (error) {
    console.warn('[inbox] could not mark read in Gmail (needs the gmail.modify permission):', error instanceof Error ? error.message.split('\n')[0] : error);
  }
}

/** Test seam. */
export function setActiveInboxSource(source: InboxSource | null): void {
  activeSource = source;
}

// --- Ticker --------------------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let polling = false;
/** How inbox reading is doing — for the dashboard's alerts. */
const inboxHealth: { running: boolean; lastOkAt?: Date; lastError?: string; stoppedReason?: string } = { running: false };
export function inboxStatus() {
  return { ...inboxHealth };
}

export function startInboxPoller(): void {
  if (env.EMAIL_PROVIDER !== 'gmail' || env.INBOX_POLL_SECONDS === 0) return;
  let source: InboxSource;
  try {
    source = gmailInboxSource();
  } catch (error) {
    console.log(`[inbox] not reading mail: ${error instanceof Error ? error.message : error}`);
    return;
  }
  activeSource = source;
  inboxHealth.running = true;
  const tick = async () => {
    if (polling) return;
    polling = true;
    try {
      const r = await pollInbox(source);
      inboxHealth.lastOkAt = new Date();
      delete inboxHealth.lastError;
      if (r.processed || r.failed) console.log(`[inbox] ${r.processed} mail(s) handled${r.failed ? `, ${r.failed} failed (will retry)` : ''}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      inboxHealth.lastError = message.split('\n')[0];
      if (/insufficient|scope|403/i.test(message)) {
        inboxHealth.stoppedReason = 'The Gmail permission does not allow reading — run the Gmail sign-in again.';
        console.log('[inbox] the Gmail token can only send — run `npm --prefix backend run gmail:auth` again to allow reading, then restart. Inbox reading is off until then.');
        stopInboxPoller();
      } else {
        console.error('[inbox] poll failed:', message);
      }
    } finally {
      polling = false;
    }
  };
  void tick();
  timer = setInterval(() => void tick(), env.INBOX_POLL_SECONDS * 1000);
  console.log(`[inbox] reading ${env.EMAIL_FROM_ADDRESS} every ${env.INBOX_POLL_SECONDS}s`);
}

export function stopInboxPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
  inboxHealth.running = false;
}
