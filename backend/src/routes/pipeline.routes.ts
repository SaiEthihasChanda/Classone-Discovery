/**
 * The Prospects conveyor (services/pipeline/flowEngine.ts): mode and caps,
 * live per-stage lists, per-person actions, runs and their schedules.
 *
 * Stage names here are the engine's: verify · score · promote · fill · done.
 * The board's columns are the people waiting for each of them (Found waits
 * for verify, and so on); see STAGE_FILTERS in roster.routes.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler } from '../middleware/errorHandler.js';
import { FacultyMemberModel } from '../models/facultyMember.model.js';
import { PipelineScheduleModel } from '../models/pipeline.model.js';
import {
  activePauses,
  capStatus,
  getPipelineSettings,
  memberAction,
  queueStage,
  STAGES,
  updatePipelineSettings,
} from '../services/pipeline/flowEngine.js';
import {
  listFlowRuns,
  nextRunFor,
  PipelineBusyError,
  runConfigSchema,
  scheduleSchema,
  startFlowRun,
  unknownInstitutes,
} from '../services/pipeline/pipelineRuns.js';

export const pipelineRouter = Router();

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const stageParam = z.enum(['verify', 'score', 'promote', 'fill', 'done']);
const ACTIVE = { $in: ['eligible', 'promoted'] };

/** Mode, caps and today's usage, and how many people sit in each stage in each state. */
pipelineRouter.get(
  '/state',
  asyncHandler(async (_req, res) => {
    const settings = await getPipelineSettings();
    const [caps, rows, excluded] = await Promise.all([
      capStatus(settings),
      FacultyMemberModel.aggregate([{ $match: { status: ACTIVE } }, { $group: { _id: { stage: '$flow.stage', state: '$flow.state' }, n: { $sum: 1 } } }]),
      FacultyMemberModel.countDocuments({ status: 'excluded' }),
    ]);
    const stages: Record<string, Record<string, number> & { total: number }> = {};
    for (const s of [...STAGES, 'done']) stages[s] = { total: 0 };
    for (const r of rows as Array<{ _id: { stage?: string; state?: string }; n: number }>) {
      const bucket = stages[r._id.stage ?? 'verify'] ?? (stages[r._id.stage!] = { total: 0 });
      bucket[r._id.state ?? 'idle'] = (bucket[r._id.state ?? 'idle'] ?? 0) + r.n;
      bucket.total += r.n;
    }
    res.json({ settings, caps, stages, excluded, paused: activePauses() });
  }),
);

const settingsPatch = z
  .object({
    mode: z.enum(['manual', 'auto']),
    threshold: z.number().min(0).max(100),
    dailyOpenAlexCredits: z.number().int().min(0),
    dailyGeminiSearches: z.number().int().min(0),
    reverifyAfterDays: z.number().int().min(1),
  })
  .partial();

pipelineRouter.put(
  '/settings',
  asyncHandler(async (req, res) => {
    const parsed = settingsPatch.safeParse(req.body ?? {});
    if (!parsed.success) throw ApiError.badRequest('Invalid settings', parsed.error.flatten());
    res.json({ settings: await updatePipelineSettings(parsed.data) });
  }),
);

/** What turning Auto on would set moving — shown in the confirm before switching. */
pipelineRouter.get(
  '/auto-preview',
  asyncHandler(async (_req, res) => {
    const settings = await getPipelineSettings();
    const idle = { status: ACTIVE, 'flow.state': 'idle' };
    const [verify, score, promote, fill, belowThreshold] = await Promise.all([
      FacultyMemberModel.countDocuments({ ...idle, 'flow.stage': 'verify' }),
      FacultyMemberModel.countDocuments({ ...idle, 'flow.stage': 'score' }),
      FacultyMemberModel.countDocuments({ ...idle, 'flow.stage': 'promote' }),
      FacultyMemberModel.countDocuments({ ...idle, 'flow.stage': 'fill' }),
      FacultyMemberModel.countDocuments({ ...idle, 'flow.stage': 'promote', 'relevance.score': { $lt: settings.threshold } }),
    ]);
    // Scoring costs about 1 OpenAlex credit per person (a works page); verify is free (ORCID / one cached author read).
    res.json({ waiting: { verify, score, promote, fill }, belowThreshold, threshold: settings.threshold, estimatedScoringCredits: verify + score });
  }),
);

