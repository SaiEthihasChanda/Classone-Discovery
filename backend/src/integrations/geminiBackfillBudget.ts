/**
 * Cost-awareness counter for Gemini grounding (web-search backfill) requests.
 *
 * Unlike the OpenAlex budget, exceeding this never blocks a call — Google just
 * starts billing $14 per 1,000 requests past the free monthly allowance, which
 * is the whole point of being on the paid tier. This only tracks spend so the
 * UI can say the real number before a run, the same "say the cost before you
 * run it" rule `instrumentScan.ts`'s `estimateScanCredits` already follows.
 */
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { BackfillUsageModel } from '../models/backfillUsage.model.js';

const PRICE_PER_REQUEST_OVER_FREE_USD = 0.014;

export interface BackfillUsage {
  monthKey: string;
  count: number;
  freeAllowance: number;
  overFreeAllowance: boolean;
  estimatedMonthCostUsd: number;
}

function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function dbReady(): boolean {
  return mongoose.connection.readyState === 1;
}

function toUsage(count: number): BackfillUsage {
  const freeAllowance = env.GEMINI_BACKFILL_MONTHLY_FREE_SEARCHES;
  const billedCount = Math.max(0, count - freeAllowance);
  return {
    monthKey: monthKey(),
    count,
    freeAllowance,
    overFreeAllowance: count > freeAllowance,
    estimatedMonthCostUsd: billedCount * PRICE_PER_REQUEST_OVER_FREE_USD,
  };
}

/**
 * Increments this month's counter and returns the running total — best effort,
 * since a DB hiccup must never block a backfill call over a counter write.
 */
function dayKey(d = new Date()): string {
  return `day:${d.toISOString().slice(0, 10)}`;
}

/** Grounding requests made today (UTC) — the conveyor's daily Gemini cap reads this. */
export async function getBackfillTodayCount(): Promise<number> {
  if (!dbReady()) return 0;
  try {
    const doc = await BackfillUsageModel.findById(dayKey()).lean();
    return (doc as { count?: number } | null)?.count ?? 0;
  } catch {
    return 0;
  }
}

export async function recordBackfillRequest(): Promise<BackfillUsage> {
  if (!dbReady()) return toUsage(0);
  BackfillUsageModel.updateOne({ _id: dayKey() }, { $inc: { count: 1 } }, { upsert: true }).catch(() => {});
  try {
    const doc = await BackfillUsageModel.findByIdAndUpdate(
      monthKey(),
      { $inc: { count: 1 } },
      { upsert: true, new: true },
    ).lean();
    return toUsage((doc as { count?: number } | null)?.count ?? 0);
  } catch {
    return toUsage(0);
  }
}

export async function getBackfillUsage(): Promise<BackfillUsage> {
  if (!dbReady()) return toUsage(0);
  try {
    const doc = await BackfillUsageModel.findById(monthKey()).lean();
    return toUsage((doc as { count?: number } | null)?.count ?? 0);
  } catch {
    return toUsage(0);
  }
}
