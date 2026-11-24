/**
 * Durable counterpart to the in-memory job runner (`jobRunner.ts`): every run
 * and every line it ever logs, kept in Mongo indefinitely. Backs the Faculty
 * → Runs history page — a job's in-memory record disappears on a restart and
 * is pruned after the last 20 finished runs per kind; these collections are
 * never pruned and survive restarts, which is the whole point of a run
 * history.
 *
 * Every write here is best-effort: a DB hiccup must never break a running
 * job, so writes are fire-and-forget and failures are swallowed (mirroring
 * the OpenAlex cache's own "never break the request" rule).
 */
import mongoose from 'mongoose';
import { RosterRunModel } from '../../models/rosterRun.model.js';
import { RosterRunLogModel } from '../../models/rosterRunLog.model.js';
import type { JobKind, JobLogLine, JobStatus } from './jobRunner.js';

function dbReady(): boolean {
  return mongoose.connection.readyState === 1;
}

export function recordRunStart(id: string, kind: JobKind, options: unknown): void {
  if (!dbReady()) return;
  RosterRunModel.create({ _id: id, kind, status: 'running', stage: 'starting', counters: {}, options, startedAt: new Date() }).catch(() => {
    // Best effort — the live job still runs and shows its tail without history.
  });
}

export function recordRunLog(runId: string, seq: number, line: JobLogLine): void {
  if (!dbReady()) return;
  RosterRunLogModel.create({ runId, seq, at: line.at, level: line.level, message: line.message }).catch(() => {});
}

export function recordRunProgress(id: string, patch: { stage?: string; progress?: number; counters?: Record<string, number> }): void {
  if (!dbReady()) return;
  RosterRunModel.updateOne({ _id: id }, { $set: patch }).catch(() => {});
}

export function recordRunFinish(
  id: string,
  patch: { status: JobStatus; result?: unknown; error?: string; logLineCount: number; counters: Record<string, number> },
): void {
  if (!dbReady()) return;
  RosterRunModel.updateOne({ _id: id }, { $set: { ...patch, finishedAt: new Date() } }).catch(() => {});
}

export interface RunListFilter {
  kind?: string;
  status?: string;
  page: number;
  limit: number;
}

export async function listRuns(filter: RunListFilter): Promise<{ items: unknown[]; total: number }> {
  const query: Record<string, unknown> = {};
  if (filter.kind) query.kind = filter.kind;
  if (filter.status) query.status = filter.status;
  const skip = (filter.page - 1) * filter.limit;
  const [items, total] = await Promise.all([
    RosterRunModel.find(query).sort({ startedAt: -1 }).skip(skip).limit(filter.limit).lean().exec(),
    RosterRunModel.countDocuments(query).exec(),
  ]);
  return { items, total };
}

export async function getRun(id: string): Promise<unknown | null> {
  return RosterRunModel.findById(id).lean().exec();
}

export interface RunLogFilter {
  level?: string[];
  page: number;
  limit: number;
}

export async function getRunLog(runId: string, filter: RunLogFilter): Promise<{ items: unknown[]; total: number }> {
  const query: Record<string, unknown> = { runId };
  if (filter.level?.length) query.level = { $in: filter.level };
  const skip = (filter.page - 1) * filter.limit;
  const [items, total] = await Promise.all([
    RosterRunLogModel.find(query).sort({ at: 1, seq: 1 }).skip(skip).limit(filter.limit).lean().exec(),
    RosterRunLogModel.countDocuments(query).exec(),
  ]);
  return { items, total };
}

/** The complete log as plain text, in order — for the full-run download/export. */
export async function getRunLogText(runId: string): Promise<string> {
  const lines = await RosterRunLogModel.find({ runId }).sort({ at: 1, seq: 1 }).lean().exec();
  return lines.map((l) => `${new Date(l.at).toISOString()} ${l.level.padEnd(5)} ${l.message}`).join('\n');
}
