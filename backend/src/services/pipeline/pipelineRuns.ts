/**
 * Conveyor runs and their schedules.
 *
 * A run is a roster build whose people join the conveyor as they are found
 * (flowEngine's `withFlowRun`), so the first person found can be in Leads
 * before the last one is. The run's options — focus areas, threshold, sources,
 * Gemini fill — are kept on its RosterRun record and read by the engine for
 * each of its people; its log is that record's one overall log.
 *
 * Schedules fire runs at a date-time (once) or on weekdays at a time
 * (recurring), in India time. A run missed while the server was off fires
 * once when it is back, marked late — never once per missed occurrence.
 */
import { z } from 'zod';
import { INDIAN_INSTITUTIONS } from '../../data/indianInstitutions.js';
import { FacultyMemberModel } from '../../models/facultyMember.model.js';
import { PipelineScheduleModel } from '../../models/pipeline.model.js';
import { RosterRunModel } from '../../models/rosterRun.model.js';
import { listJobs, startJob, type JobState } from '../jobs/jobRunner.js';
import { buildRoster } from '../roster/rosterBuilder.js';
import { BACKLOG_RUN_ID, getPipelineSettings, withFlowRun } from './flowEngine.js';
export const runConfigSchema = z.object({
  /** Shown in Run history and on scheduled runs. */
  label: z.string().trim().max(120).optional(),
  institutionIds: z.array(z.string()).min(1).max(100),
  sources: z.array(z.enum(['orcid', 'openalex', 'faculty_pages', 'vidwan'])).min(1).optional(),
  includeInferredRoles: z.boolean().optional(),
  minWorks: z.number().int().min(1).max(100).optional(),
  threshold: z.number().min(0).max(100).optional(),
  useScraper: z.boolean().optional(),
  useGeminiBackfill: z.boolean().optional(),
  focus: z
    .object({
      items: z.array(z.string().trim().min(1).max(300)).min(1).max(100),
      as: z.enum(['keywords', 'applicationAreas']),
      mode: z.enum(['add', 'only']),
    })
    .optional(),
});
export type RunConfig = z.infer<typeof runConfigSchema>;

export class PipelineBusyError extends Error {}

export function unknownInstitutes(config: RunConfig): string[] {
  return config.institutionIds.filter((id) => !INDIAN_INSTITUTIONS.some((i) => i.openAlexId === id));
}

/**
 * Starts a conveyor run now. Throws PipelineBusyError while another roster build is running.
 * `notifyEmail` gets the "run finished" email (runNotifier.ts): the person who pressed
 * Run, or who made the schedule.
 */
export async function startFlowRun(config: RunConfig, meta: { triggeredBy?: string; notifyEmail?: string; scheduleId?: string; late?: boolean } = {}): Promise<JobState> {
  if (listJobs('roster_build').some((j) => j.status === 'running')) {
    throw new PipelineBusyError('Another run is still finding people — wait for it to finish, or schedule this one for later.');
  }
  const settings = await getPipelineSettings();
  const { label, threshold, useScraper, useGeminiBackfill, focus, ...build } = config;
  return startJob(
    'roster_build',
    (ctx) => withFlowRun({ runId: ctx.id, reverifyAfterDays: settings.reverifyAfterDays }, () => buildRoster(build, ctx)),
    { flow: true, label, ...config, ...meta },
  );
}

export interface RunPeople {
  total: number;
  inLeads: number;
  excluded: number;
  /** Still to be picked up or mid-step — in Auto that includes everyone waiting in a column. */
  moving: number;
  /** Needs review or failed. */
  attention: number;
  /** Manual mode: waiting in a column for a person to move them on. */
  waiting: number;
}

/** Where each run's people are now. */
export async function peopleByRun(ids: string[], mode: 'auto' | 'manual'): Promise<Map<string, RunPeople>> {
  const active = { $ne: ['$status', 'excluded'] };
  // In Auto an idle person short of done is only between steps — the engine picks them up next tick.
  const pending = mode === 'auto'
    ? { $or: [{ $in: ['$flow.state', ['queued', 'processing']] }, { $and: [{ $eq: ['$flow.state', 'idle'] }, { $ne: ['$flow.stage', 'done'] }] }] }
    : { $in: ['$flow.state', ['queued', 'processing']] };
  const waiting = mode === 'auto' ? false : { $and: [{ $eq: ['$flow.state', 'idle'] }, { $ne: ['$flow.stage', 'done'] }] };
  const rows = (await FacultyMemberModel.aggregate([
    // People already on the roster before the conveyor carry no runId: they belong to the backlog run.
    { $match: { $or: [{ 'flow.runId': { $in: ids } }, { 'flow.runId': { $exists: false }, 'flow.stage': { $exists: true } }] } },
    {
      $group: {
        _id: { $ifNull: ['$flow.runId', BACKLOG_RUN_ID] },
        total: { $sum: 1 },
        inLeads: { $sum: { $cond: [{ $and: [{ $eq: ['$flow.stage', 'done'] }, active] }, 1, 0] } },
        excluded: { $sum: { $cond: [{ $eq: ['$status', 'excluded'] }, 1, 0] } },
        moving: { $sum: { $cond: [{ $and: [pending, active] }, 1, 0] } },
        attention: { $sum: { $cond: [{ $and: [{ $in: ['$flow.state', ['review', 'failed']] }, active] }, 1, 0] } },
        waiting: { $sum: { $cond: [{ $and: [waiting, active] }, 1, 0] } },
      },
    },
  ])) as Array<RunPeople & { _id: string }>;
  return new Map(rows.map(({ _id, ...people }) => [_id, people]));
}

