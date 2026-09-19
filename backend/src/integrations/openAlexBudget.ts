/**
 * OpenAlex credit budget tracking.
 *
 * OpenAlex is NOT unlimited-free. Measured from live response headers:
 *
 *   X-RateLimit-Limit:            1000     credits per day
 *   X-RateLimit-Limit-USD:        0.10     USD per day, free allowance
 *   X-RateLimit-Credits-Required: 10       for a filtered /works query
 *   Reset:                        midnight UTC
 *
 * So roughly 100 filtered queries per day before requests start returning 429.
 *
 * This module exists because we hit that wall the hard way: faculty enrichment
 * issued two calls per researcher across a 58-person list — about 1160 credits,
 * more than an entire day's allowance in a single run. Worse, enrichment
 * failures are non-fatal by design, so every lead silently scored near zero
 * instead of anything visibly breaking.
 *
 * The guard below makes that failure mode loud and stops it early.
 */

export interface BudgetSnapshot {
  creditsRemaining: number | null;
  usdRemaining: number | null;
  creditsLimit: number | null;
  lastUpdated: Date | null;
  exhausted: boolean;
  /** Seconds until the daily allowance resets. */
  resetInSeconds: number | null;
}

let creditsRemaining: number | null = null;
let usdRemaining: number | null = null;
let creditsLimit: number | null = null;
let lastUpdated: Date | null = null;
let resetInSeconds: number | null = null;
let exhaustedUntil: number | null = null;

/** Reads the rate-limit headers OpenAlex returns on every response. */
export function recordBudgetHeaders(headers: Headers): void {
  const num = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const remaining = num('x-ratelimit-remaining');
  const usd = num('x-ratelimit-remaining-usd');
  const limit = num('x-ratelimit-limit');
  const reset = num('x-ratelimit-reset');

  if (remaining !== null) creditsRemaining = remaining;
  if (usd !== null) usdRemaining = usd;
  if (limit !== null) creditsLimit = limit;
  if (reset !== null) resetInSeconds = reset;
  if (remaining !== null || usd !== null) lastUpdated = new Date();
}

/** Called on a 429 so subsequent calls stop immediately rather than each retrying. */
export function markExhausted(retryAfterSeconds: number | null): void {
  const seconds = retryAfterSeconds ?? 3600;
  exhaustedUntil = Date.now() + seconds * 1000;
  creditsRemaining = 0;
  resetInSeconds = seconds;
  lastUpdated = new Date();
  console.warn(
    `[openalex] daily credit budget exhausted — resets in ${Math.round(seconds / 60)} minutes. ` +
      `Discovery will run without OpenAlex until then.`,
  );
}

/**
 * True when the budget is spent.
 *
 * Callers check this BEFORE issuing a request, so an exhausted budget short-
 * circuits instead of generating a burst of doomed calls.
 */
export function isExhausted(): boolean {
  if (exhaustedUntil === null) return false;
  if (Date.now() >= exhaustedUntil) {
    exhaustedUntil = null;
    creditsRemaining = null;
    return false;
  }
  return true;
}

/**
 * True if there is comfortably enough budget left for `estimatedCredits`.
 * A small reserve is kept so an interactive "look up this name" still works
 * after a bulk run has eaten most of the allowance.
 */
/** Credits held back so an interactive "look up this name" still works after a bulk run. */
export const DEFAULT_RESERVE = 50;

export function hasBudgetFor(estimatedCredits: number, reserve = DEFAULT_RESERVE): boolean {
  if (isExhausted()) return false;
  if (creditsRemaining === null) return true; // Nothing observed yet — allow it.
  return creditsRemaining - estimatedCredits >= reserve;
}

export function getBudgetSnapshot(): BudgetSnapshot {
  return {
    creditsRemaining,
    usdRemaining,
    creditsLimit,
    lastUpdated,
    exhausted: isExhausted(),
    resetInSeconds,
  };
}

/** Test seam. */
export function resetBudgetTracking(): void {
  creditsRemaining = null;
  usdRemaining = null;
  creditsLimit = null;
  lastUpdated = null;
  resetInSeconds = null;
  exhaustedUntil = null;
}

/** Raised when a call is skipped because the budget is gone. */
export class OpenAlexBudgetError extends Error {
  constructor() {
    const snapshot = getBudgetSnapshot();
    const mins = snapshot.resetInSeconds ? Math.round(snapshot.resetInSeconds / 60) : null;
    const when =
      mins === null ? '' : mins >= 90 ? `; resets in ~${Math.round(mins / 60)} hours` : `; resets in ~${mins} minutes`;
    const left = snapshot.creditsRemaining;
    const limit = snapshot.creditsLimit ?? 1000;
    // Two distinct situations read very differently to the person running it:
    // genuinely out, versus down to the reserve kept for by-name lookups.
    const state =
      left !== null && left > 0
        ? `OpenAlex daily credit allowance nearly used up — ${left} of ${limit} credits left, below the ${DEFAULT_RESERVE}-credit reserve kept for single lookups`
        : `OpenAlex daily credit allowance exhausted (${limit} credits per day)`;
    super(
      `${state}${when}. Topic searches cost 1 credit, keyword and brand searches 10. ` +
        'A free OpenAlex API key raises the allowance 10× (OPENALEX_API_KEY in .env); prepaid credits at https://openalex.org/pricing',
    );
    this.name = 'OpenAlexBudgetError';
  }
}