/**
 * The View stage lists: in progress; queued — everyone who will be picked up,
 * in the order the engine picks them (flowEngine.claim: asked-for first, then
 * best score, then oldest), followed by those waiting on a retry timer; and
 * needs review / failed. In Auto everyone waiting is queued; in Manual only
 * those a person asked for are, and the rest are counted as waiting for you.
 */
pipelineRouter.get(
  '/stages/:stage',
  asyncHandler(async (req, res) => {
    const stage = stageParam.safeParse(req.params.stage);
    if (!stage.success) throw ApiError.badRequest('Unknown stage');
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const fields = { person: 1, role: 1, 'institution.name': 1, 'institution.affiliation.status': 1, 'relevance.score': 1, status: 1, flow: 1, leadId: 1 };
    const base = { status: ACTIVE, 'flow.stage': stage.data };
    const { mode } = await getPipelineSettings();
    const waitingStates = mode === 'auto' && stage.data !== 'done' ? ['queued', 'idle'] : ['queued'];
    const due = { $or: [{ 'flow.nextAttemptAt': { $exists: false } }, { 'flow.nextAttemptAt': null }, { 'flow.nextAttemptAt': { $lte: new Date() } }] };
    const [processing, ready, later, queuedTotal, review, failed, idle] = await Promise.all([
      FacultyMemberModel.find({ ...base, 'flow.state': 'processing' }, fields).sort({ 'flow.startedAt': 1 }).limit(limit).lean(),
      FacultyMemberModel.find({ ...base, 'flow.state': { $in: waitingStates }, ...due }, fields).sort({ 'flow.state': -1, 'relevance.score': -1, createdAt: 1 }).limit(limit).lean(),
      FacultyMemberModel.find({ ...base, 'flow.state': 'queued', 'flow.nextAttemptAt': { $gt: new Date() } }, fields).sort({ 'flow.nextAttemptAt': 1 }).limit(limit).lean(),
      FacultyMemberModel.countDocuments({ ...base, 'flow.state': { $in: waitingStates } }),
      FacultyMemberModel.find({ ...base, 'flow.state': 'review' }, fields).sort({ 'flow.updatedAt': -1 }).limit(limit).lean(),
      FacultyMemberModel.find({ ...base, 'flow.state': 'failed' }, fields).sort({ 'flow.updatedAt': -1 }).limit(limit).lean(),
      FacultyMemberModel.countDocuments({ ...base, 'flow.state': 'idle' }),
    ]);
    const shape = (docs: Array<Record<string, unknown> & { _id: unknown }>) => docs.map(({ _id, ...rest }) => ({ id: String(_id), ...rest }));
    res.json({
      stage: stage.data,
      processing: shape(processing),
      queued: shape([...ready, ...later].slice(0, limit)),
      queuedTotal,
      review: shape(review),
      failed: shape(failed),
      /** Waiting for a person (Manual) — in Auto these are in `queued`. */
      idleCount: mode === 'auto' ? 0 : idle,
    });
  }),
);

/** Manual mode: run this column's step for everyone waiting in it. */
pipelineRouter.post(
  '/stages/:stage/run',
  asyncHandler(async (req, res) => {
    const stage = z.enum(['verify', 'score', 'promote', 'fill']).safeParse(req.params.stage);
    if (!stage.success) throw ApiError.badRequest('Unknown stage');
    res.json({ queued: await queueStage(stage.data) });
  }),
);

