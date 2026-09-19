/**
 * OpenAI-backed enrichment.
 *
 * Uses structured outputs (a strict JSON schema) rather than free-form text, so
 * the model cannot return prose that then fails to parse — which would cost a
 * retry, i.e. real money, on every malformed response.
 *
 * Cost discipline built in here:
 *   - the cheap model does this work; the strong model is reserved for
 *     first-touch outreach drafts in Phase 4
 *   - evidence text is truncated before it is sent, since tokens are the cost
 *   - the catalog is sent as a compact list of slugs and application areas
 *     rather than full product records
 */
import OpenAI from 'openai';
import { env } from '../../config/env.js';
import type { AiProvider, EnrichmentInput, EnrichmentResult } from './types.js';

/**
 * USD per 1M tokens. Used for the run budget guard, not billing.
 * Update if OpenAI changes pricing — the guard is only as good as these numbers.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
};

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    relevance_score: {
      type: 'integer',
      description: '0-100 fit for electrochemical instrumentation. Be strict.',
    },
    relevance_reasoning: { type: 'string' },
    product_relevance: { type: 'integer' },
    institutional_strength: { type: 'integer' },
    recency: { type: 'integer' },
    engagement_potential: { type: 'integer' },
    summary: {
      type: 'string',
      description: "2-3 sentences on the researcher's work, in plain prose.",
    },
    topics: { type: 'array', items: { type: 'string' } },
    recommended_product_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Product ids from the supplied catalog only. Empty if none fit.',
    },
    recommended_product_notes: { type: 'string' },
  },
  required: [
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
  ],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You qualify sales leads for Class One Systems (classonesystems.in), which supplies research instrumentation to institutions in India:
- Sensing: PalmSens potentiostats/galvanostats with EIS (PalmSens4, EmStat4S/4T/4X/4R, Nexus), multi-channel systems (MultiPalmSens4, MultiEmStat4, RackMount 16CH), OEM modules (EmStat Pico, EmStat4M), wireless/wearable biosensor potentiostats (Sensit BT/Smart/Wearable), spectroelectrochemistry, corrosion and educational application kits, and SDKs (Python, MATLAB, LabVIEW, .NET, MethodSCRIPT).
- Energy: CorrTest electrochemical workstations (CS-series, bipotentiostats, 5 A high-current, EIS) for corrosion and battery research; TOB battery-making and testing equipment (coin-cell crimpers and cutters, pouch-cell presses, winding machines, ball mills, glove boxes, solid-state split cells).
- Nano technology: sputter and thermal evaporation coaters, pulsed laser deposition, quartz crystal microbalance, RF plasma generators.
- Accessories: reference, working and counter electrodes (Ag/AgCl, SCE, RHE, Pt, glassy carbon), specimen clamps, MEA cells, glass cells.

Score how likely a researcher is to BUY THIS EQUIPMENT.

Be strict. A high score requires evidence they actually do electrochemical measurement — voltammetry, impedance spectroscopy, electrocatalysis, battery/corrosion/biosensor characterisation. A researcher in an adjacent field who merely mentions "electrode" or "catalysis" is a weak lead, not a strong one. When the evidence is thin, score low and say why: a false positive wastes a salesperson's time and risks emailing someone irrelevant.

Score each signal 0-100:
- product_relevance: does their work require this equipment?
- institutional_strength: research capacity and funding of their institution
- recency: how current is the evidence
- engagement_potential: how reachable and likely to respond

Recommend products ONLY by id from the supplied catalog. If nothing fits, return an empty list rather than guessing.

If "Instruments in use" is supplied, treat it as strong evidence: a researcher already running a Gamry, Autolab, BioLogic, CH Instruments or Admiral potentiostat is a proven buyer of this equipment category (a competitive-displacement or second-instrument opportunity); one already using PalmSens or CorrTest is an existing Class One brand user (an upgrade, multi-channel or accessory opportunity). Mention the instrument and the implied opportunity in the reasoning.`;

export class OpenAiProvider implements AiProvider {
  readonly name: string;
  readonly billable = true;
  private readonly client: OpenAI;

  constructor(apiKey: string, model = env.OPENAI_MODEL_CHEAP) {
    this.client = new OpenAI({ apiKey });
    this.name = model;
  }

  async enrich({ candidate, catalog }: EnrichmentInput): Promise<EnrichmentResult> {
    // Compact catalog representation — full product records would multiply the
    // input tokens on every single candidate for no gain in answer quality.
    const catalogSummary = catalog
      .filter((p) => p.isActive)
      .map((p) => `${p.productId}: ${p.name} — for ${p.applicationAreas.join(', ')}`)
      .join('\n');

    const userPrompt = [
      `Researcher: ${candidate.name}`,
      candidate.title ? `Position: ${candidate.title}` : '',
      candidate.institutionName ? `Institution: ${candidate.institutionName}` : '',
      candidate.topics.length > 0 ? `Indexed topics: ${candidate.topics.join(', ')}` : '',
      candidate.publications.length > 0
        ? `Recent publications:\n${candidate.publications.map((p) => `- ${p.title} (${p.year ?? 'n.d.'})`).join('\n')}`
        : '',
      candidate.grants.length > 0
        ? `Recent grants:\n${candidate.grants.map((g) => `- ${g.title} (${g.agency ?? '?'}, ${g.amount ? `$${g.amount}` : 'amount unknown'})`).join('\n')}`
        : '',
      (candidate.instruments?.length ?? 0) > 0
        ? `Instruments in use:\n${candidate.instruments!.map((i) => `- ${i.model ?? i.brand} (${i.brand}, ${i.vendor === 'classone' ? 'Class One brand' : 'competitor'}) — ${i.evidence}`).join('\n')}`
        : '',
      '',
      `Evidence text:\n${candidate.evidenceText.slice(0, 1500)}`,
      '',
      `Product catalog:\n${catalogSummary}`,
    ]
      .filter(Boolean)
      .join('\n');

    const completion = await this.client.chat.completions.create({
      model: this.name,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'lead_qualification', strict: true, schema: RESPONSE_SCHEMA },
      },
      temperature: 0.2,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned an empty response');

    const parsed = JSON.parse(content) as {
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
    };

    // Trust but verify: a hallucinated product id would create a CRM record
    // pointing at a product that does not exist.
    const validIds = new Set(catalog.map((p) => p.productId));
    const recommendedProductIds = parsed.recommended_product_ids.filter((id) =>
      validIds.has(id),
    );

    const usage = completion.usage;
    const pricing = PRICING[this.name] ?? PRICING['gpt-4o-mini']!;
    const costUsd =
      ((usage?.prompt_tokens ?? 0) / 1_000_000) * pricing.input +
      ((usage?.completion_tokens ?? 0) / 1_000_000) * pricing.output;

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
      topics: parsed.topics.slice(0, 10),
      recommendedProductIds,
      recommendedProductNotes: parsed.recommended_product_notes || undefined,
      model: this.name,
      costUsd,
    };
  }
}
