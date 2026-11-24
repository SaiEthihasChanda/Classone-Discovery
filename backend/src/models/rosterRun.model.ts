/**
 * Persistent record of every roster job ever run — the high-level summary.
 *
 * `jobRunner.ts` keeps jobs in memory for the live view (fast, but gone on a
 * restart, and pruned to the last 20 finished ones per kind). This collection
 * is the durable counterpart: every run, kept indefinitely, queryable from a
 * dedicated history page. The matching low-level detail (every log line) is
 * in `RosterRunLogModel`.
 */
import { Schema, model } from 'mongoose';

const rosterRunSchema = new Schema(
  {
    _id: { type: String, required: true }, // the job id (randomUUID), shared with jobRunner's in-memory JobState
    kind: { type: String, required: true, index: true },
    status: { type: String, required: true, index: true },
    stage: { type: String },
    progress: { type: Number },
    counters: { type: Schema.Types.Mixed, default: {} },
    options: { type: Schema.Types.Mixed },
    result: { type: Schema.Types.Mixed },
    error: { type: String },
    logLineCount: { type: Number, default: 0 },
    startedAt: { type: Date, required: true, index: true },
    finishedAt: { type: Date },
    /** Conveyor runs: the "run finished" email (services/pipeline/runNotifier.ts). */
    notification: {
      to: String,
      sentAt: Date,
      attempts: Number,
      error: String,
    },
  },
  { collection: 'roster_runs', minimize: false, versionKey: false },
);

export const RosterRunModel = model('RosterRun', rosterRunSchema);
