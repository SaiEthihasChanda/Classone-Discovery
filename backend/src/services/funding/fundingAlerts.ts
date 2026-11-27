/**
 * Funding alerts: a researcher just got a new grant → a congratulatory note, drafted for approval.
 *
 * Once a week (Sunday from 03:00 IST) every approved lead and customer with a known OpenAlex author id
 * has their funding re-read from the acknowledgements on their recent papers (the slim works call:
 * 1 OpenAlex credit each). A grant number we have not seen for them before, sanctioned this year or
 * last, is a new-grant signal:
 *   - it is recorded (collection funding_signals) and the lead is marked (fundingAlertAt) for the CRM
 *     badge, the "New funding" filter and the Home alert;
 *   - a short note is drafted by the AI — congratulations, the paper that mentions the grant, one or two
 *     products that fit — and waits in Conversations → Needs you. It is never sent by itself.
 * Nobody is drafted for if they are marked do-not-contact, have a conversation in progress (a draft
 * waiting, a reply owed, or follow-ups scheduled), or were emailed in the last 30 days; their signal is
 * still recorded ("skipped", with the reason). The very first run only records what is already there.
 *
 * Limitation: OpenAlex learns of a grant only once a published paper acknowledges it, so "new" means
 * newly seen — often months after sanction. The sanction-year rule keeps alerts to recent grants.
 */
import { Schema, model } from 'mongoose';
import { env } from '../../config/env.js';
import { EmailThreadModel } from '../../models/emailThread.model.js';
import { FacultyMemberModel } from '../../models/facultyMember.model.js';
import { LeadModel } from '../../models/lead.model.js';
import { ProductModel } from '../../models/productCatalog.model.js';
import { getState, setState } from '../../models/systemState.model.js';
import type { FundingAcknowledgement } from '../../types/domain.js';
import { logActivity } from '../activity/activityService.js';
import { geminiGenerate, geminiModels } from '../ai/geminiProvider.js';
import { AGENCY_LABEL } from './fundingAgencies.js';

const DAY = 86_400_000;
const IST = 330 * 60_000;
/** Leads with a fresh signal show the badge for this long. */
export const ALERT_DAYS = 60;
const RECENTLY_EMAILED_DAYS = 30;

const signalSchema = new Schema(
  {
    leadId: { type: String, required: true, index: true },
    key: { type: String, required: true },
    agency: String,
    funder: String,
    awardId: String,
    scheme: String,
    year: Number,
    workTitle: String,
    workYear: Number,
    workUrl: String,
    detectedAt: { type: Date, required: true, index: true },
    /** new: waiting to be drafted · drafted: in Needs you · sent · skipped (see reason) · dismissed */
    status: { type: String, enum: ['new', 'drafted', 'sent', 'skipped', 'dismissed'], default: 'new', index: true },
    reason: String,
    threadId: String,
  },
  { collection: 'funding_signals', timestamps: true, versionKey: false },
);
signalSchema.index({ leadId: 1, key: 1 }, { unique: true });
export const FundingSignalModel = model('FundingSignal', signalSchema);

/** One grant's identity: agency + grant number. Acknowledgements without a number are not tracked. */
export const grantKey = (f: Pick<FundingAcknowledgement, 'agency' | 'awardId'>) => (f.awardId ? `${f.agency}:${f.awardId.replace(/\s+/g, '').toUpperCase()}` : null);

// --- Seams (tests) ----------------------------------------------------------------------------------
type FundingFetcher = (authorId: string, sinceYear: number) => Promise<FundingAcknowledgement[]>;
type NoteWriter = (input: { lead: Record<string, any>; grant: FundingAcknowledgement; products: string[] }) => Promise<{ subject: string; body: string; model: string } | null>;
let fetcher: FundingFetcher | null = null;
let writer: NoteWriter | null = null;
export function setFundingSeams(s: { fetcher?: FundingFetcher | null; writer?: NoteWriter | null }): void {
  if (s.fetcher !== undefined) fetcher = s.fetcher;
  if (s.writer !== undefined) writer = s.writer;
}

async function fetchFunding(authorId: string, sinceYear: number): Promise<FundingAcknowledgement[]> {
  if (fetcher) return fetcher(authorId, sinceYear);
  const { getAuthorFunding } = await import('../../integrations/openAlexClient.js');
  return getAuthorFunding({ authorId, sinceYear, maxWorks: 25 });
}

