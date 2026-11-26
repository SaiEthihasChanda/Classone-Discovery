/**
 * Reads one incoming mail and decides what it is and what to say back.
 *
 * One Gemini call (structured JSON) through the shared `geminiGenerate`, so it
 * uses the same models, fallbacks and cooldowns as scoring and drafting. The
 * AI sees the mail, the conversation so far, what we know about the lead, and
 * the product catalog — and is told to answer from the catalog only, never to
 * invent prices, and to leave anything it can't answer to the team. Whatever it
 * drafts waits for a person's approval (outreachService.approveAndSendOutreach).
 */
import { env } from '../../config/env.js';
import type { EmailThread, InboundIntent, Lead, Product } from '../../types/domain.js';
import { geminiGenerate, geminiModels } from '../ai/geminiProvider.js';

export interface InboundMail {
  from: string;
  fromName?: string;
  subject: string;
  bodyText: string;
  receivedAt: Date;
}

export interface TriageResult {
  intent: InboundIntent;
  summary: string;
  urgency: 'low' | 'normal' | 'high';
  productIds: string[];
  /** From the signature — used to create a lead for a sender we don't know. */
  contact: { name?: string; title?: string; institution?: string; department?: string; phone?: string };
  shouldReply: boolean;
  replyBody?: string;
  /** Out-of-office: the date they say they're back (YYYY-MM-DD), if given. */
  outOfOfficeUntil?: Date;
  model: string;
}

export const INTENTS: InboundIntent[] = ['product_enquiry', 'quote_request', 'support_request', 'meeting_request', 'not_interested', 'unsubscribe', 'out_of_office', 'other'];

const SYSTEM_PROMPT = `You handle the sales inbox of Class One Systems (classonesystems.in), an Indian supplier of electrochemical research instrumentation: PalmSens potentiostats (EmStat, PalmSens4, multi-channel, OEM, Sensit wearables), CorrTest workstations, TOB battery-making equipment, thin-film/nano equipment, electrodes and cells.

For the incoming email, decide:
- intent: product_enquiry (asks about a product, capability or suitability), quote_request (asks for price, quotation, proforma, delivery time), support_request (problem with an instrument they own, installation, software, calibration, service), meeting_request (asks for a call, demo or visit), not_interested (declines), unsubscribe (asks not to be emailed again), out_of_office (automatic absence reply), other.
- summary: one sentence, what they want.
- urgency: high if something is broken/blocking or a deadline is stated, low for out-of-office and not_interested, else normal.
- product_ids: ids from the supplied catalog that the mail is about or that fit the request. Empty if none.
- contact: name, title, institution, department, phone as written in the mail or its signature ("" when absent).
- should_reply: false for unsubscribe and out_of_office; true otherwise.
- reply_body: when should_reply, a reply for a person on the sales team to review and send.
- out_of_office_until: for out_of_office, the return date as YYYY-MM-DD if stated, else "".

Reply rules:
- 60-160 words, plain professional tone, no exclamation marks, no markdown. Address them by name if known.
- Format: greeting line, then 2-3 short paragraphs, then the sign-off — separate each with a blank line (use \\n\\n).
- Answer ONLY from the product catalog and the facts given. Never invent prices, delivery times, specifications, compatibility or stock. The catalog lists products and application areas only — it has NO specifications — so any specific technical question (frequency range, current/voltage limits, whether a booster or accessory is needed, software versions) must NOT be answered with a yes/no or a number: restate each question so they know it was understood, and say our applications team will confirm it.
- quote_request: thank them, confirm the products, ask for anything missing to quote (quantity, configuration/accessories, delivery location, GST/billing details), and say a formal quotation will follow.
- support_request: acknowledge the problem, ask for the instrument model, serial number, software version and a short description or screenshot of the error, and say a support engineer will get back to them.
- meeting_request: welcome it and ask for two or three convenient times; offer an online demo.
- not_interested: a short, gracious closing that leaves the door open; no further pitch.
- Sign off as "Team Class One Systems".`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: { type: 'STRING', enum: INTENTS },
    summary: { type: 'STRING' },
    urgency: { type: 'STRING', enum: ['low', 'normal', 'high'] },
    product_ids: { type: 'ARRAY', items: { type: 'STRING' } },
    contact: {
      type: 'OBJECT',
      properties: { name: { type: 'STRING' }, title: { type: 'STRING' }, institution: { type: 'STRING' }, department: { type: 'STRING' }, phone: { type: 'STRING' } },
      required: ['name', 'title', 'institution', 'department', 'phone'],
    },
    should_reply: { type: 'BOOLEAN' },
    reply_body: { type: 'STRING' },
    out_of_office_until: { type: 'STRING' },
  },
  required: ['intent', 'summary', 'urgency', 'product_ids', 'contact', 'should_reply', 'reply_body', 'out_of_office_until'],
} as const;

