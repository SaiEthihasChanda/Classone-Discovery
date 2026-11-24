/**
 * The Prospects conveyor: every roster member moves through
 *   verify → score → promote → fill → done
 * on their own, a few at a time per stage, without waiting for anyone else.
 *
 * State lives on the member (`flow` in facultyMember.model.ts), so the engine
 * is restart-safe: a ticker claims work atomically (findOneAndUpdate), runs it
 * through the existing one-person-capable stage functions (`ids: [id]`), and
 * writes the next state. Nothing is held in memory but the in-flight counts.
 *
 *   Auto   — anything idle is picked up, so people flow straight through.
 *   Manual — only what a person queued ("Run next step", "Run all waiting").
 *
 * Rules (decided with the user):
 *   - verify: moved → continue (tagged); institute unknown / sources conflict → review
 *   - promote: below threshold → excluded in Auto (unless a person forced it);
 *     in Manual it waits in Scored with a note
 *   - promoted leads stay hidden from Leads (`inPipeline`) until fill is done
 *   - errors retry in 2, 10 and 30 minutes, then → failed (others keep flowing)
 *   - daily caps: scoring pauses past the OpenAlex cap; fill drops Gemini
 *     search past the Gemini cap (free sources still run)
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { FacultyMemberModel } from '../../models/facultyMember.model.js';
import { PipelineSettingsModel } from '../../models/pipeline.model.js';
import { RosterRunModel } from '../../models/rosterRun.model.js';
import { RosterRunLogModel } from '../../models/rosterRunLog.model.js';
import { repositories } from '../../repositories/index.js';
import { getBudgetSnapshot } from '../../integrations/openAlexBudget.js';
import { getBackfillTodayCount } from '../../integrations/geminiBackfillBudget.js';
import type { FlowStage, FlowState } from '../../types/domain.js';
import type { JobContext } from '../jobs/jobRunner.js';
import type { KeywordOverride } from '../roster/applicationAreas.js';
import { verifyRoster } from '../roster/rosterAffiliation.js';
import { DEFAULT_PROMOTE_THRESHOLD, promoteRoster, scoreRoster } from '../roster/rosterRelevance.js';
import { fillRoster } from '../roster/rosterFill.js';

/** The batch stage functions, run one person at a time. Replaceable in tests (`setFlowStageFns`). */
const defaultStageFns = { verifyRoster, scoreRoster, promoteRoster, fillRoster };
let stageFns = defaultStageFns;
export function setFlowStageFns(overrides: Partial<typeof defaultStageFns> | null): void {
  stageFns = overrides ? { ...defaultStageFns, ...overrides } : defaultStageFns;
}

export const STAGES: Exclude<FlowStage, 'done'>[] = ['verify', 'score', 'promote', 'fill'];
const NEXT: Record<Exclude<FlowStage, 'done'>, FlowStage> = { verify: 'score', score: 'promote', promote: 'fill', fill: 'done' };
/** People processed at once per stage — bounded by outside rate limits (fill reads web pages, politely). */
/** Units of work in flight per stage — for score a unit is a batch of AI_SCORE_BATCH_SIZE people. */
const CONCURRENCY: Record<Exclude<FlowStage, 'done'>, number> = { verify: 3, score: 2, promote: 3, fill: 1 };
const RETRY_MINUTES = [2, 10, 30];
export const BACKLOG_RUN_ID = 'flow-backlog';

// --- Settings ---------------------------------------------------------------------------------

export interface PipelineSettings {
  mode: 'manual' | 'auto';
  threshold: number;
  dailyOpenAlexCredits: number;
  dailyGeminiSearches: number;
  reverifyAfterDays: number;
}

const DEFAULT_SETTINGS: PipelineSettings = { mode: 'manual', threshold: DEFAULT_PROMOTE_THRESHOLD, dailyOpenAlexCredits: 8000, dailyGeminiSearches: 150, reverifyAfterDays: 90 };
let settingsCache: PipelineSettings | null = null;

