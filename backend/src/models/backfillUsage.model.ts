/**
 * One document per calendar month (`_id` = "YYYY-MM"), counting Gemini
 * grounding (web-search backfill) requests — Google's free allowance resets
 * monthly, and this counter needs to survive a server restart to track it
 * meaningfully (unlike the OpenAlex budget, which re-syncs from live response
 * headers on first call and can safely stay in memory).
 */
import { Schema, model } from 'mongoose';

const backfillUsageSchema = new Schema(
  {
    _id: { type: String, required: true },
    count: { type: Number, default: 0 },
  },
  { collection: 'backfill_usage', minimize: false },
);

export const BackfillUsageModel = model('BackfillUsage', backfillUsageSchema);
