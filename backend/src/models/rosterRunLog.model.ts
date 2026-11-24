/**
 * Every log line a roster job has ever produced — the low-level detail behind
 * `RosterRunModel`'s high-level summary. One document per line, so a run of
 * any size (tens of thousands of lines for a multi-institute pipeline) never
 * risks a single document hitting Mongo's 16MB limit, and the history page
 * can filter by level or page through a run without loading it all at once.
 */
import { Schema, model } from 'mongoose';

const rosterRunLogSchema = new Schema(
  {
    runId: { type: String, required: true, index: true },
    seq: { type: Number, required: true },
    at: { type: Date, required: true },
    level: { type: String, enum: ['info', 'warn', 'error'], required: true },
    message: { type: String, required: true },
  },
  { collection: 'roster_run_logs', minimize: false, versionKey: false },
);

rosterRunLogSchema.index({ runId: 1, seq: 1 });
rosterRunLogSchema.index({ runId: 1, level: 1, seq: 1 });

export const RosterRunLogModel = model('RosterRunLog', rosterRunLogSchema);