export async function getPipelineSettings(): Promise<PipelineSettings> {
  if (settingsCache) return settingsCache;
  const doc = await PipelineSettingsModel.findOneAndUpdate({ singleton: 'pipeline' }, { $setOnInsert: { singleton: 'pipeline' } }, { upsert: true, new: true }).lean();
  settingsCache = { ...DEFAULT_SETTINGS, ...(doc as Partial<PipelineSettings>) };
  return settingsCache;
}

export async function updatePipelineSettings(patch: Partial<PipelineSettings>): Promise<PipelineSettings> {
  const doc = await PipelineSettingsModel.findOneAndUpdate({ singleton: 'pipeline' }, { $set: patch }, { upsert: true, new: true }).lean();
  settingsCache = { ...DEFAULT_SETTINGS, ...(doc as Partial<PipelineSettings>) };
  // Leaving Auto: anything not yet started waits for a person again.
  if (patch.mode === 'manual') {
    await FacultyMemberModel.updateMany({ 'flow.state': 'queued', 'flow.forced': { $ne: true } }, { $set: { 'flow.state': 'idle' } });
  }
  return settingsCache;
}

// --- Daily caps -------------------------------------------------------------------------------

export interface CapStatus {
  openAlex: { usedToday: number | null; cap: number; remaining: number | null; paused: boolean };
  gemini: { usedToday: number; cap: number; paused: boolean; keySet: boolean };
}

export async function capStatus(s?: PipelineSettings): Promise<CapStatus> {
  const settings = s ?? (await getPipelineSettings());
  const b = getBudgetSnapshot();
  const usedToday = b.creditsLimit !== null && b.creditsRemaining !== null ? b.creditsLimit - b.creditsRemaining : null;
  const geminiToday = await getBackfillTodayCount();
  return {
    openAlex: { usedToday, cap: settings.dailyOpenAlexCredits, remaining: b.creditsRemaining, paused: b.exhausted || (usedToday !== null && usedToday >= settings.dailyOpenAlexCredits) },
    gemini: { usedToday: geminiToday, cap: settings.dailyGeminiSearches, paused: geminiToday >= settings.dailyGeminiSearches, keySet: Boolean(env.GEMINI_BACKFILL_API_KEY) },
  };
}

// --- Run context (who triggered a member) -----------------------------------------------------

interface FlowRunContext {
  runId: string;
  reverifyAfterDays: number;
}
const runContext = new AsyncLocalStorage<FlowRunContext>();

/** Runs `fn` (a roster build) so every member it creates or re-finds joins the conveyor under `runId`. */
export function withFlowRun<T>(ctx: FlowRunContext, fn: () => Promise<T>): Promise<T> {
  return runContext.run(ctx, fn);
}

/** For rosterBuilder: the `flow` a member gets when a conveyor run finds them, or undefined outside one. */
export function flowForNewMember(): { stage: FlowStage; state: FlowState; runId: string; updatedAt: Date } | undefined {
  const ctx = runContext.getStore();
  return ctx ? { stage: 'verify', state: 'idle', runId: ctx.runId, updatedAt: new Date() } : undefined;
}

/**
 * For rosterBuilder: an existing member a run re-finds. Eligible people whose
 * affiliation check is stale go back to Verify; everyone else stays put.
 */
export function flowForExistingMember(member: { status: string; flow?: { stage?: string }; institution: { affiliation?: { verifiedAt?: Date } } }) {
  const ctx = runContext.getStore();
  if (!ctx || member.status !== 'eligible' || member.flow?.stage === 'verify') return undefined;
  const verifiedAt = member.institution.affiliation?.verifiedAt;
  const stale = !verifiedAt || Date.now() - new Date(verifiedAt).getTime() > ctx.reverifyAfterDays * 86_400_000;
  return stale ? { stage: 'verify' as const, state: 'idle' as const, runId: ctx.runId, updatedAt: new Date() } : undefined;
}

// --- Per-run configuration + log ---------------------------------------------------------------

interface RunConfig {
  focus?: KeywordOverride;
  threshold?: number;
  useScraper?: boolean;
  useGeminiBackfill?: boolean;
}
const runConfigCache = new Map<string, { at: number; config: RunConfig }>();

