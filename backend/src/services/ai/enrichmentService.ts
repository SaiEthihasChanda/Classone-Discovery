/**
 * Enrichment orchestration: provider selection, caching and the budget guard.
 *
 * The three cost controls from the plan live here, because they only work if
 * every enrichment call goes through one place:
 *
 *   1. Provider selection — no OpenAI key means the free heuristic, not a crash.
 *   2. Content-hash caching — a professor who resurfaces every weekly run is not
 *      re-enriched every week. This is the single biggest saver, since the same
 *      person legitimately appears from several sources.
 *   3. A per-run budget ceiling that stops the run and raises a critical alert
 *      rather than quietly draining the account.
 */
import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import type { Lead, Product } from '../../types/domain.js';
import type { DiscoveredCandidate } from '../discovery/types.js';
import { HeuristicProvider } from './heuristicProvider.js';
import { OpenAiProvider } from './openAiProvider.js';
import type { AiProvider, EnrichmentResult } from './types.js';

let cachedProvider: AiProvider | null = null;

/**
 * Returns the configured provider.
 *
 * Falling back to the heuristic rather than throwing is deliberate: discovery
 * staying functional (and free) without a key is more useful than a hard failure,
 * and it makes the pipeline testable end to end.
 */
export function getAiProvider(): AiProvider {
  if (cachedProvider) return cachedProvider;

  const key = env.OPENAI_API_KEY?.trim();
  if (key && key !== 'sk-REPLACE_ME') {
    cachedProvider = new OpenAiProvider(key, env.OPENAI_MODEL_CHEAP);
    console.log(`[ai] using OpenAI (${env.OPENAI_MODEL_CHEAP})`);
  } else {
    cachedProvider = new HeuristicProvider();
    console.log('[ai] no OPENAI_API_KEY set — using the free keyword heuristic');
  }

  return cachedProvider;
}

/** Test seam: lets a test force a provider without setting env vars. */
export function setAiProvider(provider: AiProvider | null): void {
  cachedProvider = provider;
}

/**
 * Fingerprints the source material an enrichment was derived from.
 *
 * Keyed on publication and grant ids rather than the prose, so re-fetching the
 * same record with trivially different whitespace does not force a re-run, while
 * a genuinely new paper does.
 */
export function computeContentHash(candidate: DiscoveredCandidate): string {
  const material = [
    candidate.publications.map((p) => p.sourceId ?? p.title).sort().join('|'),
    candidate.grants.map((g) => g.sourceId ?? g.title).sort().join('|'),
    candidate.topics.slice().sort().join('|'),
  ].join('::');

  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** How long an enrichment stays fresh when the source material has not changed. */
const CACHE_TTL_DAYS = 30;

/**
 * True if an existing lead already has a good-enough enrichment.
 *
 * Both conditions must hold: the source material is unchanged AND the score is
 * recent. New publications invalidate immediately; otherwise the result is
 * reused for 30 days.
 */
export function isEnrichmentFresh(lead: Lead, newContentHash: string): boolean {
  const { contentHash } = lead.research;
  const { scoredAt } = lead.aiScoring;

  if (!contentHash || !scoredAt) return false;
  if (contentHash !== newContentHash) return false;

  const ageDays = (Date.now() - new Date(scoredAt).getTime()) / (1000 * 60 * 60 * 24);
  return ageDays < CACHE_TTL_DAYS;
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly spentUsd: number,
    public readonly limitUsd: number,
  ) {
    super(
      `Run budget exceeded: $${spentUsd.toFixed(4)} spent against a $${limitUsd.toFixed(2)} ceiling`,
    );
    this.name = 'BudgetExceededError';
  }
}

/**
 * Tracks spend across a single discovery run and enforces the ceiling.
 *
 * Checked BEFORE each call rather than after, so the limit cannot be overshot by
 * a large final request.
 */
export class BudgetTracker {
  private spent = 0;

  constructor(private readonly limitUsd: number = env.OPENAI_RUN_BUDGET_USD) {}

  get spentUsd(): number {
    return this.spent;
  }

  assertWithinBudget(): void {
    if (this.spent >= this.limitUsd) {
      throw new BudgetExceededError(this.spent, this.limitUsd);
    }
  }

  record(costUsd: number): void {
    this.spent += costUsd;
  }
}

export interface EnrichOptions {
  catalog: Product[];
  budget: BudgetTracker;
  provider?: AiProvider;
}

/** Enriches one candidate, respecting the budget guard. */
export async function enrichCandidate(
  candidate: DiscoveredCandidate,
  options: EnrichOptions,
): Promise<EnrichmentResult> {
  const provider = options.provider ?? getAiProvider();

  if (provider.billable) {
    options.budget.assertWithinBudget();
  }

  const result = await provider.enrich({ candidate, catalog: options.catalog });
  options.budget.record(result.costUsd);

  return result;
}
