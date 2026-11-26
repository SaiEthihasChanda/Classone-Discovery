/**
 * Conversations — the mailbox organised by person.
 *
 * A "person" is an email address the mailbox has exchanged mail with: a CRM
 * lead, or a contact who is not in the CRM (yet). Their counts — unread
 * messages, conversations waiting for our reply, AI drafts ready — are worked
 * out from the threads on every read rather than stored, so they can't drift.
 *
 * Sending always goes through outreachService.sendOnThread (threaded, recorded,
 * follow-up timer re-armed). A reply typed here goes out on Send — a person
 * wrote it, so there is no approval step; an AI suggestion only fills the
 * editor and is never sent by itself.
 */
import { ApiError } from '../../middleware/errorHandler.js';
import { ContactModel, touchContact } from '../../models/contact.model.js';
import { EmailThreadModel } from '../../models/emailThread.model.js';
import { LeadModel } from '../../models/lead.model.js';
import { repositories } from '../../repositories/index.js';
import { env } from '../../config/env.js';
import type { EmailThread, Lead } from '../../types/domain.js';
import { normalizeInstitutionKey, normalizeNameKey } from '../../utils/normalize.js';
import { triageInbound } from './inboundTriage.js';
import { markReadInMailbox } from './inboxPoller.js';
import { draftOutreachEmail } from './outreachDraftService.js';
import { recipientOf, sendOnNewThread, sendOnThread } from './outreachService.js';

export type PeopleFilter = 'all' | 'needs_reply' | 'overdue' | 'unread' | 'drafts' | 'leads' | 'new';

export interface Person {
  email: string;
  name: string;
  title?: string;
  institution?: string;
  leadId?: string;
  leadStatus?: string;
  score?: number;
  doNotContact: boolean;
  conversations: number;
  /** Incoming messages not opened yet. */
  unread: number;
  /** Conversations whose last message is theirs and still wants an answer. */
  needsReply: number;
  /** AI drafts ready to review. */
  drafts: number;
  /** Conversations waiting longer than OVERDUE_HOURS for a real answer. */
  overdue: number;
  /** Oldest message of theirs still waiting for an answer. */
  waitingSince?: Date;
  /** Holding replies are sent for them when a reply is overdue. */
  autoReply: boolean;
  /** The next holding reply, when one is pending. */
  autoReplyDueAt?: Date;
  lastAt?: Date;
  lastSnippet?: string;
  lastSubject?: string;
  lastDirection?: 'inbound' | 'outbound';
}

/** Intents whose last message doesn't need an answer from us. */
const NO_ANSWER = ['unsubscribe', 'out_of_office', 'not_interested'];

const emailKey = { $toLower: { $ifNull: ['$contactEmail', '$leadEmailSnapshot'] } };