async function runConfig(runId?: string): Promise<RunConfig> {
  if (!runId || runId === BACKLOG_RUN_ID) return {};
  const hit = runConfigCache.get(runId);
  if (hit && Date.now() - hit.at < 60_000) return hit.config;
  const run = (await RosterRunModel.findById(runId).lean()) as { options?: RunConfig } | null;
  const config = run?.options ?? {};
  runConfigCache.set(runId, { at: Date.now(), config });
  return config;
}

/**
 * A JobContext for one person's step, logging into the person's run (the run's
 * single overall log). Remembers the last warning, so a step that swallowed
 * its own error (scoring does, per member) can still say what went wrong.
 */
function memberContext(runId: string, prefix: string): JobContext & { lastWarning: () => string | undefined } {
  let lastWarning: string | undefined;
  const write = (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
    if (level !== 'info') lastWarning = message.startsWith(`${prefix}: `) ? message.slice(prefix.length + 2) : message;
    RosterRunLogModel.create({ runId, seq: Date.now(), at: new Date(), level, message: `[${prefix}] ${message}` }).catch(() => {});
  };
  return { id: runId, log: write, setStage: () => {}, count: () => {}, set: () => {}, cancelled: () => false, checkpoint: () => {}, lastWarning: () => lastWarning };
}

// --- Provider outages: pause the stage, don't fail the people --------------------------------------

/**
 * An outside service saying "busy, try later" (Gemini 503 at high demand, a
 * 429 quota) is about the service, not the person: failing each person in turn
 * would burn their retries and leave hundreds marked Failed after one outage.
 * Instead the whole stage pauses with a growing back-off (2 → 30 min), the
 * person goes back to the queue with no attempt counted, and the first
 * success clears the pause.
 */
class ProviderBusyError extends Error {}
const BUSY = /\b(429|500|502|503|504)\b|service unavailable|overloaded|high demand|resource[_ ]exhausted|try again later/i;
const PAUSE_MINUTES = [2, 5, 10, 20, 30];
const stagePauses: Partial<Record<FlowStage, { until: Date; reason: string; strikes: number }>> = {};

function pauseStage(stage: FlowStage, reason: string): Date {
  const strikes = (stagePauses[stage]?.strikes ?? 0) + 1;
  const until = new Date(Date.now() + PAUSE_MINUTES[Math.min(strikes, PAUSE_MINUTES.length) - 1]! * 60_000);
  stagePauses[stage] = { until, reason, strikes };
  return until;
}

/** Stages paused right now because an outside service is busy — for /pipeline/state. */
export function activePauses(): Partial<Record<FlowStage, { until: string; reason: string }>> {
  const out: Partial<Record<FlowStage, { until: string; reason: string }>> = {};
  for (const [stage, p] of Object.entries(stagePauses)) if (p && p.until > new Date()) out[stage as FlowStage] = { until: p.until.toISOString(), reason: p.reason };
  return out;
}

// --- Transitions -------------------------------------------------------------------------------

const now = () => new Date();

async function advance(id: string, to: FlowStage, note?: string) {
  await FacultyMemberModel.updateOne(
    { _id: id },
    { $set: { 'flow.stage': to, 'flow.state': 'idle', 'flow.attempts': 0, 'flow.updatedAt': now(), ...(note ? { 'flow.note': note } : {}) }, $unset: { 'flow.nextAttemptAt': '', 'flow.lastError': '', 'flow.forced': '', ...(note ? {} : { 'flow.note': '' }) } },
  );
}

async function park(id: string, state: 'review' | 'idle', note: string) {
  await FacultyMemberModel.updateOne({ _id: id }, { $set: { 'flow.state': state, 'flow.note': note, 'flow.updatedAt': now() }, $unset: { 'flow.forced': '' } });
}

