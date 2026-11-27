/**
 * Campaigns: who a campaign goes to, and sending it.
 *
 * Audience — CRM leads matching the filters, minus anyone with no email, who
 * asked not to be contacted, who is rejected or still on the conveyor, or who
 * has already had this campaign.
 *
 * Sending — starting a campaign snapshots its audience into the recipient
 * queue. A 5-second ticker sends one email at a time: each campaign waits its
 * own pace (paceSeconds) between emails, and all campaigns together stop at
 * CAMPAIGN_DAILY_CAP a day (India time) — the rest go the next day. Each email
 * goes through outreachService.sendOnThread on its own conversation with that
 * person, so a reply lands in Conversations under them. Campaign mails never
 * trigger automatic follow-ups.
 */
import { escapeRegex } from '../../utils/regex.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../middleware/errorHandler.js';
import { CampaignAssetModel, CampaignModel, CampaignRecipientModel, type CampaignAudience, type CampaignBlock } from '../../models/campaign.model.js';
import { ContactModel } from '../../models/contact.model.js';
import { EmailThreadModel } from '../../models/emailThread.model.js';
import { LeadModel } from '../../models/lead.model.js';
import { repositories } from '../../repositories/index.js';
import type { Product } from '../../types/domain.js';
import { geminiGenerate, geminiModels } from '../ai/geminiProvider.js';
import { sendOnNewThread } from '../email/outreachService.js';
import { inSendWindow } from '../../utils/sendWindow.js';
import { addTracking, engagementByCampaign } from './tracking.js';
import { getEmailTransport } from '../email/transports/index.js';
import { listUnsubscribeHeader, renderCampaign, type Asset, type Recipient } from './campaignRender.js';


// --- Audience ---------------------------------------------------------------------------------------

/** The Mongo filter for a campaign's audience (before per-campaign exclusions). */
export async function audienceFilter(a: CampaignAudience): Promise<Record<string, unknown>> {
  const dnc = ((await ContactModel.find({ doNotContact: true }, { email: 1 }).lean()) as Array<{ email: string }>).map((c) => c.email);
  const and: Record<string, unknown>[] = [
    { 'person.email': { $exists: true, $nin: ['', null, ...dnc] } },
    { doNotContact: { $ne: true } },
    { inPipeline: { $ne: true } },
    { status: { $in: a.statuses?.length ? a.statuses : ['approved', 'customer'] } },
  ];
  if (a.minScore !== undefined) and.push({ 'aiScoring.relevanceScore': { $gte: a.minScore } });
  if (a.institutes?.length) and.push({ 'institution.name': { $in: a.institutes } });
  if (a.applicationAreas?.length) and.push({ 'research.applicationAreas': { $in: a.applicationAreas } });
  if (a.productIds?.length) and.push({ 'aiScoring.recommendedProductIds': { $in: a.productIds } });
  if (a.brands?.length) and.push({ 'research.instruments.brandKey': { $in: a.brands } });
  if (a.tags?.length) and.push({ tags: { $in: a.tags } });
  if (a.leadIds?.length) and.push({ _id: { $in: a.leadIds.filter((id) => /^[a-f\d]{24}$/i.test(id)) } });
  if (a.search?.trim()) {
    const rx = { $regex: escapeRegex(a.search.trim()), $options: 'i' };
    and.push({ $or: [{ 'person.name': rx }, { 'person.email': rx }, { 'institution.name': rx }] });
  }
  return { $and: and };
}

/** How many people a filter reaches, a sample of them, and the options to filter by. */
export async function previewAudience(a: CampaignAudience, campaignId?: string) {
  const filter = await audienceFilter(a);
  const already = campaignId ? ((await CampaignRecipientModel.find({ campaignId }, { email: 1 }).lean()) as Array<{ email: string }>).map((r) => r.email) : [];
  const final = already.length ? { $and: [filter, { 'person.email': { $nin: already } }] } : filter;
  const [count, sample] = await Promise.all([
    LeadModel.countDocuments(final),
    LeadModel.find(final).sort({ 'aiScoring.relevanceScore': -1 }).limit(10).select({ person: 1, institution: 1, 'aiScoring.relevanceScore': 1, status: 1 }).lean(),
  ]);
  return {
    count,
    alreadySent: already.length,
    sample: sample.map((l) => ({ id: String(l._id), name: l.person?.name, email: l.person?.email, institute: l.institution?.name, score: l.aiScoring?.relevanceScore, status: l.status })),
  };
}

