/**
 * Gemini (Google AI Studio) — free-tier experiment.
 *
 * REST API directly (no SDK dependency), same structured-output discipline as
 * OpenAI: a declared JSON schema, not free-form text, so a malformed response
 * cannot slip through and force a retry.
 *
 * Free tier has no per-token cost, so costUsd is always 0 and billable is
 * false — the budget guard never applies here. Switching to the paid tier
 * later (for its web-search grounding) means adding real PRICING and setting
 * billable true, mirroring openAiProvider.ts.
 *
 * Two things stretch the free tier's per-model request limits:
 *   - Model fallback: when the primary model is busy (5xx), out of quota (429)
 *     or gone (404), the next of GEMINI_FALLBACK_MODELS is tried, and the
 *     failing model is skipped for a while. Each result records the model that
 *     actually scored it.
 *   - Batches: enrichBatch scores several researchers in one request, sending
 *     the system prompt and catalog once. A batch whose response is unusable is
 *     split and scored one at a time; a busy / quota error is not (splitting
 *     would only hit the same limit harder).
 */
import { env } from '../../config/env.js';
import { geminiFetch } from '../../integrations/geminiFetch.js';
import type { Product } from '../../types/domain.js';
import type { DiscoveredCandidate } from '../discovery/types.js';
import type { AiProvider, EnrichmentInput, EnrichmentResult, ScoringFocus } from './types.js';
import { confirmedInstruments } from '../discovery/instrumentDetector.js';
import { LEAD_SCORING_SYSTEM_PROMPT, buildResearcherBlock, buildRunContext } from './prompts.js';

const RESULT_PROPERTIES = {
  relevance_score: { type: 'INTEGER', description: '0-100 fit for electrochemical instrumentation. Be strict.' },
  relevance_reasoning: { type: 'STRING' },
  product_relevance: { type: 'INTEGER' },
  institutional_strength: { type: 'INTEGER' },
  recency: { type: 'INTEGER' },
  engagement_potential: { type: 'INTEGER' },
  summary: { type: 'STRING', description: "2-3 sentences on the researcher's work, in plain prose." },
  topics: { type: 'ARRAY', items: { type: 'STRING' } },
  recommended_product_ids: {
    type: 'ARRAY',
    items: { type: 'STRING' },
    description: 'Product ids from the supplied catalog only. Empty if none fit.',
  },
  recommended_product_notes: { type: 'STRING' },
} as const;

const RESULT_REQUIRED = [
  'relevance_score',
  'relevance_reasoning',
  'product_relevance',
  'institutional_strength',
  'recency',
  'engagement_potential',
  'summary',
  'topics',
  'recommended_product_ids',
  'recommended_product_notes',
];

const RESPONSE_SCHEMA = { type: 'OBJECT', properties: RESULT_PROPERTIES, required: RESULT_REQUIRED } as const;

const BATCH_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    results: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { person_id: { type: 'STRING', description: 'The id given in the researcher heading, e.g. "p1".' }, ...RESULT_PROPERTIES },
        required: ['person_id', ...RESULT_REQUIRED],
      },
    },
  },
  required: ['results'],
} as const;

const BATCH_INSTRUCTION = `You will be given several researchers, each under a heading with an id ("Researcher p1", "Researcher p2", ...). Score EACH ONE INDEPENDENTLY, exactly as you would if they were the only researcher given: judge every person on their own evidence, never relative to the others in this list. Return one entry in "results" per researcher, carrying its person_id.`;

interface ParsedResult {
  person_id?: string;
  relevance_score: number;
  relevance_reasoning: string;
  product_relevance: number;
  institutional_strength: number;
  recency: number;
  engagement_potential: number;
  summary: string;
  topics: string[];
  recommended_product_ids: string[];
  recommended_product_notes: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** A non-2xx answer from Gemini; `status` tells a busy/quota error from a bad request. */
export class GeminiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GeminiHttpError';
  }
}

/** Busy (5xx) or out of quota (429): another model may answer, but the same one won't soon. */
const isCapacityError = (error: unknown) => error instanceof GeminiHttpError && (error.status === 429 || error.status >= 500);

/** How long a model is skipped after it fails this way. Shared by every provider instance. */
const COOLDOWN_MINUTES = { busy: 2, quota: 10, missing: 60 };
const cooldowns = new Map<string, number>();

/** Each model and whether it is cooling down after a failure (busy / out of quota) — for the dashboard's alerts. */
export function geminiModelStatus(): Array<{ model: string; coolingUntil?: Date }> {
  const now = Date.now();
  return geminiModels().map((model) => {
    const until = cooldowns.get(model);
    return until && until > now ? { model, coolingUntil: new Date(until) } : { model };
  });
}

