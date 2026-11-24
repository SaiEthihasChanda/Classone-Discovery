/**
 * fetch for the Gemini API, retrying the failures Google itself calls temporary
 * ("This model is currently experiencing high demand" — 503 UNAVAILABLE, and
 * the other 5xx) plus timeouts and dropped connections. Without this, one busy
 * moment at Google leaves a researcher unscored for the whole run.
 *
 * 4xx (bad key, quota, billing) is returned immediately — retrying can't fix it.
 * Each attempt gets its own timeout, so callers pass `timeoutMs`, not a signal.
 * A caller with another model to fall back to passes a shorter `backoffMs`, so a
 * busy model is left quickly instead of after ~20 s of retries.
 */
const RETRY_STATUS = new Set([500, 502, 503, 504]);
const BACKOFF_MS = [2_000, 5_000, 12_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function geminiFetch(url: string, init: RequestInit, timeoutMs: number, backoffMs: number[] = BACKOFF_MS): Promise<Response> {
  const BACKOFF_MS = backoffMs;
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= BACKOFF_MS.length;
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!RETRY_STATUS.has(response.status) || last) return response;
      const retryAfter = Number(response.headers.get('retry-after'));
      await response.body?.cancel().catch(() => {});
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BACKOFF_MS[attempt]! + Math.random() * 1000);
    } catch (error) {
      if (last) throw error;
      await sleep(BACKOFF_MS[attempt]! + Math.random() * 1000);
    }
  }
}