/** People with mail, newest activity first — the Conversations panels. */
export async function listPeople(filter: PeopleFilter = 'all', q = ''): Promise<Person[]> {
  const rows = (await EmailThreadModel.aggregate([
    { $addFields: { email: emailKey, last: { $arrayElemAt: ['$messages', -1] } } },
    {
      $addFields: {
        lastAt: { $ifNull: ['$last.sentAt', '$updatedAt'] },
        unread: { $size: { $filter: { input: '$messages', cond: { $and: [{ $eq: ['$$this.direction', 'inbound'] }, { $not: ['$$this.readAt'] }] } } } },
        // Waiting for a real answer from us (an automatic holding reply doesn't count as one).
        waiting: { $cond: [{ $and: [{ $ne: [{ $ifNull: ['$awaitingReplySince', null] }, null] }, { $ne: ['$status', 'closed'] }] }, 1, 0] },
        late: {
          $cond: [{ $and: [{ $ne: [{ $ifNull: ['$awaitingReplySince', null] }, null] }, { $ne: ['$status', 'closed'] }, { $lte: ['$awaitingReplySince', new Date(Date.now() - env.OVERDUE_HOURS * 3_600_000)] }] }, 1, 0],
        },
        hasDraft: { $cond: [{ $and: [{ $eq: ['$status', 'draft'] }, { $ne: [{ $ifNull: ['$draftBody', null] }, null] }] }, 1, 0] },
      },
    },
    { $sort: { lastAt: -1 } },
    {
      $group: {
        _id: '$email',
        conversations: { $sum: 1 },
        unread: { $sum: '$unread' },
        needsReply: { $sum: '$waiting' },
        overdue: { $sum: '$late' },
        waitingSince: { $min: { $cond: [{ $ne: ['$status', 'closed'] }, '$awaitingReplySince', null] } },
        autoReplyDueAt: { $min: '$autoReplyDueAt' },
        drafts: { $sum: '$hasDraft' },
        lastAt: { $first: '$lastAt' },
        lastSnippet: { $first: { $ifNull: ['$last.bodyText', '$draftBody'] } },
        lastSubject: { $first: { $ifNull: ['$last.subject', '$subjectLine'] } },
        lastDirection: { $first: '$last.direction' },
        leadId: { $max: '$leadId' },
        contactName: { $max: '$contactName' },
      },
    },
    { $sort: { lastAt: -1 } },
  ])) as Array<{ _id: string; leadId?: string; contactName?: string } & Omit<Person, 'email' | 'name' | 'doNotContact' | 'autoReply'>>;

  const emails = rows.map((r) => r._id).filter(Boolean);
  const [leadDocs, contacts] = await Promise.all([
    LeadModel.find({ $or: [{ _id: { $in: rows.map((r) => r.leadId).filter((id): id is string => /^[a-f\d]{24}$/i.test(id ?? '')) } }, { 'person.email': { $in: emails } }] })
      .select({ person: 1, institution: 1, status: 1, doNotContact: 1, 'aiScoring.relevanceScore': 1 })
      .lean(),
    ContactModel.find({ email: { $in: emails } }).lean(),
  ]);
  const leadById = new Map(leadDocs.map((l) => [String(l._id), l]));
  const leadByEmail = new Map(leadDocs.map((l) => [String(l.person?.email ?? '').toLowerCase(), l]));
  const contactByEmail = new Map(contacts.map((c) => [c.email, c]));

  let people: Person[] = rows
    .filter((r) => r._id)
    .map((r) => {
      const lead = (r.leadId && leadById.get(r.leadId)) || leadByEmail.get(r._id);
      const c = contactByEmail.get(r._id);
      return {
        email: r._id,
        name: lead?.person?.name ?? c?.name ?? r.contactName ?? r._id,
        title: lead?.person?.title ?? c?.title ?? undefined,
        institution: lead?.institution?.name ?? c?.institution ?? undefined,
        leadId: lead ? String(lead._id) : undefined,
        leadStatus: lead?.status,
        score: lead?.aiScoring?.relevanceScore ?? undefined,
        doNotContact: Boolean(lead?.doNotContact || c?.doNotContact),
        conversations: r.conversations,
        unread: r.unread,
        needsReply: r.needsReply,
        drafts: r.drafts,
        overdue: r.overdue,
        waitingSince: r.waitingSince ?? undefined,
        autoReply: Boolean(c?.autoReply),
        autoReplyDueAt: r.autoReplyDueAt ?? undefined,
        lastAt: r.lastAt,
        lastSnippet: r.lastSnippet ? String(r.lastSnippet).replace(/\s+/g, ' ').slice(0, 140) : undefined,
        lastSubject: r.lastSubject,
        lastDirection: r.lastDirection,
      };
    });

  if (filter === 'needs_reply') people = people.filter((p) => p.needsReply > 0);
  else if (filter === 'overdue') people = people.filter((p) => p.overdue > 0);
  else if (filter === 'unread') people = people.filter((p) => p.unread > 0);
  else if (filter === 'drafts') people = people.filter((p) => p.drafts > 0);
  else if (filter === 'leads') people = people.filter((p) => p.leadId);
  else if (filter === 'new') people = people.filter((p) => !p.leadId);
  const needle = q.trim().toLowerCase();
  if (needle) people = people.filter((p) => [p.name, p.email, p.institution].some((v) => v?.toLowerCase().includes(needle)));
  return people;
}

/** Counts for the sidebar badge: people with unread mail, and AI drafts ready. */
export async function conversationSummary(): Promise<{ unreadPeople: number; drafts: number; needsReply: number; overdue: number }> {
  const people = await listPeople('all');
  return {
    unreadPeople: people.filter((p) => p.unread > 0).length,
    drafts: people.reduce((n, p) => n + p.drafts, 0),
    needsReply: people.filter((p) => p.needsReply > 0).length,
    overdue: people.filter((p) => p.overdue > 0).length,
  };
}