/** Test seam: forget which models are cooling down. */
export function resetGeminiCooldowns(): void {
  cooldowns.clear();
}

const SINGLE_TIMEOUT_MS = 45_000;
const BATCH_TIMEOUT_MS = 90_000;

function parseModelList(list: string | undefined): string[] {
  return (list ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function catalogSummaryOf(catalog: Product[]): string {
  return catalog
    .filter((p) => p.isActive)
    .map((p) => `${p.productId}: ${p.name} — for ${p.applicationAreas.join(', ')}`)
    .join('\n');
}

function instrumentNoteOf(candidate: DiscoveredCandidate): string {
  const confirmed = confirmedInstruments(candidate.instruments);
  return confirmed.length > 0
    ? `\nInstruments in use:\n${confirmed.map((i) => `- ${i.model ?? i.brand} (${i.brand}, ${i.vendor === 'classone' ? 'Class One brand' : 'competitor'}) — ${i.evidence}`).join('\n')}`
    : '';
}

/** Primary model first, then GEMINI_FALLBACK_MODELS, without duplicates. */
export function geminiModels(primary = env.GEMINI_MODEL): string[] {
  return [...new Set([primary, ...parseModelList(env.GEMINI_FALLBACK_MODELS)])];
}

/**
 * One generateContent call, trying each model in turn while the failure is
 * the model's (busy, quota, not found). Models cooling down from a recent
 * failure go to the back of the line rather than being dropped, so a call
 * always tries every model before giving up. Shared by scoring and outreach
 * drafting, so both see the same cooldowns.
 */
export async function geminiGenerate(opts: {
  apiKey: string;
  models: string[];
  systemPrompt: string;
  userPrompt: string;
  generationConfig: Record<string, unknown>;
  timeoutMs: number;
  /** Someone is waiting on this (a button click): one try per model, no retry pauses. */
  interactive?: boolean;
}): Promise<{ text: string; model: string }> {
  const { apiKey, models, systemPrompt, userPrompt, generationConfig, timeoutMs, interactive } = opts;
  const t = Date.now();
  const ready = models.filter((m) => (cooldowns.get(m) ?? 0) <= t);
  const order = [...ready, ...models.filter((m) => !ready.includes(m))];
  let lastError: unknown;
  for (const [i, model] of order.entries()) {
    const hasNext = i < order.length - 1;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    let response: Response;
    try {
      response = await geminiFetch(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig,
          }),
        },
        timeoutMs,
        // With another model to try, leave a busy one after a single short retry.
        interactive ? [] : hasNext ? [2_000] : undefined,
      );
    } catch (error) {
      // Timed out or the connection dropped, after geminiFetch's own retries.
      // Keep an earlier answer from Google (e.g. 429 quota) as the reason: it says more than a timeout.
      if (!(lastError instanceof GeminiHttpError)) lastError = error;
      cooldowns.set(model, Date.now() + COOLDOWN_MINUTES.busy * 60_000);
      continue;
    }
    if (response.ok) {
      cooldowns.delete(model);
      const data = (await response.json()) as GeminiResponse;
      const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
      if (!text) throw new Error(`Gemini returned no content (finishReason: ${data.candidates?.[0]?.finishReason ?? 'unknown'}, ${model})`);
      return { text, model };
    }
    const body = await response.text().catch(() => '');
    // A 429 names the exhausted quota (per minute vs per day) in its details — keep that, it says when to expect relief.
    const quota = [...new Set([...body.matchAll(/"quotaId":\s*"([^"]+)"/g)].map((m) => m[1]))].join(', ');
    lastError = new GeminiHttpError(`Gemini ${response.status} ${response.statusText} (${model})${quota ? ` — quota ${quota}` : ''}: ${body.slice(0, 300)}`, response.status);
    const kind = response.status === 429 ? 'quota' : response.status === 404 ? 'missing' : response.status >= 500 ? 'busy' : null;
    if (!kind) throw lastError; // bad key, bad request: no other model will do better
    // A spent daily quota won't come back in minutes: skip that model for an hour.
    const minutes = kind === 'quota' && /PerDay/i.test(quota) ? COOLDOWN_MINUTES.missing : COOLDOWN_MINUTES[kind];
    cooldowns.set(model, Date.now() + minutes * 60_000);
  }
  throw lastError;
}

export class GeminiProvider implements AiProvider {
  readonly name: string;
  readonly billable = false;
  private readonly apiKey: string;
  /** Primary first, then the fallbacks, without duplicates. */
  readonly models: string[];

  constructor(apiKey: string, model = env.GEMINI_MODEL, fallbacks: string[] = parseModelList(env.GEMINI_FALLBACK_MODELS)) {
    this.apiKey = apiKey;
    this.name = model;
    this.models = [...new Set([model, ...fallbacks])];
  }

  private generate(userPrompt: string, schema: object, timeoutMs: number): Promise<{ text: string; model: string }> {
    return geminiGenerate({
      apiKey: this.apiKey,
      models: this.models,
      systemPrompt: LEAD_SCORING_SYSTEM_PROMPT,
      userPrompt,
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema },
      timeoutMs,
    });
  }

  private toResult(parsed: ParsedResult, catalog: Product[], model: string): EnrichmentResult {
    const validIds = new Set(catalog.map((p) => p.productId));
    const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
    return {
      relevanceScore: clamp(parsed.relevance_score),
      relevanceReasoning: parsed.relevance_reasoning,
      signals: {
        productRelevance: clamp(parsed.product_relevance),
        institutionalStrength: clamp(parsed.institutional_strength),
        recency: clamp(parsed.recency),
        engagementPotential: clamp(parsed.engagement_potential),
      },
      summary: parsed.summary,
      topics: (parsed.topics ?? []).slice(0, 10),
      recommendedProductIds: (parsed.recommended_product_ids ?? []).filter((id) => validIds.has(id)),
      recommendedProductNotes: parsed.recommended_product_notes || undefined,
      model,
      costUsd: 0,
    };
  }

  async enrich({ candidate, catalog, focus }: EnrichmentInput): Promise<EnrichmentResult> {
    const userPrompt = [buildResearcherBlock(candidate), buildRunContext(catalogSummaryOf(catalog), focus)].join('\n') + instrumentNoteOf(candidate);
    const { text, model } = await this.generate(userPrompt, RESPONSE_SCHEMA, SINGLE_TIMEOUT_MS);
    return this.toResult(JSON.parse(text) as ParsedResult, catalog, model);
  }

  /** Every input must share the catalog and focus (one scoring pass); the first input's are used. */
  async enrichBatch(inputs: EnrichmentInput[]): Promise<Array<EnrichmentResult | Error>> {
    if (inputs.length === 0) return [];
    if (inputs.length === 1) return [await this.enrich(inputs[0]!).catch((e: unknown) => toError(e))];
    const { catalog, focus } = inputs[0]! as { catalog: Product[]; focus?: ScoringFocus };
    const userPrompt = [
      BATCH_INSTRUCTION,
      ...inputs.map((input, i) => `\n=== Researcher p${i + 1} ===\n${buildResearcherBlock(input.candidate)}${instrumentNoteOf(input.candidate)}`),
      '\n=== For every researcher above ===',
      buildRunContext(catalogSummaryOf(catalog), focus),
    ].join('\n');

    let byId: Map<string, { parsed: ParsedResult; model: string }>;
    try {
      const { text, model } = await this.generate(userPrompt, BATCH_RESPONSE_SCHEMA, BATCH_TIMEOUT_MS);
      const parsed = JSON.parse(text) as { results?: ParsedResult[] };
      byId = new Map((parsed.results ?? []).map((r) => [String(r.person_id).trim().toLowerCase(), { parsed: r, model }]));
    } catch (error) {
      if (isCapacityError(error)) return inputs.map(() => toError(error));
      // Unusable response or a timeout on the big call: score them one at a time instead.
      return this.oneByOne(inputs);
    }

    const out: Array<EnrichmentResult | Error> = [];
    const missing: number[] = [];
    for (const [i, input] of inputs.entries()) {
      const hit = byId.get(`p${i + 1}`);
      if (hit) out[i] = this.toResult(hit.parsed, input.catalog, hit.model);
      else missing.push(i);
    }
    // Anyone the model left out of its answer gets their own call.
    if (missing.length) {
      const retried = await this.oneByOne(missing.map((i) => inputs[i]!));
      missing.forEach((i, k) => (out[i] = retried[k]!));
    }
    return out;
  }

  private async oneByOne(inputs: EnrichmentInput[]): Promise<Array<EnrichmentResult | Error>> {
    const out: Array<EnrichmentResult | Error> = [];
    for (const input of inputs) {
      const prev = out[out.length - 1];
      // Every model just said busy / out of quota: the rest would only hit the same wall.
      if (prev instanceof Error && isCapacityError(prev)) out.push(prev);
      else out.push(await this.enrich(input).catch((e: unknown) => toError(e)));
    }
    return out;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