/** The OpenAlex author behind a lead: kept on the lead when it was promoted, else on its roster record. */
async function authorIdOf(lead: Record<string, any>): Promise<string | null> {
  const rec = lead.source?.sourceRecordId ?? '';
  if (/(^|\/)A\d{6,}$/.test(rec)) return rec;
  const f = (await FacultyMemberModel.findOne({ leadId: String(lead._id) }, { 'person.openAlexAuthorId': 1 }).lean()) as { person?: { openAlexAuthorId?: string } } | null;
  return f?.person?.openAlexAuthorId ?? null;
}

const grantYear = (g: FundingAcknowledgement) => g.year ?? g.workYear;

// --- The weekly check --------------------------------------------------------------------------------

export interface FundingCheckResult {
  checked: number;
  newSignals: number;
  drafted: number;
  skipped: number;
  firstRun: boolean;
}

export async function runFundingCheck(now = new Date(), opts: { limit?: number } = {}): Promise<FundingCheckResult> {
  const firstRun = !(await getState<boolean>('fundingAlertsBaseline'));
  const thisYear = new Date(now.getTime() + IST).getUTCFullYear();
  const leads = (await LeadModel.find({ status: { $in: ['approved', 'customer'] }, inPipeline: { $ne: true } }, { source: 1, research: 1 }).sort({ 'research.fundingCheckedAt': 1 }).limit(opts.limit ?? 2000).lean()) as Array<Record<string, any>>;
  const out: FundingCheckResult = { checked: 0, newSignals: 0, drafted: 0, skipped: 0, firstRun };

  for (const lead of leads) {
    const authorId = await authorIdOf(lead);
    if (!authorId) continue;
    let found: FundingAcknowledgement[];
    try {
      found = await fetchFunding(authorId, thisYear - 2);
    } catch (error) {
      console.warn(`[funding] could not read funding for lead ${String(lead._id)}:`, error instanceof Error ? error.message.split('\n')[0] : error);
      continue;
    }
    out.checked += 1;
    const known = new Set(((lead.research?.funding ?? []) as FundingAcknowledgement[]).map(grantKey).filter(Boolean));
    const fresh = found.filter((g) => g.agency !== 'other' && grantKey(g) && !known.has(grantKey(g)));
    const merged = [...((lead.research?.funding ?? []) as FundingAcknowledgement[]), ...fresh];
    await LeadModel.updateOne({ _id: lead._id }, { $set: { 'research.funding': merged, 'research.fundingCheckedAt': now } });
    if (firstRun) continue;

    const recent = fresh.filter((g) => (grantYear(g) ?? 0) >= thisYear - 1);
    for (const g of recent) {
      const r = await FundingSignalModel.updateOne(
        { leadId: String(lead._id), key: grantKey(g)! },
        { $setOnInsert: { agency: g.agency, funder: g.funder, awardId: g.awardId, scheme: g.scheme, year: g.year, workTitle: g.workTitle, workYear: g.workYear, workUrl: g.workUrl, detectedAt: now, status: 'new' } },
        { upsert: true },
      );
      if (r.upsertedCount) out.newSignals += 1;
    }
    if (recent.length) await LeadModel.updateOne({ _id: lead._id }, { $set: { fundingAlertAt: now } });
  }
  if (firstRun) await setState('fundingAlertsBaseline', true);
  const d = await draftPendingNotes(now);
  out.drafted = d.drafted;
  out.skipped = d.skipped;
  return out;
}

// --- Drafting ----------------------------------------------------------------------------------------

/** Why someone gets no note now — or null when one can be drafted. */
async function skipReason(lead: Record<string, any>, now: Date): Promise<string | null> {
  if (lead.doNotContact) return 'Asked not to be contacted';
  if (!lead.person?.email) return 'No email address';
  const threads = (await EmailThreadModel.find({ leadId: String(lead._id) }, { status: 1, awaitingReplySince: 1, 'followUp.nextCheckAt': 1, messages: { $slice: -20 } }).lean()) as Array<Record<string, any>>;
  if (threads.some((t) => t.status === 'draft' || t.awaitingReplySince || (t.status === 'open' && t.followUp?.nextCheckAt))) return 'A conversation is in progress';
  const lastOut = threads.flatMap((t) => (t.messages ?? []) as Array<{ direction: string; sentAt: Date }>).filter((m) => m.direction === 'outbound').map((m) => new Date(m.sentAt).getTime()).sort((a, b) => b - a)[0];
  if (lastOut && now.getTime() - lastOut < RECENTLY_EMAILED_DAYS * DAY) return `Emailed in the last ${RECENTLY_EMAILED_DAYS} days`;
  return null;
}