/** The values the audience filters can take, from the leads that could be mailed at all. */
export async function audienceOptions() {
  const base = { 'person.email': { $exists: true, $ne: '' }, inPipeline: { $ne: true }, status: { $ne: 'rejected' } };
  const [institutes, areas, tags, products] = await Promise.all([
    LeadModel.distinct('institution.name', base),
    LeadModel.distinct('research.applicationAreas', base),
    LeadModel.distinct('tags', base),
    repositories.products.findActive(),
  ]);
  const clean = (xs: unknown[]) => (xs.filter((x) => typeof x === 'string' && x.trim()) as string[]).sort((x, y) => x.localeCompare(y));
  return { institutes: clean(institutes), applicationAreas: clean(areas), tags: clean(tags), products: products.map((p) => ({ id: p.productId, name: p.name })) };
}

// --- Rendering helpers ------------------------------------------------------------------------------

/** Image bytes as Mongo hands them back (a BSON Binary from .lean(), or a Buffer). */
export function bytesOf(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  const b = (data as { buffer?: ArrayBuffer | Uint8Array }).buffer;
  return Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b ?? new ArrayBuffer(0)));
}

async function renderContext(blocks: CampaignBlock[], mode: 'email' | 'preview') {
  const assetIds = blocks.filter((b): b is Extract<CampaignBlock, { type: 'image' }> => b.type === 'image').map((b) => b.assetId).filter((id) => /^[a-f\d]{24}$/i.test(id));
  const assetDocs = assetIds.length ? await CampaignAssetModel.find({ _id: { $in: assetIds } }).lean() : [];
  const assets = new Map<string, Asset>(assetDocs.map((a) => [String(a._id), { id: String(a._id), filename: a.filename, contentType: a.contentType, data: bytesOf(a.data) }]));
  const products = new Map<string, Product>((await repositories.products.findActive()).map((p) => [p.productId, p]));
  return { assets, products, mode };
}

type MaybeStr = string | null | undefined;
const recipientOfLead = (l: { person?: { name?: MaybeStr; title?: MaybeStr } | null; institution?: { name?: MaybeStr; department?: MaybeStr } | null } | null): Recipient => ({
  name: l?.person?.name ?? undefined,
  title: l?.person?.title ?? undefined,
  institute: l?.institution?.name ?? undefined,
  department: l?.institution?.department ?? undefined,
});

/** The email as one recipient would see it (a sample lead, or placeholder values). */
export async function previewCampaign(input: { subject: string; preheader?: string; blocks: CampaignBlock[] }, leadId?: string) {
  const lead = leadId && /^[a-f\d]{24}$/i.test(leadId) ? await LeadModel.findById(leadId).lean() : null;
  const r = lead ? recipientOfLead(lead) : { name: 'Dr. Priya Sharma', title: 'Associate Professor', institute: 'Indian Institute of Technology Madras', department: 'Chemistry' };
  const out = renderCampaign(input, r, await renderContext(input.blocks, 'preview'));
  return { subject: out.subject, html: out.html, text: out.text };
}

/** Sends the campaign as it is now to one address — not recorded anywhere. */
export async function sendTest(campaignId: string, to: string) {
  const c = await getCampaign(campaignId);
  if (!c.subject.trim()) throw new ApiError(400, 'Add a subject first.');
  const out = renderCampaign(c, { name: 'Dr. Test Recipient', title: 'Professor', institute: 'Test Institute', department: 'Chemistry' }, await renderContext(c.blocks, 'email'));
  await getEmailTransport().send({ to, subject: `[TEST] ${out.subject}`, text: out.text, html: out.html, attachments: out.attachments, listUnsubscribe: listUnsubscribeHeader(), internal: true });
}

