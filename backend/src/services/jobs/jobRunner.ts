/**
 * In-process background jobs with progress — for work that outlives an HTTP
 * request.
 *
 * A roster build for one IIT means thousands of rate-limited ORCID lookups;
 * a relevance pass over the roster means thousands of OpenAlex calls. Neither
 * fits in a request/response, and a browser tab that closes must not abort
 * them. So a job is started, its id returned at once, and the UI polls.
 *
 * Deliberately simple: one process, in memory, one running job per kind.
 * A restart loses the progress view but not the work — every stage writes to
 * the database as it goes and is safe to re-run; it picks up where it stopped.
 */
import { randomUUID } from 'node:crypto';

export type JobKind = 'roster_build' | 'roster_verify' | 'roster_score' | 'roster_promote' | 'roster_fill';

export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobLogLine {
  at: Date;
  message: string;
  level: 'info' | 'warn' | 'error';
}

export interface JobState<TResult = unknown> {
  id: string;
  kind: JobKind;
  status: JobStatus;
  /** Free-form counters the stage updates as it goes ("orcidLookups", "membersCreated"...). */
  counters: Record<string, number>;
  /** What the job is doing right now, one line. */
  stage: string;
  /** 0..1 when the job can estimate it. */
  progress?: number;
  log: JobLogLine[];
  result?: TResult;
  error?: string;
  startedAt: Date;
  finishedAt?: Date;
  cancelRequested: boolean;
}

/** Handed to the job body: how it reports and how it learns it was cancelled. */
export interface JobContext {
  id: string;
  log: (message: string, level?: JobLogLine['level']) => void;
  setStage: (stage: string, progress?: number) => void;
  count: (name: string, by?: number) => void;
  set: (name: string, value: number) => void;
  /** True once the user asked to stop; long loops check it between items. */
  cancelled: () => boolean;
  /** Throws if cancelled — the convenient form for a loop body. */
  checkpoint: () => void;
}

export class JobCancelledError extends Error {
  constructor() {
    super('Job cancelled');
    this.name = 'JobCancelledError';
  }
}

const MAX_LOG_LINES = 400;
const KEEP_FINISHED = 20;

const jobs = new Map<string, JobState>();

function running(kind: JobKind): JobState | undefined {
  for (const j of jobs.values()) if (j.kind === kind && j.status === 'running') return j;
  return undefined;
}

/** Starts a job unless one of the same kind is already running. Returns the state immediately. */
export function startJob<TResult>(kind: JobKind, body: (ctx: JobContext) => Promise<TResult>): JobState<TResult> {
  const already = running(kind);
  if (already) {
    throw new Error(`A ${kind.replace('_', ' ')} job is already running (started ${already.startedAt.toISOString()}). Wait for it or cancel it first.`);
  }

  const state: JobState<TResult> = {
    id: randomUUID(),
    kind,
    status: 'running',
    counters: {},
    stage: 'starting',
    log: [],
    startedAt: new Date(),
    cancelRequested: false,
  };
  jobs.set(state.id, state as JobState);
  pruneFinished();

  const ctx: JobContext = {
    id: state.id,
    log: (message, level = 'info') => {
      state.log.push({ at: new Date(), message, level });
      if (state.log.length > MAX_LOG_LINES) state.log.splice(0, state.log.length - MAX_LOG_LINES);
    },
    setStage: (stage, progress) => {
      state.stage = stage;
      if (progress !== undefined) state.progress = Math.max(0, Math.min(1, progress));
    },
    count: (name, by = 1) => {
      state.counters[name] = (state.counters[name] ?? 0) + by;
    },
    set: (name, value) => {
      state.counters[name] = value;
    },
    cancelled: () => state.cancelRequested,
    checkpoint: () => {
      if (state.cancelRequested) throw new JobCancelledError();
    },
  };

  // Detached on purpose: the HTTP handler returns the id and moves on.
  void body(ctx)
    .then((result) => {
      state.result = result;
      state.status = state.cancelRequested ? 'cancelled' : 'completed';
      state.finishedAt = new Date();
      state.stage = state.status === 'cancelled' ? 'stopped by user' : 'done';
      state.progress = 1;
    })
    .catch((error: unknown) => {
      state.finishedAt = new Date();
      if (error instanceof JobCancelledError || state.cancelRequested) {
        state.status = 'cancelled';
        state.stage = 'stopped by user';
        return;
      }
      state.status = 'failed';
      state.error = error instanceof Error ? error.message : String(error);
      state.stage = 'failed';
      ctx.log(state.error, 'error');
    });

  return state;
}

export function getJob(id: string): JobState | undefined {
  return jobs.get(id);
}

/** Newest first. */
export function listJobs(kind?: JobKind): JobState[] {
  return [...jobs.values()]
    .filter((j) => !kind || j.kind === kind)
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  job.cancelRequested = true;
  job.stage = 'stopping after the current item…';
  return true;
}

function pruneFinished(): void {
  const finished = [...jobs.values()]
    .filter((j) => j.status !== 'running')
    .sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0));
  for (const j of finished.slice(KEEP_FINISHED)) jobs.delete(j.id);
}

/** Tests only. */
export function resetJobs(): void {
  jobs.clear();
}
