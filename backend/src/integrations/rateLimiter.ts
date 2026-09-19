/**
 * Client-side rate limiting for outbound APIs.
 *
 * Added after a real failure: faculty enrichment issues two OpenAlex calls per
 * researcher (author lookup, then recent works), four at a time across a
 * 58-person faculty list. That burst blew past OpenAlex's polite-pool allowance
 * and every request came back 429 — which silently degraded lead scores, because
 * enrichment failures are non-fatal by design.
 *
 * Retry-with-backoff alone cannot fix sustained over-rate traffic; it makes it
 * worse. The traffic has to be shaped at the source.
 */

/** Serialises calls so no more than `ratePerSecond` are issued, FIFO. */
export class RateLimiter {
  private readonly minIntervalMs: number;
  private queue: Promise<void> = Promise.resolve();
  private lastCallAt = 0;

  constructor(ratePerSecond: number) {
    this.minIntervalMs = 1000 / ratePerSecond;
  }

  /**
   * Resolves when it is this caller's turn.
   *
   * Chaining onto a single promise is what makes this correct under concurrency:
   * without it, N callers would all read the same `lastCallAt` and fire together,
   * which is exactly the bug this class exists to prevent.
   */
  async acquire(): Promise<void> {
    const wait = this.queue.then(async () => {
      const sinceLast = Date.now() - this.lastCallAt;
      if (sinceLast < this.minIntervalMs) {
        await new Promise((resolve) => setTimeout(resolve, this.minIntervalMs - sinceLast));
      }
      this.lastCallAt = Date.now();
    });

    // Swallow rejections on the chain so one failure cannot wedge the queue.
    this.queue = wait.catch(() => undefined);
    return wait;
  }
}

/**
 * OpenAlex allows roughly 10 requests/second in the polite pool (i.e. when a
 * contact email is supplied). Half of that leaves headroom for other clients on
 * the same IP and for the burstiness of parallel discovery sources.
 */
export const openAlexLimiter = new RateLimiter(5);