const NO_PEOPLE: RunPeople = { total: 0, inLeads: 0, excluded: 0, moving: 0, attention: 0, waiting: 0 };

/** Conveyor runs, newest first, with where their people are now. */
export async function listFlowRuns(limit = 50) {
  const runs = (await RosterRunModel.find({ $or: [{ 'options.flow': true }] }).sort({ startedAt: -1 }).limit(limit).lean()) as Array<{ _id: string } & Record<string, unknown>>;
  const { mode } = await getPipelineSettings();
  const byRun = await peopleByRun(runs.map((r) => r._id), mode);
  return runs.map((r) => {
    const people = byRun.get(r._id) ?? NO_PEOPLE;
    // Finding is done when the build job is; the run is done once nobody of it is mid-step.
    const flowing = r.status === 'running' || people.moving > 0;
    return { ...r, people, flowing };
  });
}

// --- Schedules ---------------------------------------------------------------------------------

const IST_OFFSET_MS = 330 * 60_000;

export const scheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    config: runConfigSchema,
    type: z.enum(['once', 'recurring']),
    runAt: z.coerce.date().optional(),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).optional(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((s) => (s.type === 'once' ? Boolean(s.runAt) : Boolean(s.weekdays?.length && s.time)), {
    message: 'A one-off schedule needs runAt; a recurring one needs weekdays and time',
  });
export type ScheduleInput = z.infer<typeof scheduleSchema>;

/** Next weekday-and-time occurrence (India time) strictly after `after`. */
export function nextRecurring(weekdays: number[], time: string, after = new Date()): Date | undefined {
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const ist = new Date(after.getTime() + IST_OFFSET_MS); // wall clock in IST, read through the UTC getters
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + offset, hh, mm));
    const at = new Date(day.getTime() - IST_OFFSET_MS);
    if (at > after && weekdays.includes(day.getUTCDay())) return at;
  }
  return undefined;
}

export function nextRunFor(s: { type: string; runAt?: Date | null; weekdays?: number[] | null; time?: string | null }, after = new Date()): Date | undefined {
  if (s.type === 'once') return s.runAt ?? undefined;
  return s.weekdays?.length && s.time ? nextRecurring(s.weekdays, s.time, after) : undefined;
}

/** How late a run may start and still not count as "started late". */
const LATE_AFTER_MS = 2 * 60_000;
const BUSY_RETRY_MS = 5 * 60_000;

export async function fireDueSchedules(now = new Date(), start: typeof startFlowRun = startFlowRun): Promise<number> {
  const due = await PipelineScheduleModel.find({ enabled: true, nextRunAt: { $lte: now } }).lean();
  let fired = 0;
  for (const s of due) {
    const late = now.getTime() - new Date(s.nextRunAt!).getTime() > LATE_AFTER_MS;
    try {
      const job = await start(s.config as RunConfig, { triggeredBy: `schedule:${s.name}`, notifyEmail: s.createdBy ?? undefined, scheduleId: String(s._id), late });
      const next = s.type === 'recurring' ? nextRunFor(s as never, now) : undefined;
      await PipelineScheduleModel.updateOne(
        { _id: s._id },
        {
          $set: { lastRunAt: now, lastRunId: job.id, lastRunLate: late, ...(s.type === 'once' ? { enabled: false } : {}), ...(next ? { nextRunAt: next } : {}) },
          $unset: { lastError: '', ...(next ? {} : { nextRunAt: '' }) },
        },
      );
      fired += 1;
    } catch (error) {
      const busy = error instanceof PipelineBusyError;
      await PipelineScheduleModel.updateOne(
        { _id: s._id },
        busy
          ? { $set: { nextRunAt: new Date(now.getTime() + BUSY_RETRY_MS), lastError: 'Waiting — another run is still finding people' } }
          : { $set: { lastError: error instanceof Error ? error.message : String(error), enabled: s.type === 'recurring', ...(s.type === 'recurring' ? { nextRunAt: nextRunFor(s as never, now) } : {}) } },
      );
    }
  }
  return fired;
}

let scheduleTimer: NodeJS.Timeout | null = null;

export function startScheduleTicker(): void {
  const tick = () => void fireDueSchedules().catch((e) => console.error('[schedules] tick failed:', e instanceof Error ? e.message : e));
  tick(); // fires anything missed while the server was off
  scheduleTimer = setInterval(tick, 30_000);
}

export function stopScheduleTicker(): void {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = null;
}