function buildPrompt(mail: InboundMail, lead: Lead | null, thread: EmailThread | null, catalog: Product[]): string {
  const history = (thread?.messages ?? [])
    .slice(-6)
    .map((m) => `--- ${m.direction === 'outbound' ? 'We sent' : 'They wrote'} (${new Date(m.sentAt).toDateString()}) "${m.subject}":\n${m.bodyText.slice(0, 1200)}`)
    .join('\n');
  return [
    `Incoming email from: ${mail.fromName ? `${mail.fromName} <${mail.from}>` : mail.from}`,
    `Received: ${mail.receivedAt.toISOString().slice(0, 10)}`,
    `Subject: ${mail.subject}`,
    `Body:\n${mail.bodyText.slice(0, 4000)}`,
    '',
    lead
      ? [
          'What we know about this person (a lead in our CRM):',
          `Name: ${lead.person.name}${lead.person.title ? `, ${lead.person.title}` : ''}`,
          lead.institution.name ? `Institution: ${lead.institution.name}${lead.institution.department ? `, ${lead.institution.department}` : ''}` : '',
          lead.research.summary ? `Their work: ${lead.research.summary.slice(0, 600)}` : '',
          lead.aiScoring.recommendedProductIds?.length ? `Products we previously thought fit: ${lead.aiScoring.recommendedProductIds.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : 'This sender is not yet in our CRM.',
    history ? `\nConversation so far (oldest first):\n${history}` : '',
    '',
    `Product catalog (id: name — application areas):\n${catalog.map((p) => `${p.productId}: ${p.name} — ${p.applicationAreas.join(', ')}`).join('\n')}`,
  ].join('\n');
}

type TriageFn = (mail: InboundMail, lead: Lead | null, thread: EmailThread | null, catalog: Product[]) => Promise<TriageResult>;

/** The real triage — one Gemini call. */
const geminiTriage: TriageFn = async (mail, lead, thread, catalog) => {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set — reading incoming mail needs it.');
  const { text, model } = await geminiGenerate({
    apiKey: env.GEMINI_API_KEY.trim(),
    models: geminiModels(),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildPrompt(mail, lead, thread, catalog),
    generationConfig: { temperature: 0.3, responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA },
    timeoutMs: 60_000,
  });
  const r = JSON.parse(text) as {
    intent: string;
    summary: string;
    urgency: string;
    product_ids: string[];
    contact: Record<string, string>;
    should_reply: boolean;
    reply_body: string;
    out_of_office_until: string;
  };
  const valid = new Set(catalog.map((p) => p.productId));
  const intent = (INTENTS as string[]).includes(r.intent) ? (r.intent as InboundIntent) : 'other';
  const until = /^\d{4}-\d{2}-\d{2}$/.test(r.out_of_office_until ?? '') ? new Date(`${r.out_of_office_until}T09:00:00+05:30`) : undefined;
  const clean = (s?: string) => (s && s.trim() ? s.trim() : undefined);
  const noReply = intent === 'unsubscribe' || intent === 'out_of_office';
  return {
    intent,
    summary: r.summary?.trim() || mail.subject,
    urgency: r.urgency === 'high' || r.urgency === 'low' ? r.urgency : 'normal',
    productIds: (r.product_ids ?? []).filter((id) => valid.has(id)),
    contact: { name: clean(r.contact?.name), title: clean(r.contact?.title), institution: clean(r.contact?.institution), department: clean(r.contact?.department), phone: clean(r.contact?.phone) },
    shouldReply: !noReply && Boolean(r.should_reply) && Boolean(clean(r.reply_body)),
    replyBody: noReply ? undefined : clean(r.reply_body),
    outOfOfficeUntil: until && !Number.isNaN(until.getTime()) ? until : undefined,
    model,
  };
};

let triageFn: TriageFn = geminiTriage;

/** Test seam: replace the AI with a stub (null restores the real one). */
export function setTriageFn(fn: TriageFn | null): void {
  triageFn = fn ?? geminiTriage;
}

export function triageInbound(mail: InboundMail, lead: Lead | null, thread: EmailThread | null, catalog: Product[]): Promise<TriageResult> {
  return triageFn(mail, lead, thread, catalog);
}