// --- Campaign lifecycle -----------------------------------------------------------------------------

export interface CampaignDoc {
  id: string;
  name: string;
  subject: string;
  preheader?: string;
  blocks: CampaignBlock[];
  audience: CampaignAudience;
  status: 'draft' | 'scheduled' | 'sending' | 'paused' | 'done' | 'cancelled';
  sendAt?: Date;
  paceSeconds: number;
  startedAt?: Date;
  finishedAt?: Date;
  lastSentAt?: Date;
  createdBy?: string;
  kind?: 'manual' | 'product_launch';
  productId?: string;
  reviewUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const toDoc = (d: Record<string, any>): CampaignDoc => {
  const { _id, ...rest } = d;
  return { id: String(_id), ...rest } as CampaignDoc;
};

export async function getCampaign(id: string): Promise<CampaignDoc> {
  if (!/^[a-f\d]{24}$/i.test(id)) throw ApiError.notFound('Campaign');
  const d = await CampaignModel.findById(id).lean();
  if (!d) throw ApiError.notFound('Campaign');
  return toDoc(d);
}

/** Every campaign, newest first, with how far it got and how people responded. */
export async function listCampaigns() {
  const docs = (await CampaignModel.find().sort({ createdAt: -1 }).limit(200).lean()).map(toDoc);
  const ids = docs.map((d) => d.id);
  const counts = (await CampaignRecipientModel.aggregate([{ $match: { campaignId: { $in: ids } } }, { $group: { _id: { c: '$campaignId', s: '$status' }, n: { $sum: 1 } } }])) as Array<{ _id: { c: string; s: string }; n: number }>;
  const replied = await repliesByCampaign(ids);
  const engagement = await engagementByCampaign(ids);
  return docs.map((d) => {
    const by = (s: string) => counts.find((x) => x._id.c === d.id && x._id.s === s)?.n ?? 0;
    const queued = by('queued');
    const sent = by('sent');
    return { ...d, blocks: undefined, blockCount: d.blocks.length, stats: { total: queued + sent + by('failed') + by('skipped'), queued, sent, failed: by('failed'), skipped: by('skipped'), replied: replied.get(d.id) ?? 0, opened: engagement.get(d.id)?.opened ?? 0, clicked: engagement.get(d.id)?.clicked ?? 0 } };
  });
}

/** People who wrote back on a campaign conversation after receiving it. */
async function repliesByCampaign(ids: string[]): Promise<Map<string, number>> {
  const rows = (await CampaignRecipientModel.find({ campaignId: { $in: ids }, status: 'sent', threadId: { $exists: true } }, { campaignId: 1, threadId: 1 }).lean()) as Array<{ campaignId: string; threadId: string }>;
  const withReply = new Set(
    ((await EmailThreadModel.find({ _id: { $in: rows.map((r) => r.threadId).filter((t) => /^[a-f\d]{24}$/i.test(t)) }, 'messages.direction': 'inbound' }, { _id: 1 }).lean()) as Array<{ _id: unknown }>).map((t) => String(t._id)),
  );
  const out = new Map<string, number>();
  for (const r of rows) if (withReply.has(r.threadId)) out.set(r.campaignId, (out.get(r.campaignId) ?? 0) + 1);
  return out;
}

export async function campaignRecipients(id: string, limit = 500) {
  return (await CampaignRecipientModel.find({ campaignId: id }).sort({ status: 1, sentAt: -1 }).limit(limit).lean()).map(({ _id, ...r }) => ({ id: String(_id), ...r }));
}

export async function createCampaign(input: { name: string; createdBy?: string }): Promise<CampaignDoc> {
  const doc = await CampaignModel.create({
    name: input.name,
    subject: '',
    blocks: [
      { id: 'b1', type: 'heading', text: 'A headline for {first_name|your lab}' },
      { id: 'b2', type: 'text', text: 'Dear {title|Dr.} {last_name|},\n\nWrite your message here. Use **bold** for emphasis; links like https://classonesystems.in become clickable.' },
      { id: 'b3', type: 'button', label: 'Book a demo', url: 'https://classonesystems.in' },
    ],
    audience: { statuses: ['approved', 'customer'] },
    createdBy: input.createdBy,
  });
  return toDoc(doc.toObject());
}

export async function updateCampaign(id: string, patch: Partial<Pick<CampaignDoc, 'name' | 'subject' | 'preheader' | 'blocks' | 'audience' | 'paceSeconds'>>): Promise<CampaignDoc> {
  const c = await getCampaign(id);
  if (c.status === 'sending' || c.status === 'done') {
    const onlyName = Object.keys(patch).every((k) => k === 'name');
    if (!onlyName) throw new ApiError(409, c.status === 'done' ? 'This campaign has been sent — duplicate it to send another.' : 'Pause the campaign before changing it.');
  }
  await CampaignModel.updateOne({ _id: id }, { $set: patch });
  return getCampaign(id);
}

export async function duplicateCampaign(id: string, createdBy?: string): Promise<CampaignDoc> {
  const c = await getCampaign(id);
  const doc = await CampaignModel.create({ name: `${c.name} (copy)`, subject: c.subject, preheader: c.preheader, blocks: c.blocks, audience: c.audience, paceSeconds: c.paceSeconds, createdBy });
  return toDoc(doc.toObject());
}

export async function deleteCampaign(id: string): Promise<void> {
  const c = await getCampaign(id);
  if (c.status === 'sending') throw new ApiError(409, 'Pause or cancel it first.');
  if (c.status !== 'draft') throw new ApiError(409, 'Only drafts can be deleted — cancel it instead, so its history is kept.');
  await CampaignModel.deleteOne({ _id: id });
  await CampaignRecipientModel.deleteMany({ campaignId: id });
}

/**
 * Starts (or schedules) a campaign: snapshots its current audience into the queue.
 * Starting again after a pause just resumes; people added to the CRM since are not added.
 */
export async function startCampaign(id: string, opts: { sendAt?: Date } = {}): Promise<CampaignDoc> {
  const c = await getCampaign(id);
  if (c.status === 'done' || c.status === 'cancelled') throw new ApiError(409, 'This campaign is finished — duplicate it to send again.');
  if (c.status === 'sending') return c;
  if (!c.subject.trim()) throw new ApiError(400, 'Add a subject first.');
  if (!c.blocks.length) throw new ApiError(400, 'Add some content first.');

  if (c.status === 'draft') {
    const filter = await audienceFilter(c.audience);
    const leads = (await LeadModel.find(filter, { person: 1 }).lean()) as Array<{ _id: unknown; person?: { email?: string; name?: string } }>;
    if (!leads.length) throw new ApiError(400, 'Nobody matches this audience.');
    const seen = new Set<string>();
    const rows = leads
      .map((l) => ({ campaignId: id, leadId: String(l._id), email: String(l.person?.email ?? '').toLowerCase(), name: l.person?.name, status: 'queued' as const }))
      .filter((r) => r.email && !seen.has(r.email) && seen.add(r.email));
    await CampaignRecipientModel.insertMany(rows, { ordered: false }).catch((e: { code?: number }) => {
      if (e.code !== 11000) throw e;
    });
  }
  const scheduled = opts.sendAt && opts.sendAt.getTime() > Date.now() + 30_000;
  await CampaignModel.updateOne(
    { _id: id },
    { $set: { status: scheduled ? 'scheduled' : 'sending', ...(scheduled ? { sendAt: opts.sendAt } : {}), ...(c.startedAt ? {} : scheduled ? {} : { startedAt: new Date() }) }, ...(scheduled ? {} : { $unset: { sendAt: '' } }) },
  );
  return getCampaign(id);
}

export async function pauseCampaign(id: string): Promise<CampaignDoc> {
  const c = await getCampaign(id);
  if (c.status !== 'sending' && c.status !== 'scheduled') throw new ApiError(409, 'Only a sending or scheduled campaign can be paused.');
  await CampaignModel.updateOne({ _id: id }, { $set: { status: 'paused' } });
  return getCampaign(id);
}

export async function cancelCampaign(id: string): Promise<CampaignDoc> {
  const c = await getCampaign(id);
  if (c.status === 'done' || c.status === 'cancelled') return c;
  await CampaignRecipientModel.updateMany({ campaignId: id, status: 'queued' }, { $set: { status: 'skipped', error: 'Campaign cancelled' } });
  await CampaignModel.updateOne({ _id: id }, { $set: { status: 'cancelled', finishedAt: new Date() } });
  return getCampaign(id);
}

// --- Sending ----------------------------------------------------------------------------------------

/** Midnight in India time, as a Date — the daily cap resets then. */
function istDayStart(now = new Date()): Date {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60_000);
}