const PROMPT = `You write a short note from Class One Systems (classonesystems.in), an Indian supplier of electrochemical research instrumentation, to a researcher whose recent paper acknowledges a new research grant.
Rules:
- 70–120 words. Warm and specific; congratulate them on the grant (name the agency and scheme if given) and refer to the paper by its topic.
- Suggest at most one or two of the listed products that plausibly fit their work, by name, in one sentence. Never invent products, prices, discounts, dates or specifications.
- End with one easy question (e.g. whether new equipment is part of the project plan, or whether a short demo would help).
- Greet them with their title and last name, e.g. "Dear Dr. Rao,". Sign off as "Team Class One Systems".
Return JSON: {"subject": string, "body": string}.`;

async function writeNote(input: Parameters<NoteWriter>[0]): Promise<{ subject: string; body: string; model: string } | null> {
  if (writer) return writer(input);
  if (!env.GEMINI_API_KEY) return null;
  const { lead, grant, products } = input;
  const userPrompt = [
    `Name: ${lead.person?.name ?? ''}${lead.person?.title ? ` (${lead.person.title})` : ''}`,
    `Institution: ${[lead.institution?.department, lead.institution?.name].filter(Boolean).join(', ')}`,
    lead.research?.summary ? `Research: ${String(lead.research.summary).slice(0, 500)}` : '',
    `Grant: ${AGENCY_LABEL[grant.agency] ?? grant.funder}${grant.scheme ? ` — ${grant.scheme}` : ''}${grant.awardId ? ` (${grant.awardId})` : ''}${grantYear(grant) ? `, ${grantYear(grant)}` : ''}`,
    grant.workTitle ? `Paper acknowledging it: "${grant.workTitle}"${grant.workYear ? ` (${grant.workYear})` : ''}` : '',
    products.length ? `Products that may fit:\n${products.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const { text, model } = await geminiGenerate({ apiKey: env.GEMINI_API_KEY.trim(), models: geminiModels(), systemPrompt: PROMPT, userPrompt, generationConfig: { temperature: 0.5, responseMimeType: 'application/json' }, timeoutMs: 45_000 });
  const parsed = JSON.parse(text) as { subject?: string; body?: string };
  return parsed.subject?.trim() && parsed.body?.trim() ? { subject: parsed.subject.trim(), body: parsed.body.trim(), model } : null;
}

/** Drafts a note (one per person, for their newest grant) for every signal still waiting. */
export async function draftPendingNotes(now = new Date()): Promise<{ drafted: number; skipped: number }> {
  const pending = (await FundingSignalModel.find({ status: 'new' }).sort({ year: -1, detectedAt: -1 }).lean()) as Array<Record<string, any>>;
  const byLead = new Map<string, Array<Record<string, any>>>();
  for (const s of pending) byLead.set(s.leadId, [...(byLead.get(s.leadId) ?? []), s]);
  let drafted = 0;
  let skipped = 0;
  for (const [leadId, signals] of byLead) {
    const ids = signals.map((s) => s._id);
    const lead = (await LeadModel.findById(leadId).lean()) as Record<string, any> | null;
    if (!lead) {
      await FundingSignalModel.updateMany({ _id: { $in: ids } }, { $set: { status: 'skipped', reason: 'Lead no longer exists' } });
      continue;
    }
    const reason = await skipReason(lead, now);
    if (reason) {
      await FundingSignalModel.updateMany({ _id: { $in: ids } }, { $set: { status: 'skipped', reason } });
      skipped += 1;
      continue;
    }
    const grant = signals[0] as unknown as FundingAcknowledgement;
    const productIds = (lead.aiScoring?.recommendedProductIds ?? []) as string[];
    const products = (await ProductModel.find({ productId: { $in: productIds }, isActive: true }, { name: 1, applicationAreas: 1 }).limit(3).lean()) as Array<{ name: string; applicationAreas?: string[] }>;
    let note: { subject: string; body: string; model: string } | null = null;
    try {
      note = await writeNote({ lead, grant, products: products.map((p) => `${p.name}${p.applicationAreas?.length ? ` — ${p.applicationAreas.slice(0, 3).join(', ')}` : ''}`) });
    } catch (error) {
      console.warn(`[funding] could not draft for lead ${leadId} — tried again tomorrow:`, error instanceof Error ? error.message.split('\n')[0] : error);
    }
    if (!note) continue; // stays "new": retried on the next daily pass

    // On their latest conversation when there is one (it threads in Gmail), else a new one.
    const latest = (await EmailThreadModel.findOne({ leadId, 'messages.0': { $exists: true } }).sort({ updatedAt: -1 }).lean()) as Record<string, any> | null;
    const draft = { status: 'draft', draftType: 'grant_note', draftSubject: note.subject, draftBody: note.body, draftModel: note.model, draftCreatedAt: now };
    let threadId: string;
    if (latest) {
      await EmailThreadModel.updateOne({ _id: latest._id }, { $set: draft });
      threadId = String(latest._id);
    } else {
      const t = await EmailThreadModel.create({ leadId, contactEmail: lead.person.email, contactName: lead.person.name, leadEmailSnapshot: lead.person.email, subjectLine: note.subject, provider: 'gmail', messages: [], followUp: { attemptsSent: 0, maxAttempts: 2, replyDetected: false }, ...draft });
      threadId = String(t._id);
    }
    await FundingSignalModel.updateMany({ _id: { $in: ids } }, { $set: { status: 'drafted', threadId } });
    await logActivity({ type: 'draft_created', message: `New grant for ${lead.person?.name}: ${AGENCY_LABEL[grant.agency] ?? grant.funder}${grant.scheme ? ` ${grant.scheme}` : ''} — note drafted for approval`, relatedLeadId: leadId, relatedThreadId: threadId });
    drafted += 1;
  }
  return { drafted, skipped };
}

/** The note was sent, or its draft discarded: the signal follows. */
export async function noteThreadSettled(threadId: string, outcome: 'sent' | 'dismissed'): Promise<void> {
  await FundingSignalModel.updateMany({ threadId, status: 'drafted' }, { $set: { status: outcome } });
}

export async function listSignals(q: { status?: string; days?: number } = {}) {
  const since = new Date(Date.now() - (q.days ?? ALERT_DAYS) * DAY);
  const signals = (await FundingSignalModel.find({ detectedAt: { $gte: since }, ...(q.status ? { status: q.status } : {}) }).sort({ detectedAt: -1 }).limit(500).lean()) as Array<Record<string, any>>;
  const leads = new Map(((await LeadModel.find({ _id: { $in: [...new Set(signals.map((s) => s.leadId))] } }, { person: 1, institution: 1 }).lean()) as Array<Record<string, any>>).map((l) => [String(l._id), l]));
  return signals.map(({ _id, ...s }) => ({ id: String(_id), ...s, agencyLabel: AGENCY_LABEL[s.agency as keyof typeof AGENCY_LABEL] ?? s.funder, lead: leads.get(s.leadId) ? { name: leads.get(s.leadId)!.person?.name, institution: leads.get(s.leadId)!.institution?.name } : null }));
}

export async function dismissSignal(id: string): Promise<void> {
  await FundingSignalModel.updateOne({ _id: id }, { $set: { status: 'dismissed' } });
}

/** How many people got new funding recently — for the Home alert. */
export async function recentFundingCount(days = 7): Promise<number> {
  return (await FundingSignalModel.distinct('leadId', { detectedAt: { $gte: new Date(Date.now() - days * DAY) }, status: { $ne: 'dismissed' } })).length;
}

// --- Ticker ------------------------------------------------------------------------------------------

const istWeekKey = (now: Date) => {
  const ist = new Date(now.getTime() + IST);
  const sunday = new Date(ist.getTime() - ist.getUTCDay() * DAY);
  return sunday.toISOString().slice(0, 10);
};

/** Sundays from 03:00 IST: the weekly check. Every day: drafts for signals still waiting (e.g. after an AI outage). */
export async function fundingTick(now = new Date()): Promise<FundingCheckResult | { drafted: number; skipped: number } | null> {
  const ist = new Date(now.getTime() + IST);
  if (ist.getUTCDay() === 0 && ist.getUTCHours() >= 3 && (await getState<string>('fundingCheckWeek')) !== istWeekKey(now)) {
    await setState('fundingCheckWeek', istWeekKey(now));
    return runFundingCheck(now);
  }
  const day = ist.toISOString().slice(0, 10);
  if (ist.getUTCHours() >= 10 && (await getState<string>('fundingDraftDay')) !== day) {
    await setState('fundingDraftDay', day);
    return draftPendingNotes(now);
  }
  return null;
}

let timer: NodeJS.Timeout | null = null;
export function startFundingAlerts(): void {
  const tick = () =>
    void fundingTick()
      .then((r) => r && ('checked' in r ? console.log(`[funding] checked ${r.checked} people: ${r.newSignals} new grant(s), ${r.drafted} note(s) drafted${r.firstRun ? ' (first run — recorded only)' : ''}`) : r.drafted && console.log(`[funding] ${r.drafted} note(s) drafted`)))
      .catch((e) => console.error('[funding] failed:', e instanceof Error ? e.message : e));
  timer = setInterval(tick, 30 * 60_000);
  setTimeout(tick, 3 * 60_000);
}
export function stopFundingAlerts(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