async function failOrRetry(id: string, attemptsSoFar: number, error: unknown) {
  const attempts = attemptsSoFar + 1;
  const message = error instanceof Error ? error.message : String(error);
  const retryIn = RETRY_MINUTES[attempts - 1];
  await FacultyMemberModel.updateOne(
    { _id: id },
    retryIn
      ? { $set: { 'flow.state': 'queued', 'flow.attempts': attempts, 'flow.lastError': message, 'flow.nextAttemptAt': new Date(Date.now() + retryIn * 60_000), 'flow.updatedAt': now() } }
      : { $set: { 'flow.state': 'failed', 'flow.attempts': attempts, 'flow.lastError': message, 'flow.updatedAt': now() }, $unset: { 'flow.nextAttemptAt': '' } },
  );
}

type Claimed = { _id: unknown; person: { name: string }; flow?: { runId?: string; forced?: boolean; attempts?: number } };

async function runStage(stage: Exclude<FlowStage, 'done'>, doc: Claimed, settings: PipelineSettings, caps: CapStatus): Promise<void> {
  const id = String(doc._id);
  const runId = doc.flow?.runId ?? BACKLOG_RUN_ID;
  const ctx = memberContext(runId, doc.person.name);
  const config = await runConfig(runId);
  const forced = Boolean(doc.flow?.forced);

  try {
    if (stage === 'verify') {
      await stageFns.verifyRoster({ ids: [id], freshDays: 0 }, ctx);
      const m = (await FacultyMemberModel.findById(id).lean()) as { status: string; institution?: { affiliation?: { status?: string } } } | null;
      if (!m || m.status === 'excluded') return;
      const status = m.institution?.affiliation?.status;
      if (status === 'unknown' || status === 'conflict') {
        return park(id, 'review', status === 'conflict' ? 'Sources disagree on the current institute' : "Current institute couldn't be confirmed");
      }
      return advance(id, NEXT.verify, status === 'moved' ? 'Moved to a new institute' : status === 'unverified' || !status ? 'No ORCID/OpenAlex record to verify against' : undefined);
    }

    if (stage === 'score') return runScoreBatch([doc]);

    if (stage === 'promote') {
      const threshold = forced ? 0 : (config.threshold ?? settings.threshold);
      await stageFns.promoteRoster({ ids: [id], threshold }, ctx);
      const m = (await FacultyMemberModel.findById(id).lean()) as { status: string; leadId?: string; relevance?: { score?: number } } | null;
      if (m?.status === 'promoted' && m.leadId) {
        await repositories.leads.updateById(m.leadId, { inPipeline: true });
        return advance(id, NEXT.promote);
      }
      const why = `Score ${m?.relevance?.score ?? '—'} below ${threshold}`;
      if (settings.mode === 'auto') {
        await FacultyMemberModel.updateOne({ _id: id }, { $set: { status: 'excluded', exclusionReason: `${why} (auto)`, 'flow.state': 'idle', 'flow.note': why, 'flow.updatedAt': now() } });
        ctx.log(`excluded — ${why}`);
        return;
      }
      return park(id, 'idle', `${why} — use Run next step to promote anyway`);
    }

    // fill
    const useGemini = (config.useGeminiBackfill ?? true) && caps.gemini.keySet && !caps.gemini.paused;
    await stageFns.fillRoster({ ids: [id], useScraper: config.useScraper ?? true, useGeminiBackfill: useGemini }, ctx);
    const m = (await FacultyMemberModel.findById(id).lean()) as { leadId?: string } | null;
    if (m?.leadId) await repositories.leads.updateById(m.leadId, {}, { unset: ['inPipeline'] });
    return advance(id, NEXT.fill, caps.gemini.keySet && !useGemini && (config.useGeminiBackfill ?? true) ? 'Gemini search skipped — daily cap reached' : undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ProviderBusyError || BUSY.test(message)) {
      const until = pauseStage(stage, message);
      ctx.log(`${stage} paused — service busy (${message}); back in the queue, stage resumes ${until.toISOString().slice(11, 16)} UTC`, 'warn');
      await FacultyMemberModel.updateOne({ _id: id }, { $set: { 'flow.state': 'queued', 'flow.lastError': message, 'flow.nextAttemptAt': until, 'flow.updatedAt': now() } });
      return;
    }
    ctx.log(`${stage} failed — ${message}`, 'warn');
    await failOrRetry(id, doc.flow?.attempts ?? 0, error);
  }
}