export async function sentToday(now = new Date()): Promise<number> {
  return CampaignRecipientModel.countDocuments({ status: 'sent', sentAt: { $gte: istDayStart(now) } });
}

/**
 * One step of the sender: starts due scheduled campaigns, then sends at most one email —
 * for the campaign that has waited longest past its pace. Returns what it did (for tests).
 */
export async function campaignTick(now = new Date()): Promise<'sent' | 'capped' | 'idle' | 'failed'> {
  await CampaignModel.updateMany({ status: 'scheduled', sendAt: { $lte: now } }, { $set: { status: 'sending', startedAt: now } });
  const sending = (await CampaignModel.find({ status: 'sending' }).sort({ lastSentAt: 1 }).lean()).map(toDoc);
  if (!sending.length) return 'idle';
  if ((await sentToday(now)) >= env.CAMPAIGN_DAILY_CAP) return 'capped';

  const windowOpen = inSendWindow(now);
  for (const c of sending) {
    // New-product announcements go out only Mon–Sat 09:00–18:00 IST; outside it they wait for the next opening.
    if (c.kind === 'product_launch' && !windowOpen) continue;
    if (c.lastSentAt && now.getTime() - new Date(c.lastSentAt).getTime() < c.paceSeconds * 1000) continue;
    // Claim one recipient atomically, so two ticks never send the same email.
    const r = await CampaignRecipientModel.findOneAndUpdate({ campaignId: c.id, status: 'queued' }, { $set: { status: 'sent', sentAt: now } }, { sort: { _id: 1 }, new: true }).lean();
    if (!r) {
      await CampaignModel.updateOne({ _id: c.id, status: 'sending' }, { $set: { status: 'done', finishedAt: now } });
      continue;
    }
    await CampaignModel.updateOne({ _id: c.id }, { $set: { lastSentAt: now } });
    try {
      await sendOne(c, r as { _id: unknown; leadId?: string; email: string; name?: string });
      return 'sent';
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0]! : String(error);
      await CampaignRecipientModel.updateOne({ _id: r._id }, { $set: { status: 'failed', error: message }, $unset: { sentAt: '' } });
      console.error(`[campaigns] ${c.name}: could not send to ${r.email}: ${message}`);
      return 'failed';
    }
  }
  return 'idle';
}

