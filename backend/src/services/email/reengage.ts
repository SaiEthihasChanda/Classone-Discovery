/**
 * Re-engagement check-ins.
 *
 * Once a day (from 10:00 IST) people who have gone quiet get a short, personal check-in drafted for
 * approval in Conversations → Needs you — never sent by itself:
 *   - approved leads and customers with an email address, not marked do-not-contact;
 *   - we have written to them before, and nothing has moved in either direction for `quietDays` (90);
 *   - someone who said "not interested" only after 180 days;
 *   - nobody with a draft waiting or follow-ups still scheduled, and nobody checked in on in the
 *     last 180 days.
 * At most `dailyMax` (10) a day, most recently quiet first. The draft goes on their latest
 * conversation (so it threads in Gmail) and mentions products added to the catalog since they last
 * heard from us. If the AI is unavailable the person is simply tried again the next day.
 */
import { env } from '../../config/env.js';
import { EmailThreadModel } from '../../models/emailThread.model.js';
import { LeadModel } from '../../models/lead.model.js';
import { ProductModel } from '../../models/productCatalog.model.js';
import { getState, setState } from '../../models/systemState.model.js';
import { logActivity } from '../activity/activityService.js';
import { geminiGenerate, geminiModels } from '../ai/geminiProvider.js';

const DAY = 86_400_000;
const IST = 330 * 60_000;
const NOT_INTERESTED_DAYS = 180;
const REPEAT_DAYS = 180;

export interface ReengageSettings {
  enabled: boolean;
  quietDays: number;
  dailyMax: number;
}

export async function getReengageSettings(): Promise<ReengageSettings> {
  const s = (await getState<Partial<ReengageSettings>>('reengageSettings')) ?? {};
  return { enabled: s.enabled ?? true, quietDays: s.quietDays ?? 90, dailyMax: s.dailyMax ?? 10 };
}

export async function setReengageSettings(patch: Partial<ReengageSettings>): Promise<ReengageSettings> {
  const next = { ...(await getReengageSettings()), ...patch };
  await setState('reengageSettings', next);
  return next;
}

export interface CheckInCandidate {
  leadId: string;
  threadId: string;
  lastAt: Date;
  lastSubject: string;
  lastIntent?: string;
}

/** Who is due a check-in now, most recently quiet first. */
export async function checkInCandidates(now: Date, s: ReengageSettings, limit: number): Promise<CheckInCandidate[]> {
  const quietBefore = new Date(now.getTime() - s.quietDays * DAY);
  const rows = (await EmailThreadModel.aggregate([
    { $match: { leadId: { $exists: true, $ne: null }, 'messages.0': { $exists: true } } },
    { $addFields: { last: { $arrayElemAt: ['$messages', -1] }, hasOut: { $in: ['outbound', '$messages.direction'] }, busy: { $or: [{ $eq: ['$status', 'draft'] }, { $and: [{ $eq: ['$status', 'open'] }, { $gt: ['$followUp.nextCheckAt', null] }] }] } } },
    { $sort: { 'last.sentAt': -1 } },
    {
      $group: {
        _id: '$leadId',
        threadId: { $first: '$_id' },
        lastAt: { $max: '$last.sentAt' },
        lastSubject: { $first: '$last.subject' },
        lastIntent: { $first: { $ifNull: ['$draftIntent', '$last.intent'] } },
        hasOut: { $max: '$hasOut' },
        busy: { $max: '$busy' },
      },
    },
    { $match: { hasOut: true, busy: false, lastAt: { $lt: quietBefore } } },
    { $sort: { lastAt: -1 } },
    { $limit: limit * 5 },
  ])) as Array<{ _id: string; threadId: unknown; lastAt: Date; lastSubject: string; lastIntent?: string }>;

  const ids = rows.map((r) => r._id).filter((id) => /^[a-f\d]{24}$/i.test(id));
  const leads = new Map(
    ((await LeadModel.find({ _id: { $in: ids }, status: { $in: ['approved', 'customer'] }, doNotContact: { $ne: true }, 'person.email': { $exists: true, $ne: '' } }, { lastCheckInAt: 1 }).lean()) as Array<{ _id: unknown; lastCheckInAt?: Date }>).map((l) => [String(l._id), l]),
  );
  const out: CheckInCandidate[] = [];
  for (const r of rows) {
    const lead = leads.get(r._id);
    if (!lead) continue;
    if (lead.lastCheckInAt && now.getTime() - new Date(lead.lastCheckInAt).getTime() < REPEAT_DAYS * DAY) continue;
    if (r.lastIntent === 'not_interested' && now.getTime() - new Date(r.lastAt).getTime() < NOT_INTERESTED_DAYS * DAY) continue;
    if (r.lastIntent === 'unsubscribe') continue;
    out.push({ leadId: r._id, threadId: String(r.threadId), lastAt: new Date(r.lastAt), lastSubject: r.lastSubject, lastIntent: r.lastIntent });
    if (out.length >= limit) break;
  }
  return out;
}

// --- Writing the check-in --------------------------------------------------------------------------

const PROMPT = `You write a short re-engagement email for Class One Systems (classonesystems.in), an Indian supplier of electrochemical research instrumentation, to a researcher we have been in touch with before but who has gone quiet.
Rules:
- 60–120 words. Warm, plain, specific; no hype, no exclamation marks, no "just checking in" cliché as the opening line.
- Refer naturally to what we last discussed (from the history given) and to their research if known.
- If new products are listed, mention at most one or two that plausibly fit their work, by name. Never invent products, prices, discounts, dates or specifications.
- End with one easy question (e.g. whether their plans have changed, or whether a short call would help).
- Greet them with their title and last name if known, e.g. "Dear Dr. Rao,". Sign off as "Team Class One Systems".
Return JSON: {"subject": string, "body": string}. Keep the subject as "Re: <previous subject>" when a previous subject is given.`;