/** One person: their details, lead summary and every conversation with its messages. */
export async function personDetail(email: string) {
  const key = email.trim().toLowerCase();
  const threadDocs = await EmailThreadModel.find({ $or: [{ contactEmail: key }, { leadEmailSnapshot: key }] }).lean();
  const threads = (await Promise.all(threadDocs.map((t) => repositories.threads.findById(String(t._id))))).filter((t): t is EmailThread => Boolean(t));
  const lastAt = (t: EmailThread) => new Date(t.messages.at(-1)?.sentAt ?? t.draftCreatedAt ?? t.updatedAt).getTime();
  threads.sort((a, b) => lastAt(b) - lastAt(a));

  const leadId = threads.find((t) => t.leadId)?.leadId;
  const lead = leadId ? await repositories.leads.findById(leadId) : await findLeadByEmail(key);
  const contact = (await ContactModel.findOne({ email: key }).lean()) as Record<string, any> | null;
  const products = lead?.aiScoring.recommendedProductIds?.length
    ? (await Promise.all(lead.aiScoring.recommendedProductIds.map((id) => repositories.products.findByProductId(id)))).filter(Boolean).map((p) => p!.name)
    : [];
  if (!threads.length && !lead && !contact) throw ApiError.notFound('Person');
  return {
    person: {
      email: key,
      name: lead?.person.name ?? contact?.name ?? threads[0]?.contactName ?? key,
      title: lead?.person.title ?? contact?.title,
      institution: lead?.institution.name ?? contact?.institution,
      department: lead?.institution.department ?? contact?.department,
      phone: lead?.person.phone ?? contact?.phone,
      doNotContact: Boolean(lead?.doNotContact || contact?.doNotContact),
      autoReply: Boolean(contact?.autoReply),
      /** This person's follow-up override (unset = the global switch). */
      followUpMode: (contact?.followUpMode as 'auto' | 'manual' | undefined) ?? null,
      lastMessageAt: contact?.lastMessageAt,
    },
    lead: lead
      ? { id: lead.id, status: lead.status, score: lead.aiScoring.relevanceScore, products, summary: lead.research.summary, tags: lead.tags }
      : null,
    threads,
  };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function findLeadByEmail(email: string): Promise<Lead | null> {
  const doc = await LeadModel.findOne({ 'person.email': { $regex: `^${escapeRegex(email)}$`, $options: 'i' } }).lean();
  return doc ? repositories.leads.findById(String(doc._id)) : null;
}

/** Opening a conversation: its incoming messages count as read, here and in Gmail. */
export async function markThreadRead(threadId: string): Promise<void> {
  const thread = await repositories.threads.findById(threadId);
  if (!thread) throw ApiError.notFound('Conversation');
  const unread = thread.messages.filter((m) => m.direction === 'inbound' && !m.readAt).map((m) => m.messageId);
  if (!unread.length) return;
  await EmailThreadModel.updateOne({ _id: threadId }, { $set: { 'messages.$[m].readAt': new Date() } }, { arrayFilters: [{ 'm.direction': 'inbound', 'm.readAt': { $exists: false } }] });
  await markReadInMailbox(unread);
}

/** A reply typed in Conversations — sent now, threaded under the conversation. Clears any waiting AI draft. */
export async function replyOnThread(threadId: string, body: string, sentBy?: string): Promise<EmailThread> {
  const thread = await repositories.threads.findById(threadId);
  if (!thread) throw ApiError.notFound('Conversation');
  if (!body.trim()) throw new ApiError(400, 'Write something first.');
  const { email } = await recipientOf(thread);
  if (!email) throw new ApiError(400, "This conversation has no email address — can't send.");
  const lastSubject = [...thread.messages].reverse().find((m) => m.subject)?.subject ?? thread.subjectLine;
  const subject = /^re:/i.test(lastSubject) ? lastSubject : `Re: ${lastSubject}`;
  await markThreadRead(thread.id);
  return sendOnThread(thread, { to: email, subject, body: body.trim(), type: 'manual', draftedBy: 'human', sentBy });
}

/** A new conversation with anyone — a lead or someone new (who becomes a contact). */
export async function composeMessage(input: { to: string; subject: string; body: string; sentBy?: string }): Promise<EmailThread> {
  const to = input.to.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new ApiError(400, 'That is not an email address.');
  if (!input.subject.trim() || !input.body.trim()) throw new ApiError(400, 'A subject and a message are needed.');
  const lead = await findLeadByEmail(to);
  const contact = (await ContactModel.findOne({ email: to }).lean()) as { name?: string } | null;
  const thread = await repositories.threads.create({
    leadId: lead?.id,
    contactEmail: to,
    contactName: lead?.person.name ?? contact?.name,
    leadEmailSnapshot: to,
    subjectLine: input.subject.trim(),
    status: 'open',
    provider: 'gmail',
    messages: [],
    followUp: { attemptsSent: 0, maxAttempts: 2, replyDetected: false },
  });
  await touchContact(to, { leadId: lead?.id });
  return sendOnNewThread(thread, { to, subject: input.subject.trim(), body: input.body.trim(), type: 'manual', draftedBy: 'human', sentBy: input.sentBy });
}

/**
 * Suggests a reply for the editor — never saved, never sent. Their last message is
 * answered with the inbox triage prompt; if ours was last, it's a follow-up nudge.
 */
export async function aiDraftForThread(threadId: string): Promise<{ body: string; model: string }> {
  const thread = await repositories.threads.findById(threadId);
  if (!thread) throw ApiError.notFound('Conversation');
  const { email, lead } = await recipientOf(thread);
  const last = thread.messages.at(-1);

  if (last?.direction === 'inbound') {
    const catalog = await repositories.products.findActive();
    const t = await triageInbound(
      { from: last.fromAddress ?? email ?? '', subject: last.subject, bodyText: last.bodyText, receivedAt: new Date(last.sentAt) },
      lead,
      thread,
      catalog,
    );
    return { body: t.replyBody ?? 'They asked not to be emailed, or this was an automatic reply — no answer is suggested.', model: t.model };
  }

  // Ours was last (or nothing yet): a follow-up, or a first message.
  const subject = lead ?? pseudoLead(thread, email);
  const outbound = thread.messages.filter((m) => m.direction === 'outbound').length;
  const draft = await draftOutreachEmail(subject, outbound ? { thread, followUpNumber: Math.min(thread.followUp.attemptsSent + 1, 2), isLast: false } : undefined);
  return { body: draft.body, model: draft.model };
}

/** Just enough of a Lead for the drafting prompt, for someone who isn't one. */
function pseudoLead(thread: EmailThread, email?: string): Lead {
  return {
    person: { name: thread.contactName ?? email ?? 'there', normalizedNameKey: '' },
    institution: {},
    research: { topics: [], recentPublications: [], recentGrants: [], instruments: [] },
    aiScoring: { recommendedProductIds: [] },
  } as unknown as Lead;
}

/** Turns a contact into a CRM lead (To review), and links their conversations to it. */
export async function personToLead(email: string): Promise<Lead> {
  const key = email.trim().toLowerCase();
  const existing = await findLeadByEmail(key);
  if (existing) return existing;
  const c = (await ContactModel.findOne({ email: key }).lean()) as Record<string, any> | null;
  const thread = await EmailThreadModel.findOne({ $or: [{ contactEmail: key }, { leadEmailSnapshot: key }] }).lean();
  const name = c?.name ?? thread?.contactName ?? key.split('@')[0]!;
  const lead = await repositories.leads.create({
    status: 'pending_review',
    source: { type: 'inbound_email', sourceRecordId: key, discoveredAt: new Date() },
    person: { name, normalizedNameKey: normalizeNameKey(name), email: key, title: c?.title, phone: c?.phone },
    institution: { name: c?.institution, normalizedNameKey: c?.institution ? normalizeInstitutionKey(c.institution) : undefined, department: c?.department },
    research: { topics: [], recentPublications: [], recentGrants: [], instruments: [] },
    aiScoring: { recommendedProductIds: [] },
    review: {},
    followUpStatusSummary: 'in_progress',
    tags: ['from-conversations'],
    ...(c?.doNotContact ? { doNotContact: true } : {}),
  });
  await EmailThreadModel.updateMany({ $or: [{ contactEmail: key }, { leadEmailSnapshot: key }] }, { $set: { leadId: lead.id } });
  await touchContact(key, { leadId: lead.id });
  return lead;
}

/** Holding replies for this person when their message has waited too long (replyWatch.ts). */
export async function setAutoReply(email: string, value: boolean): Promise<void> {
  const key = email.trim().toLowerCase();
  await touchContact(key, { autoReply: value });
  // Switched off: drop any holding reply that was pending.
  if (!value) await EmailThreadModel.updateMany({ $or: [{ contactEmail: key }, { leadEmailSnapshot: key }] }, { $unset: { autoReplyDueAt: '' } });
}

/** "No reply needed": their message no longer waits for us (and is dropped from the overdue digest). */
export async function markHandled(threadId: string): Promise<void> {
  const thread = await repositories.threads.findById(threadId);
  if (!thread) throw ApiError.notFound('Conversation');
  await EmailThreadModel.updateOne({ _id: threadId }, { $unset: { awaitingReplySince: '', autoReplyDueAt: '' } });
  await markThreadRead(threadId);
}

/** Do-not-contact, set by hand — on the contact and, when there is one, the lead. */
export async function setDoNotContact(email: string, value: boolean): Promise<void> {
  const key = email.trim().toLowerCase();
  await touchContact(key, { doNotContact: value });
  const lead = await findLeadByEmail(key);
  if (lead) await repositories.leads.updateById(lead.id, value ? { doNotContact: true } : {}, value ? {} : { unset: ['doNotContact'] });
}

export interface QueueItem {
  threadId: string;
  /** reply: their message waits for an answer. followup: nobody answered us and a follow-up is drafted. */
  kind: 'reply' | 'followup';
  person: { email: string; name: string; title?: string; institution?: string; isLead: boolean; doNotContact: boolean };
  topic: string;
  waitingSince?: Date;
  overdue: boolean;
  theirMessage?: { subject: string; body: string; intent?: string; at: Date };
  draft?: { subject?: string; body: string; type?: string };
  autoReplyDueAt?: Date;
  autoReplySent: boolean;
  conversations: number;
}

/**
 * "Needs you" — every conversation waiting on the team, longest-waiting first: their unanswered
 * message (with the AI's draft answer when there is one), then follow-ups the AI has drafted.
 */
export async function needsYouQueue(): Promise<QueueItem[]> {
  const docs = await EmailThreadModel.find({
    status: { $ne: 'closed' },
    $or: [{ awaitingReplySince: { $exists: true, $ne: null } }, { status: 'draft', draftBody: { $exists: true, $ne: null } }],
  }).lean();
  const threads = (await Promise.all(docs.map((d) => repositories.threads.findById(String(d._id))))).filter((t): t is EmailThread => Boolean(t));
  const people = new Map((await listPeople('all')).map((p) => [p.email, p]));
  const overdueBefore = Date.now() - env.OVERDUE_HOURS * 3_600_000;
  const items: QueueItem[] = [];
  for (const t of threads) {
    const email = (t.contactEmail ?? t.leadEmailSnapshot ?? '').toLowerCase();
    const p = people.get(email);
    if (!email) continue;
    const lastIn = [...t.messages].reverse().find((m) => m.direction === 'inbound');
    const waiting = Boolean(t.awaitingReplySince);
    // A first outreach draft belongs to Leads / the lead record, not to "needs you".
    if (!waiting && (t.draftType === 'initial_outreach' || !t.messages.length)) continue;
    items.push({
      threadId: t.id,
      kind: waiting ? 'reply' : 'followup',
      person: { email, name: p?.name ?? t.contactName ?? email, title: p?.title, institution: p?.institution, isLead: Boolean(p?.leadId), doNotContact: Boolean(p?.doNotContact) },
      topic: t.subjectLine.replace(/^(re|fwd?):\s*/i, ''),
      waitingSince: t.awaitingReplySince,
      overdue: Boolean(t.awaitingReplySince && new Date(t.awaitingReplySince).getTime() <= overdueBefore),
      theirMessage: waiting && lastIn ? { subject: lastIn.subject, body: lastIn.bodyText, intent: lastIn.intent, at: lastIn.sentAt } : undefined,
      draft: t.draftBody ? { subject: t.draftSubject, body: t.draftBody, type: t.draftType } : undefined,
      autoReplyDueAt: t.autoReplyDueAt,
      autoReplySent: Boolean(t.autoReplySentAt && t.awaitingReplySince && new Date(t.autoReplySentAt) >= new Date(t.awaitingReplySince)),
      conversations: p?.conversations ?? 1,
    });
  }
  const rank = (i: QueueItem) => (i.kind === 'reply' ? new Date(i.waitingSince!).getTime() : Number.MAX_SAFE_INTEGER - 1);
  return items.sort((a, b) => rank(a) - rank(b));
}