async function sendOne(c: CampaignDoc, r: { _id: unknown; leadId?: string; email: string; name?: string }): Promise<void> {
  const lead = r.leadId ? await LeadModel.findById(r.leadId).lean() : null;
  // Re-checked at send time: they may have unsubscribed since the campaign started.
  const dnc = lead?.doNotContact || (await ContactModel.exists({ email: r.email, doNotContact: true }));
  if (dnc || !lead?.person?.email) {
    await CampaignRecipientModel.updateOne({ _id: r._id }, { $set: { status: 'skipped', error: dnc ? 'Asked not to be contacted' : 'No email address any more' }, $unset: { sentAt: '' } });
    return;
  }
  const out = renderCampaign(c, recipientOfLead(lead), await renderContext(c.blocks, 'email'));
  const thread = await repositories.threads.create({
    leadId: r.leadId,
    contactEmail: r.email,
    contactName: lead.person.name,
    leadEmailSnapshot: r.email,
    subjectLine: out.subject,
    status: 'open',
    provider: 'gmail',
    messages: [],
    followUp: { attemptsSent: 0, maxAttempts: 0, replyDetected: false },
  });
  await sendOnNewThread(thread, {
    to: r.email,
    subject: out.subject,
    body: out.text,
    // Real sends only (not previews or test sends): an open image and tracked links for this recipient.
    html: addTracking(out.html, String(r._id)),
    attachments: out.attachments,
    listUnsubscribe: listUnsubscribeHeader(),
    type: 'campaign',
    draftedBy: 'human',
    sentBy: c.createdBy,
    noFollowUp: true,
  });
  await CampaignRecipientModel.updateOne({ _id: r._id }, { $set: { threadId: thread.id } });
}

