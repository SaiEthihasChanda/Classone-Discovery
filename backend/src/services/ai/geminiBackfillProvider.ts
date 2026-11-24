/**
 * Gemini-grounded backfill: fills missing lead fields (email, title,
 * department, phone, website) via live web search, for leads ORCID and the
 * scraper (`rosterFill.ts`) could not complete.
 *
 * Needs billing enabled — confirmed live against this project's free-tier key:
 * the `googleSearch` grounding tool returns 429 RESOURCE_EXHAUSTED on a
 * non-billed key. `GEMINI_BACKFILL_API_KEY` is deliberately a SECOND key from
 * `GEMINI_API_KEY` (the scoring key), so scoring stays on the free tier.
 *
 * Asks for a fixed line-per-field answer rather than Gemini's JSON
 * `responseSchema` mode: that mode combined with the grounding tool is
 * unverified here (no billed key existed yet to test it against), so this
 * takes the documented-safe path instead — plain text, parsed with an
 * explicit, strict line format.
 */
import { ApiError } from '../../middleware/errorHandler.js';
import { geminiFetch } from '../../integrations/geminiFetch.js';
import { env } from '../../config/env.js';
import { repositories } from '../../repositories/index.js';
import type { Lead } from '../../types/domain.js';
import { logActivity } from '../activity/activityService.js';
import { recordBackfillRequest } from '../../integrations/geminiBackfillBudget.js';
import { EMAIL_RE } from '../leads/webEnrichment.js';

/** Mirrors `rosterFill.ts`'s `Fillable` — duplicated rather than imported to
 *  avoid a circular import (`rosterFill.ts` calls into this module). */
export type BackfillField = 'email' | 'title' | 'department' | 'phone' | 'websiteUrl';

export function stillMissing(lead: Lead): BackfillField[] {
  const out: BackfillField[] = [];
  if (!lead.person.email) out.push('email');
  if (!lead.person.title) out.push('title');
  if (!lead.institution.department) out.push('department');
  if (!lead.person.phone) out.push('phone');
  if (!lead.person.websiteUrl) out.push('websiteUrl');
  return out;
}

const FIELD_LABEL: Record<BackfillField, string> = {
  email: 'EMAIL',
  title: 'TITLE',
  department: 'DEPARTMENT',
  phone: 'PHONE',
  websiteUrl: 'WEBSITE',
};

const FIELD_HINT: Record<BackfillField, string> = {
  email: 'their personal or institutional email address — not a department/office address',
  title: 'their current academic title or position, e.g. "Associate Professor"',
  department: 'their department or school name',
  phone: 'a direct phone number, if published',
  websiteUrl: 'their personal or lab homepage URL',
};

function buildPrompt(lead: Lead, need: BackfillField[]): string {
  return [
    'Find current, verifiable contact and position details for this researcher using web search. ' +
      'Only report what a real source confirms — write UNKNOWN rather than guessing.',
    '',
    `Name: ${lead.person.name}`,
    lead.institution.name ? `Institution: ${lead.institution.name}` : '',
    lead.institution.department ? `Known department: ${lead.institution.department}` : '',
    lead.person.title ? `Known title: ${lead.person.title}` : '',
    '',
    'Report exactly these fields, one per line, in this order, each as "LABEL: value" with no other text:',
    ...need.map((f) => `${FIELD_LABEL[f]} — ${FIELD_HINT[f]}`),
    'SOURCES — the URLs you used, comma-separated',
  ]
    .filter(Boolean)
    .join('\n');
}

function parseLine(text: string, label: string): string | undefined {
  const re = new RegExp(`^\\s*${label}\\s*[:\\-]\\s*(.+)$`, 'im');
  const value = text.match(re)?.[1]?.trim();
  if (!value || /^unknown$/i.test(value)) return undefined;
  return value;
}

interface GeminiGroundedResponse {
  text: string;
  sources: string[];
}

/** The live network call — its own function so tests can inject a fake one. */
async function callGemini(prompt: string, apiKey: string, model: string): Promise<GeminiGroundedResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await geminiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0.1 },
    }),
  }, 45_000);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 429 && /RESOURCE_EXHAUSTED/.test(body)) {
      throw new Error(
        'Gemini grounding was refused (429 RESOURCE_EXHAUSTED) — this means GEMINI_BACKFILL_API_KEY either is not set, ' +
          "or doesn't have billing enabled yet. Web-search grounding is not available on the free tier.",
      );
    }
    throw new Error(`Gemini backfill ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string } }> };
      finishReason?: string;
    }>;
  };
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('\n');
  if (!text) {
    throw new Error(`Gemini backfill returned no content (finishReason: ${candidate?.finishReason ?? 'unknown'})`);
  }
  const sources = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((c) => c.web?.uri)
    .filter((u): u is string => Boolean(u));

  return { text, sources };
}

export interface GeminiBackfillDeps {
  apiKey?: string;
  model?: string;
  generate?: typeof callGemini;
}

export interface GeminiBackfillResult {
  lead: Lead;
  filled: BackfillField[];
  sources: string[];
}

export async function backfillLeadFromGemini(leadId: string, deps: GeminiBackfillDeps = {}): Promise<GeminiBackfillResult> {
  const apiKey = deps.apiKey ?? env.GEMINI_BACKFILL_API_KEY;
  if (!apiKey) {
    throw new ApiError(
      400,
      'GEMINI_BACKFILL_API_KEY is not set — web-search backfill needs a second, billed Gemini key ' +
        '(grounding is unavailable on the free scoring key). See the cost estimate for what this costs.',
    );
  }
  const model = deps.model ?? env.GEMINI_BACKFILL_MODEL;

  const lead = await repositories.leads.findById(leadId);
  if (!lead) throw ApiError.notFound('Lead');

  const need = stillMissing(lead);
  if (need.length === 0) return { lead, filled: [], sources: [] };

  const prompt = buildPrompt(lead, need);
  const { text, sources: groundingSources } = await (deps.generate ?? callGemini)(prompt, apiKey, model);
  await recordBackfillRequest();

  const person: Record<string, string> = {};
  const institution: Record<string, string> = {};
  const filled: BackfillField[] = [];

  for (const f of need) {
    const raw = parseLine(text, FIELD_LABEL[f]);
    if (!raw) continue;
    if (f === 'email') {
      if (!EMAIL_RE.test(raw.toLowerCase())) continue; // guard against prose instead of an address
      person.email = raw.toLowerCase();
    } else if (f === 'department') {
      institution.department = raw;
    } else {
      person[f] = raw;
    }
    filled.push(f);
  }

  const sourcesLine = parseLine(text, 'SOURCES');
  const sources =
    groundingSources.length > 0
      ? groundingSources
      : (sourcesLine?.split(',').map((s) => s.trim()).filter(Boolean) ?? []);

  if (filled.length === 0) return { lead, filled: [], sources };

  const updated =
    (await repositories.leads.updateById(lead.id, {
      ...(Object.keys(person).length > 0 ? { person } : {}),
      ...(Object.keys(institution).length > 0 ? { institution } : {}),
    })) ?? lead;

  await logActivity({
    type: 'lead_discovered',
    message: `Gemini web-search backfill — ${lead.person.name}: filled ${filled.join(', ')}`,
    relatedLeadId: lead.id,
    metadata: { geminiBackfill: true, sources },
  });

  return { lead: updated, filled, sources };
}
