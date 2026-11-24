/**
 * AI-drafted outreach email body — free-text generation (not the structured
 * scoring schema), on the existing free scoring key: drafting prose needs no
 * web search, so it never touches the billed backfill key.
 */
import { env } from '../../config/env.js';
import { geminiFetch } from '../../integrations/geminiFetch.js';
import { repositories } from '../../repositories/index.js';
import type { Lead } from '../../types/domain.js';

export interface OutreachDraft {
  subject: string;
  body: string;
  model: string;
}

const SYSTEM_PROMPT = `You write short, specific first-touch sales emails for Class One Systems (classonesystems.in), an Indian supplier of electrochemical research instrumentation (PalmSens, CorrTest, TOB battery equipment and accessories).

Rules:
- 120-180 words. Plain professional tone, no hype, no exclamation marks.
- Reference the researcher's own actual work (the evidence given), specifically — never generic flattery.
- Mention at most 2 recommended products by name, and only if they are a genuine fit.
- One clear call to action: a short reply or a 15-minute call.
- Sign off as "Team Class One Systems".
- Output ONLY the email body, no subject line, no preamble, no markdown.`;

function buildUserPrompt(lead: Lead, productNames: string[]): string {
  return [
    `Researcher: ${lead.person.name}`,
    lead.person.title ? `Title: ${lead.person.title}` : '',
    lead.institution.name ? `Institution: ${lead.institution.name}` : '',
    lead.research.summary ? `Their work: ${lead.research.summary}` : '',
    lead.research.topics?.length ? `Topics: ${lead.research.topics.join(', ')}` : '',
    productNames.length > 0 ? `Recommended products: ${productNames.join(', ')}` : '',
    lead.aiScoring.relevanceReasoning ? `Why they're a fit: ${lead.aiScoring.relevanceReasoning}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function draftOutreachEmail(lead: Lead): Promise<OutreachDraft> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set — outreach drafting needs the (free) scoring key.');
  const model = env.GEMINI_MODEL;

  const productIds = lead.aiScoring.recommendedProductIds ?? [];
  const products = productIds.length > 0 ? await Promise.all(productIds.map((id) => repositories.products.findByProductId(id))) : [];
  const productNames = products.filter((p): p is NonNullable<typeof p> => Boolean(p)).map((p) => p.name);

  const prompt = buildUserPrompt(lead, productNames);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await geminiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4 },
    }),
  }, 30_000);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Gemini draft ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const body = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('\n')
    .trim();
  if (!body) throw new Error('Gemini draft returned no content');

  const subject = `Electrochemical instrumentation for ${lead.institution.name ?? 'your lab'}`;
  return { subject, body, model };
}