let timer: NodeJS.Timeout | null = null;
let ticking = false;

export function startCampaignSender(): void {
  timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      await campaignTick();
    } catch (error) {
      console.error('[campaigns] tick failed:', error instanceof Error ? error.message : error);
    } finally {
      ticking = false;
    }
  }, 5000);
}

export function stopCampaignSender(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// --- AI copy ----------------------------------------------------------------------------------------

const COPY_PROMPT = `You write marketing email copy for Class One Systems (classonesystems.in), an Indian supplier of electrochemical research instrumentation (PalmSens potentiostats, CorrTest workstations, TOB battery equipment, thin-film equipment, electrodes and cells), writing to Indian academic researchers.

Write ONE text block for a campaign email from the brief. Rules:
- 60-140 words, 2-3 short paragraphs separated by a blank line. Plain professional tone, no hype, no exclamation marks, no emojis.
- You may use these fields, filled per recipient: {first_name}, {last_name}, {title}, {institute}, {department}. Give a fallback where it could be empty, e.g. "Dear {title|Dr.} {last_name|}".
- Mark at most one phrase in **bold**. No markdown otherwise, no headings, no sign-off (the email has its own).
- Never invent prices, discounts, dates, specifications or claims not in the brief.
- Output only the text.`;

export async function writeCampaignText(brief: string, products: string[] = []): Promise<{ text: string; model: string }> {
  if (!env.GEMINI_API_KEY) throw new ApiError(400, 'GEMINI_API_KEY is not set.');
  const { text, model } = await geminiGenerate({
    apiKey: env.GEMINI_API_KEY.trim(),
    models: geminiModels(),
    systemPrompt: COPY_PROMPT,
    userPrompt: [`Brief: ${brief}`, products.length ? `Products in this email: ${products.join(', ')}` : ''].filter(Boolean).join('\n'),
    generationConfig: { temperature: 0.6 },
    timeoutMs: 30_000,
    interactive: true,
  });
  return { text: text.trim(), model };
}

// --- Assets -----------------------------------------------------------------------------------------

export async function saveAsset(input: { filename: string; contentType: string; data: string; width?: number; height?: number; createdBy?: string }) {
  if (!/^image\/(png|jpe?g|gif|webp)$/.test(input.contentType)) throw new ApiError(400, 'Images only: PNG, JPEG, GIF or WebP.');
  const data = Buffer.from(input.data, 'base64');
  if (data.length > 1.5 * 1024 * 1024) throw new ApiError(400, 'That image is over 1.5 MB — use a smaller one.');
  const doc = await CampaignAssetModel.create({ filename: input.filename.slice(0, 120), contentType: input.contentType, data, size: data.length, width: input.width, height: input.height, createdBy: input.createdBy });
  return { id: String(doc._id), filename: doc.filename, size: data.length };
}

export async function getAsset(id: string) {
  if (!/^[a-f\d]{24}$/i.test(id)) throw ApiError.notFound('Image');
  const a = await CampaignAssetModel.findById(id).lean();
  if (!a) throw ApiError.notFound('Image');
  return a;
}