pipelineRouter.post(
  '/members/:id/action',
  asyncHandler(async (req, res) => {
    const id = objectId.safeParse(req.params.id);
    const action = z.object({ action: z.enum(['next', 'redo', 'retry']) }).safeParse(req.body ?? {});
    if (!id.success || !action.success) throw ApiError.badRequest('Invalid request');
    try {
      await memberAction(id.data, action.data.action);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status) throw new ApiError(status, (error as Error).message);
      throw error;
    }
    res.json({ ok: true });
  }),
);

// --- Runs ------------------------------------------------------------------------------------

pipelineRouter.get(
  '/runs',
  asyncHandler(async (req, res) => {
    res.json({ items: await listFlowRuns(Math.min(Number(req.query.limit) || 50, 200)) });
  }),
);

pipelineRouter.post(
  '/runs',
  asyncHandler(async (req, res) => {
    const parsed = runConfigSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw ApiError.badRequest('Invalid request', parsed.error.flatten());
    const unknown = unknownInstitutes(parsed.data);
    if (unknown.length) throw ApiError.badRequest(`Unknown institute ids: ${unknown.join(', ')}`);
    try {
      const job = await startFlowRun(parsed.data, { triggeredBy: req.user?.email });
      res.status(202).json({ job: { id: job.id, status: job.status, startedAt: job.startedAt } });
    } catch (error) {
      if (error instanceof PipelineBusyError) throw new ApiError(409, error.message);
      throw error;
    }
  }),
);

// --- Schedules ---------------------------------------------------------------------------------

pipelineRouter.get(
  '/schedules',
  asyncHandler(async (_req, res) => {
    const items = await PipelineScheduleModel.find().sort({ enabled: -1, nextRunAt: 1, createdAt: -1 }).lean();
    res.json({ items: items.map(({ _id, ...s }) => ({ id: String(_id), ...s })) });
  }),
);

function checkSchedule(body: unknown) {
  const parsed = scheduleSchema.safeParse(body ?? {});
  if (!parsed.success) throw ApiError.badRequest('Invalid schedule', parsed.error.flatten());
  const unknown = unknownInstitutes(parsed.data.config);
  if (unknown.length) throw ApiError.badRequest(`Unknown institute ids: ${unknown.join(', ')}`);
  const nextRunAt = nextRunFor(parsed.data);
  if (parsed.data.type === 'once' && nextRunAt && nextRunAt.getTime() < Date.now() - 60_000) throw ApiError.badRequest('That time has already passed');
  return { ...parsed.data, enabled: parsed.data.enabled ?? true, nextRunAt };
}

pipelineRouter.post(
  '/schedules',
  asyncHandler(async (req, res) => {
    const doc = await PipelineScheduleModel.create({ ...checkSchedule(req.body), createdBy: req.user?.email });
    res.status(201).json({ id: String(doc._id) });
  }),
);

pipelineRouter.put(
  '/schedules/:id',
  asyncHandler(async (req, res) => {
    const id = objectId.safeParse(req.params.id);
    if (!id.success) throw ApiError.badRequest('Invalid id');
    const { nextRunAt, ...data } = checkSchedule(req.body);
    const updated = await PipelineScheduleModel.findByIdAndUpdate(
      id.data,
      { $set: { ...data, ...(nextRunAt && data.enabled ? { nextRunAt } : {}) }, ...(nextRunAt && data.enabled ? {} : { $unset: { nextRunAt: '' } }) },
      { new: true },
    );
    if (!updated) throw ApiError.notFound('Schedule');
    res.json({ ok: true });
  }),
);

pipelineRouter.delete(
  '/schedules/:id',
  asyncHandler(async (req, res) => {
    const id = objectId.safeParse(req.params.id);
    if (!id.success) throw ApiError.badRequest('Invalid id');
    await PipelineScheduleModel.deleteOne({ _id: id.data });
    res.json({ ok: true });
  }),
);