/** "Flow Person: scoring failed — Gemini 503 …: {\n …" → "Gemini 503 …" */
const failureReason = (raw: string) => raw.replace(/^(.*?: )?scoring failed — /, '').split('\n')[0]!.replace(/[:{\s]+$/, '');

/**
 * Scoring, several people per AI call (AI_SCORE_BATCH_SIZE). People from
 * different runs can carry different focus settings, so each run's people are
 * scored as their own call. Per person: scored → next stage; failed → retry
 * timer; provider busy → back in the queue with no attempt counted, and the
 * stage pauses only if nobody in the call got through.
 */
async function runScoreBatch(docs: Claimed[]): Promise<void> {
  const byRun = new Map<string, Claimed[]>();
  for (const d of docs) {
    const runId = d.flow?.runId ?? BACKLOG_RUN_ID;
    byRun.set(runId, [...(byRun.get(runId) ?? []), d]);
  }
  for (const [runId, group] of byRun) {
    const ids = group.map((d) => String(d._id));
    const ctx = memberContext(runId, group.length === 1 ? group[0]!.person.name : `Scoring ${group.length}`);
    const config = await runConfig(runId);
    let summary: { failures?: Record<string, string> } | void = undefined;
    let thrown: unknown;
    try {
      summary = await stageFns.scoreRoster({ ids, rescore: true, focus: config.focus }, ctx);
    } catch (error) {
      thrown = error;
    }
    const scored = new Set(
      ((await FacultyMemberModel.find({ _id: { $in: ids }, 'relevance.score': { $ne: null } }, { _id: 1 }).lean()) as Array<{ _id: unknown }>).map((m) => String(m._id)),
    );
    const busy: Claimed[] = [];
    let busyReason = '';
    for (const d of group) {
      const id = String(d._id);
      if (scored.has(id)) {
        await advance(id, NEXT.score);
        continue;
      }
      const raw =
        thrown !== undefined
          ? thrown instanceof Error
            ? thrown.message
            : String(thrown)
          : (summary?.failures?.[id] ?? (group.length === 1 ? ctx.lastWarning() : undefined) ?? 'Scoring did not complete — see the run log');
      const reason = failureReason(raw);
      if (BUSY.test(raw)) {
        busy.push(d);
        busyReason ||= reason;
        continue;
      }
      if (group.length > 1) ctx.log(`${d.person.name}: score failed — ${reason}`, 'warn');
      await failOrRetry(id, d.flow?.attempts ?? 0, new Error(reason));
    }
    if (scored.size > 0) delete stagePauses.score;
    if (busy.length) {
      // Someone in this call got through: the service works, just retry these shortly.
      const until = scored.size > 0 ? new Date(Date.now() + 60_000) : pauseStage('score', busyReason);
      if (scored.size === 0) ctx.log(`score paused — service busy (${busyReason}); back in the queue, stage resumes ${until.toISOString().slice(11, 16)} UTC`, 'warn');
      await FacultyMemberModel.updateMany(
        { _id: { $in: busy.map((d) => d._id) } },
        { $set: { 'flow.state': 'queued', 'flow.lastError': busyReason, 'flow.nextAttemptAt': until, 'flow.updatedAt': now() } },
      );
    }
  }
}

// --- The ticker --------------------------------------------------------------------------------

const inflight: Record<string, number> = { verify: 0, score: 0, promote: 0, fill: 0 };
let timer: NodeJS.Timeout | null = null;
let ticking = false;
let ticks = 0;
/** Every ~minute, place members that arrived outside a conveyor run (imports, batch endpoints). */
const MIGRATE_EVERY_TICKS = 20;

async function claim(stage: FlowStage, mode: 'auto' | 'manual'): Promise<Claimed | null> {
  return (await FacultyMemberModel.findOneAndUpdate(
    {
      status: { $in: ['eligible', 'promoted'] },
      'flow.stage': stage,
      'flow.state': { $in: mode === 'auto' ? ['idle', 'queued'] : ['queued'] },
      $or: [{ 'flow.nextAttemptAt': { $exists: false } }, { 'flow.nextAttemptAt': null }, { 'flow.nextAttemptAt': { $lte: now() } }],
    },
    { $set: { 'flow.state': 'processing', 'flow.startedAt': now(), 'flow.updatedAt': now() } },
    // "queued" sorts before "idle", so a person's explicit request goes first; then best scores.
    { sort: { 'flow.state': -1, 'relevance.score': -1, createdAt: 1 }, new: true },
  ).lean()) as Claimed | null;
}

/** One unit of work: a batch of up to AI_SCORE_BATCH_SIZE for scoring, one person otherwise. */
async function claimMany(stage: Exclude<FlowStage, 'done'>, mode: 'auto' | 'manual'): Promise<Claimed[]> {
  const size = stage === 'score' ? env.AI_SCORE_BATCH_SIZE : 1;
  const docs: Claimed[] = [];
  while (docs.length < size) {
    const doc = await claim(stage, mode);
    if (!doc) break;
    docs.push(doc);
  }
  return docs;
}

async function runClaimed(stage: Exclude<FlowStage, 'done'>, docs: Claimed[], settings: PipelineSettings, caps: CapStatus): Promise<void> {
  if (stage !== 'score') return runStage(stage, docs[0]!, settings, caps);
  try {
    await runScoreBatch(docs);
  } catch (error) {
    // Infrastructure trouble (database): nobody's fault — put them back for a later tick.
    console.error('[flow] score batch failed:', error instanceof Error ? error.message : error);
    await FacultyMemberModel.updateMany(
      { _id: { $in: docs.map((d) => d._id) }, 'flow.state': 'processing' },
      { $set: { 'flow.state': 'queued', 'flow.nextAttemptAt': new Date(Date.now() + 2 * 60_000), 'flow.updatedAt': now() } },
    ).catch(() => {});
  }
}

async function tick(): Promise<void> {
  if (ticking || mongoose.connection.readyState !== 1) return;
  ticking = true;
  try {
    ticks += 1;
    if (ticks % MIGRATE_EVERY_TICKS === 0) await migrateFlow();
    const settings = await getPipelineSettings();
    const caps = await capStatus(settings);
    for (const stage of STAGES) {
      if (stage === 'score' && caps.openAlex.paused) continue;
      if ((stagePauses[stage]?.until ?? 0) > now()) continue;
      while (inflight[stage]! < CONCURRENCY[stage]) {
        const docs = await claimMany(stage, settings.mode);
        if (!docs.length) break;
        inflight[stage]! += 1;
        void runClaimed(stage, docs, settings, caps).finally(() => {
          inflight[stage]! -= 1;
        });
      }
    }
  } catch (error) {
    console.error('[flow] tick failed:', error instanceof Error ? error.message : error);
  } finally {
    ticking = false;
  }
}

/**
 * Gives every member without a `flow` one, from what the old batch stages
 * already wrote — so the board's columns are right on first start. Idempotent.
 */
export async function migrateFlow(): Promise<void> {
  const none = { 'flow.stage': { $exists: false } };
  const set = (stage: FlowStage) => ({ $set: { 'flow.stage': stage, 'flow.state': 'idle', 'flow.updatedAt': now() } });
  await FacultyMemberModel.updateMany({ ...none, status: 'promoted' }, set('done'));
  await FacultyMemberModel.updateMany({ ...none, 'relevance.score': { $ne: null } }, set('promote'));
  await FacultyMemberModel.updateMany({ ...none, 'institution.affiliation.status': { $nin: ['unverified', null] } }, set('score'));
  await FacultyMemberModel.updateMany(none, set('verify'));
  // Promoted outside the conveyor (the batch endpoints the orchestrator script uses): already a lead.
  await FacultyMemberModel.updateMany({ status: 'promoted', 'flow.stage': { $in: ['verify', 'score', 'promote'] }, 'flow.state': { $ne: 'processing' } }, set('done'));
}

/** A crash mid-step leaves "processing" behind: put it back in the queue. Startup only. */
export async function recoverInterrupted(): Promise<number> {
  const stuck = await FacultyMemberModel.updateMany({ 'flow.state': 'processing' }, { $set: { 'flow.state': 'queued' } });
  return stuck.modifiedCount;
}

export async function startFlowEngine(): Promise<void> {
  await migrateFlow();
  const stuck = await recoverInterrupted();
  if (stuck) console.log(`[flow] re-queued ${stuck} interrupted step(s)`);
  await RosterRunModel.updateOne(
    { _id: BACKLOG_RUN_ID },
    // Not a job: "completed" so Run history reads it as Moving / Done from its people, never as finding.
    { $set: { status: 'completed' }, $setOnInsert: { kind: 'flow_backlog', stage: 'conveyor', counters: {}, options: { flow: true, label: 'Existing roster (backlog)' }, startedAt: now() } },
    { upsert: true },
  );
  timer = setInterval(() => void tick(), 3000);
  const s = await getPipelineSettings();
  console.log(`[flow] conveyor running — ${s.mode} mode`);
}

export function stopFlowEngine(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam: one synchronous pass, waiting for every step it starts. */
export async function runFlowOnce(): Promise<void> {
  const settings = await getPipelineSettings();
  const caps = await capStatus(settings);
  for (const stage of STAGES) {
    const jobs: Promise<void>[] = [];
    for (;;) {
      const docs = await claimMany(stage, settings.mode);
      if (!docs.length) break;
      jobs.push(runClaimed(stage, docs, settings, caps));
    }
    await Promise.all(jobs);
  }
}

export function resetPipelineSettingsCache(): void {
  settingsCache = null;
}

// --- Person actions --------------------------------------------------------------------------

/** "Redo" re-runs the step that put someone in their current column. */
const REDO: Record<FlowStage, FlowStage> = { verify: 'verify', score: 'verify', promote: 'score', fill: 'fill', done: 'fill' };

export async function memberAction(id: string, action: 'next' | 'redo' | 'retry'): Promise<void> {
  const m = (await FacultyMemberModel.findById(id).lean()) as { status: string; flow?: { stage?: FlowStage; state?: FlowState; note?: string } } | null;
  if (!m) throw Object.assign(new Error('Not found'), { status: 404 });
  if (m.status === 'excluded') throw Object.assign(new Error('Restore this person first'), { status: 400 });
  const stage = m.flow?.stage ?? 'verify';
  if (m.flow?.state === 'processing') throw Object.assign(new Error('Already in progress'), { status: 409 });
  if (action === 'next' && stage === 'done') throw Object.assign(new Error('Already in Leads'), { status: 400 });

  // "Continue anyway" on someone a step stopped for review: the person has looked and decided,
  // so they move on past that step — re-running it would only stop them again for the same reason.
  if (action === 'next' && m.flow?.state === 'review') {
    await FacultyMemberModel.updateOne(
      { _id: id },
      {
        $set: { 'flow.stage': NEXT[stage as Exclude<FlowStage, 'done'>], 'flow.state': 'queued', 'flow.attempts': 0, 'flow.updatedAt': now(), 'flow.note': `Continued by a person past: ${m.flow?.note ?? 'review'}` },
        $unset: { 'flow.nextAttemptAt': '', 'flow.lastError': '', 'flow.forced': '' },
      },
    );
    return;
  }

  const target = action === 'redo' ? REDO[stage] : stage;
  await FacultyMemberModel.updateOne(
    { _id: id },
    {
      $set: { 'flow.stage': target, 'flow.state': 'queued', 'flow.attempts': 0, 'flow.updatedAt': now(), ...(action === 'next' ? { 'flow.forced': true } : {}) },
      $unset: { 'flow.nextAttemptAt': '', 'flow.lastError': '', 'flow.note': '' },
    },
  );
}

/** Manual "Run all waiting" for one column. */
export async function queueStage(stage: Exclude<FlowStage, 'done'>): Promise<number> {
  const r = await FacultyMemberModel.updateMany(
    { status: { $in: ['eligible', 'promoted'] }, 'flow.stage': stage, 'flow.state': 'idle' },
    { $set: { 'flow.state': 'queued', 'flow.updatedAt': now() } },
  );
  return r.modifiedCount;
}
