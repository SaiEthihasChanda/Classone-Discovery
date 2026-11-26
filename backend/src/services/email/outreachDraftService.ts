/**
 * AI-drafted outreach email body — free-text generation (not the structured
 * scoring schema), on the existing free scoring key: drafting prose needs no
 * web search, so it never touches the billed backfill key.
 */
import { env } from '../../config/env.js';
import { geminiGenerate, geminiModels } from '../ai/geminiProvider.js';
import { repositories } from '../../repositories/index.js';
import type { EmailThread, Lead } from '../../types/domain.js';

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

const FOLLOW_UP_PROMPT = `You write short follow-up emails for Class One Systems (classonesystems.in), an Indian supplier of electrochemical research instrumentation (PalmSens, CorrTest, TOB battery equipment and accessories). The researcher has NOT replied to the earlier email(s) shown.

Rules:
- 60-110 words. Polite, low-pressure, no guilt-tripping ("just checking in", "did you see my email") and no exclamation marks.
- Do not repeat the earlier email. Add ONE new, useful angle tied to their work: a specific application, a product capability, or an offer (a demo, an application note, a loaner unit).
- The last follow-up (stated below) says this is the final note and leaves the door open.
- One clear call to action. Sign off as "Team Class One Systems".
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

/**
 * Drafts the next message for a lead: a first touch, or — given the thread so far — a follow-up that knows
 * what was already sent (`followUpNumber` 1 or 2, `isLast` on the final one).
 */
export async function draftOutreachEmail(
  lead: Lead,
  followUp?: { thread: EmailThread; followUpNumber: number; isLast: boolean },
  options: { interactive?: boolean } = { interactive: true },
): Promise<OutreachDraft> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set — outreach drafting needs the (free) scoring key.');

  const productIds = lead.aiScoring.recommendedProductIds ?? [];
  const products = productIds.length > 0 ? await Promise.all(productIds.map((id) => repositories.products.findByProductId(id))) : [];
  const productNames = products.filter((p): p is NonNullable<typeof p> => Boolean(p)).map((p) => p.name);

  const history = followUp
    ? [
        '',
        `This is follow-up ${followUp.followUpNumber}${followUp.isLast ? ' — the LAST one' : ''}. What was sent so far (oldest first):`,
        ...followUp.thread.messages.map((m) => `--- ${m.direction === 'outbound' ? 'We sent' : 'They wrote'} on ${new Date(m.sentAt).toDateString()} — "${m.subject}":\n${m.bodyText.slice(0, 1500)}`),
      ].join('\n')
    : '';

  // Same models and fallbacks as scoring (and the same cooldowns), so a model out of quota is skipped here too.
  const { text: body, model } = await geminiGenerate({
    apiKey: apiKey.trim(),
    models: geminiModels(),
    systemPrompt: followUp ? FOLLOW_UP_PROMPT : SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(lead, productNames) + history,
    generationConfig: { temperature: 0.4 },
    // A click waits on this: one try per model, no retry pauses (the larger fallback model can take ~20 s).
    // The background follow-up check passes interactive: false and gets the normal retries.
    timeoutMs: 30_000,
    interactive: options.interactive,
  });

  const firstSubject = followUp?.thread.subjectLine;
  const subject = firstSubject ? (firstSubject.startsWith('Re: ') ? firstSubject : `Re: ${firstSubject}`) : `Electrochemical instrumentation for ${lead.institution.name ?? 'your lab'}`;
  return { subject, body, model };
}
