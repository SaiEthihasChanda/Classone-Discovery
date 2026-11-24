/**
 * The Prospects conveyor's own persistent state: its settings (one document)
 * and scheduled triggers. Owned by services/pipeline/flowEngine.ts.
 */
import { Schema, model } from 'mongoose';

const pipelineSettingsSchema = new Schema(
  {
    singleton: { type: String, default: 'pipeline', unique: true, immutable: true },
    /** auto = everyone flows through every stage; manual = each step waits for a person. */
    mode: { type: String, enum: ['manual', 'auto'], default: 'manual' },
    // Same default as the batch promote stage (rosterRelevance.DEFAULT_PROMOTE_THRESHOLD).
    threshold: { type: Number, default: 40, min: 0, max: 100 },
    /** OpenAlex credits the conveyor may spend per UTC day before scoring pauses. */
    dailyOpenAlexCredits: { type: Number, default: 8000, min: 0 },
    /** Gemini web searches per day before fill falls back to the free sources. */
    dailyGeminiSearches: { type: Number, default: 150, min: 0 },
    /** A re-run re-verifies existing people whose affiliation check is older than this. */
    reverifyAfterDays: { type: Number, default: 90, min: 1 },
  },
  { collection: 'pipeline_settings', timestamps: true },
);

export const PipelineSettingsModel = model('PipelineSettings', pipelineSettingsSchema);

const pipelineScheduleSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    /** The run configuration — same shape as POST /api/pipeline/runs. */
    config: { type: Schema.Types.Mixed, required: true },
    type: { type: String, enum: ['once', 'recurring'], required: true },
    /** type=once: the moment to run. */
    runAt: Date,
    /** type=recurring: weekdays 0 (Sun) – 6 (Sat) and a 24h "HH:MM" time, in IST. */
    weekdays: { type: [Number], default: undefined },
    time: String,
    enabled: { type: Boolean, default: true },
    nextRunAt: { type: Date, index: true },
    lastRunAt: Date,
    lastRunId: String,
    lastRunLate: Boolean,
    lastError: String,
    createdBy: String,
  },
  { collection: 'pipeline_schedules', timestamps: true },
);

export const PipelineScheduleModel = model('PipelineSchedule', pipelineScheduleSchema);
