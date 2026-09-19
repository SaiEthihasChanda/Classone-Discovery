/**
 * Shared HTTP helper for outbound API calls.
 *
 * Every external integration goes through this so timeouts, retries and
 * User-Agent identification are consistent rather than reinvented per client.
 */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: unknown;
}

const USER_AGENT = 'ClassOneSalesBot/1.0 (academic lead research)';

/**
 * Fetches JSON with a timeout and bounded retries.
 *
 * Retries only on network errors and 5xx/429 — never on 4xx, which means the
 * request itself was wrong and retrying just wastes the remote server's time.
 */
export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const { timeoutMs = 20_000, retries = 2, headers = {}, method = 'GET', body } = options;

  let lastError: Error = new Error('Request never attempted');

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const retryable = response.status >= 500 || response.status === 429;
        const error = new HttpError(
          response.status,
          `${method} ${url} failed: ${response.status} ${response.statusText}`,
        );
        if (!retryable || attempt === retries) throw error;
        lastError = error;
      } else {
        return (await response.json()) as T;
      }
    } catch (error) {
      // A 4xx thrown above must not be retried.
      if (error instanceof HttpError && error.status < 500 && error.status !== 429) {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === retries) break;
    }

    // Exponential backoff: 500ms, 1s, 2s…
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }

  throw lastError;
}