export type CheckInWriter = (input: { lead: Record<string, any>; history: string; newProducts: string[]; lastSubject: string }) => Promise<{ subject: string; body: string; model: string } | null>;
let writer: CheckInWriter | null = null;
/** Test seam. */
export function setCheckInWriter(w: CheckInWriter | null): void {
  writer = w;
}

async function writeCheckIn(input: Parameters<CheckInWriter>[0]): Promise<{ subject: string; body: string; model: string } | null> {
  if (writer) return writer(input);
  if (!env.GEMINI_API_KEY) return null;
  const l = input.lead;
  const userPrompt = [
    `Name: ${l.person?.name ?? ''}${l.person?.title ? ` (${l.person.title})` : ''}`,
    `Institution: ${[l.institution?.department, l.institution?.name].filter(Boolean).join(', ')}`,
    l.research?.summary ? `Research: ${String(l.research.summary).slice(0, 600)}` : '',
    `Previous subject: ${input.lastSubject}`,
    `Recent history (oldest first):\n${input.history}`,
    input.newProducts.length ? `Products added since we last spoke:\n${input.newProducts.join('\n')}` : 'No new products to mention.',
  ]
    .filter(Boolean)
    .join('\n\n');
  const { text, model } = await geminiGenerate({
    apiKey: env.GEMINI_API_KEY.trim(),
    models: geminiModels(),
    systemPrompt: PROMPT,
    userPrompt,
    generationConfig: { temperature: 0.5, responseMimeType: 'application/json' },
    timeoutMs: 45_000,
  });
  const parsed = JSON.parse(text) as { subject?: string; body?: string };
  if (!parsed.subject?.trim() || !parsed.body?.trim()) return null;
  return { subject: parsed.subject.trim(), body: parsed.body.trim(), model };
}

/** Drafts check-ins for today's candidates. Returns how many were drafted. */
export async function draftCheckIns(now = new Date()): Promise<number> {
  const s = await getReengageSettings();
  if (!s.enabled) return 0;
  let made = 0;
  for (const c of await checkInCandidates(now, s, s.dailyMax)) {
    try {
      const lead = (await LeadModel.findById(c.leadId).lean()) as Record<string, any> | null;
      const thread = (await EmailThreadModel.findById(c.threadId).lean()) as Record<string, any> | null;
      if (!lead || !thread) continue;
      const history = (thread.messages as Array<{ direction: string; sentAt: Date; bodyText: string }>)
        .slice(-3)
        .map((m) => `${m.direction === 'outbound' ? 'Us' : 'Them'} (${new Date(m.sentAt).toISOString().slice(0, 10)}): ${m.bodyText.slice(0, 700)}`)
        .join('\n---\n');
      const fresh = (await ProductModel.find({ isActive: true, createdAt: { $gt: c.lastAt } }, { name: 1, applicationAreas: 1 }).limit(8).lean()) as Array<{ name: string; applicationAreas?: string[] }>;
      const draft = await writeCheckIn({ lead, history, newProducts: fresh.map((p) => `${p.name}${p.applicationAreas?.length ? ` — ${p.applicationAreas.slice(0, 3).join(', ')}` : ''}`), lastSubject: c.lastSubject });
      if (!draft) continue;
      await EmailThreadModel.updateOne(
        { _id: c.threadId },
        { $set: { status: 'draft', draftType: 'check_in', draftSubject: draft.subject, draftBody: draft.body, draftModel: draft.model, draftCreatedAt: now } },
      );
      await LeadModel.updateOne({ _id: c.leadId }, { $set: { lastCheckInAt: now } });
      await logActivity({ type: 'draft_created', message: `Check-in drafted for ${lead.person?.name ?? 'a quiet lead'} (quiet since ${c.lastAt.toISOString().slice(0, 10)})`, relatedLeadId: c.leadId, relatedThreadId: c.threadId });
      made += 1;
    } catch (error) {
      console.warn(`[check-ins] could not draft for lead ${c.leadId} — tried again tomorrow:`, error instanceof Error ? error.message.split('\n')[0] : error);
    }
  }
  return made;
}

/** The IST date (yyyy-mm-dd) — check-ins run once per date, from 10:00. */
const istDay = (now: Date) => new Date(now.getTime() + IST).toISOString().slice(0, 10);

export async function reengageTick(now = new Date()): Promise<number | null> {
  const ist = new Date(now.getTime() + IST);
  if (ist.getUTCHours() < 10 || (await getState<string>('reengageLastDay')) === istDay(now)) return null;
  await setState('reengageLastDay', istDay(now));
  return draftCheckIns(now);
}

let timer: NodeJS.Timeout | null = null;

export function startReengage(): void {
  const tick = () =>
    void reengageTick()
      .then((n) => n && console.log(`[check-ins] ${n} check-in${n === 1 ? '' : 's'} drafted for approval`))
      .catch((e) => console.error('[check-ins] failed:', e instanceof Error ? e.message : e));
  timer = setInterval(tick, 30 * 60_000);
  setTimeout(tick, 90_000);
}

export function stopReengage(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
