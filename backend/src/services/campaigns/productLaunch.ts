/**
 * New product on classonesystems.in → an outreach campaign to the people it is for.
 *
 * For each pending launch (catalogWatcher.ts records them):
 *   1. the AI writes the email from the product's name, description and areas —
 *      heading, product photo, 2-3 paragraphs, product card, button to the
 *      product page — under the same "never invent prices, dates or specs" rule
 *      as every other prompt;
 *   2. recipients: approved leads and customers with an email, not do-not-contact,
 *      whose application areas / topics overlap the product, rated 0-100 for
 *      relevance by the AI in batches; those at or above the bar, best first, up
 *      to the cap;
 *   3. Auto mode: the campaign is scheduled for 24 h later (moved into the send
 *      window) — the team can review, edit or pause it until then. Manual mode:
 *      it waits as a draft. Either way the team is emailed a summary.
 * Sending is the ordinary campaign worker (pace, daily cap, opt-outs re-checked).
 * A launch whose AI steps fail is retried on the next watcher run (up to 5 times).
 */
import { env } from '../../config/env.js';
import { CampaignAssetModel } from '../../models/campaign.model.js';
import type { CampaignBlock } from '../../models/campaign.model.js';
import { ContactModel } from '../../models/contact.model.js';
import { LeadModel } from '../../models/lead.model.js';
import { getState, setState } from '../../models/systemState.model.js';
import { repositories } from '../../repositories/index.js';
import type { Product } from '../../types/domain.js';
import { nextSendWindow } from '../../utils/sendWindow.js';
import { geminiGenerate, geminiModels } from '../ai/geminiProvider.js';
import { logActivity } from '../activity/activityService.js';
import { ProductLaunchModel } from '../catalog/catalogWatcher.js';
import { button, esc, sendToTeam, shell } from '../email/replyWatch.js';
import { createCampaign, startCampaign, updateCampaign } from './campaignService.js';

const MAX_ATTEMPTS = 5;
const REVIEW_HOURS = 24;

// --- Settings ----------------------------------------------------------------------------------------

export interface LaunchSettings {
  mode: 'auto' | 'manual';
  minRelevance: number;
  maxRecipients: number;
}

export async function getLaunchSettings(): Promise<LaunchSettings> {
  const s = (await getState<Partial<LaunchSettings>>('launchSettings')) ?? {};
  return { mode: s.mode === 'auto' ? 'auto' : 'manual', minRelevance: s.minRelevance ?? env.LAUNCH_MIN_RELEVANCE, maxRecipients: s.maxRecipients ?? env.LAUNCH_MAX_RECIPIENTS };
}

export async function setLaunchSettings(patch: Partial<LaunchSettings>): Promise<LaunchSettings> {
  const next = { ...(await getLaunchSettings()), ...patch };
  await setState('launchSettings', next);
  return next;
}

// --- AI steps (replaceable in tests) ---------------------------------------------------------------------

export interface LaunchCopy {
  subject: string;
  preheader: string;
  heading: string;
  paragraphs: string[];
  buttonLabel: string;
}

export interface Candidate {
  id: string;
  name: string;
  summary: string;
  topics: string[];
  areas: string[];
  instruments: string[];
}

type CopyWriter = (p: Product) => Promise<LaunchCopy>;
type Rater = (p: Product, people: Candidate[]) => Promise<Map<string, number>>;

const COPY_PROMPT = `You write a product announcement email from Class One Systems (classonesystems.in, an Indian supplier of electrochemical research instrumentation) to Indian academic researchers whose work it fits.
Return: subject (max 70 characters, may use {first_name}), preheader (max 100 characters), heading (max 60 characters), paragraphs (2-3 short paragraphs, 120-180 words in total) and button_label (2-4 words, e.g. "See the product").
Rules: plain professional tone, no hype, no exclamation marks, no emojis. Open with "Dear {title|Dr.} {last_name|}," as the first paragraph's first line. Describe what the product does and which research it helps, from the description given ONLY — never invent prices, discounts, availability, dates, specifications or claims. Invite them to reply to discuss their work or ask for a demo. No sign-off (the email has its own). At most one phrase in **bold**.`;

const geminiCopy: CopyWriter = async (p) => {
  const { text } = await geminiGenerate({
    apiKey: (env.GEMINI_API_KEY ?? '').trim(),
    models: geminiModels(),
    systemPrompt: COPY_PROMPT,
    userPrompt: `Product: ${p.name}\nCategory: ${p.category.replace(/_/g, ' ')}\nApplication areas: ${p.applicationAreas.join(', ')}\nDescription: ${p.description ?? '(none)'}`,
    generationConfig: {
      temperature: 0.5,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          subject: { type: 'STRING' },
          preheader: { type: 'STRING' },
          heading: { type: 'STRING' },
          paragraphs: { type: 'ARRAY', items: { type: 'STRING' } },
          button_label: { type: 'STRING' },
        },
        required: ['subject', 'preheader', 'heading', 'paragraphs', 'button_label'],
      },
    },
    timeoutMs: 45_000,
  });
  const r = JSON.parse(text) as { subject: string; preheader: string; heading: string; paragraphs: string[]; button_label: string };
  return { subject: r.subject.trim(), preheader: r.preheader.trim(), heading: r.heading.trim(), paragraphs: r.paragraphs.map((x) => x.trim()).filter(Boolean).slice(0, 3), buttonLabel: r.button_label.trim() || 'See the product' };
};

const RATE_PROMPT = `You judge how relevant a new research instrument is to each researcher, for a sales team that only wants to email people who would genuinely care. For each researcher give relevance 0-100: 80+ their work clearly needs this kind of instrument; 50-79 plausible fit; below 50 weak or unrelated. Judge each person independently, only from the information given.`;

const geminiRater: Rater = async (p, people) => {
  const { text } = await geminiGenerate({
    apiKey: (env.GEMINI_API_KEY ?? '').trim(),
    models: geminiModels(),
    systemPrompt: RATE_PROMPT,
    userPrompt: [
      `PRODUCT: ${p.name} — ${p.category.replace(/_/g, ' ')}. Serves: ${p.applicationAreas.join(', ')}. ${(p.description ?? '').slice(0, 800)}`,
      '',
      ...people.map((c) => `[${c.id}] ${c.name}. Areas: ${c.areas.join(', ') || '—'}. Topics: ${c.topics.slice(0, 8).join(', ') || '—'}. Instruments: ${c.instruments.join(', ') || '—'}. Work: ${c.summary.slice(0, 400) || '—'}`),
    ].join('\n'),
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { results: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, relevance: { type: 'INTEGER' } }, required: ['id', 'relevance'] } } },
        required: ['results'],
      },
    },
    timeoutMs: 60_000,
  });
  const r = JSON.parse(text) as { results: Array<{ id: string; relevance: number }> };
  return new Map(r.results.map((x) => [String(x.id).replace(/^\[|\]$/g, ''), Math.max(0, Math.min(100, Math.round(x.relevance)))]));
};

let copyWriter: CopyWriter = geminiCopy;
let rater: Rater = geminiRater;
export function setLaunchAi(deps: { copy?: CopyWriter | null; rate?: Rater | null }): void {
  if (deps.copy !== undefined) copyWriter = deps.copy ?? geminiCopy;
  if (deps.rate !== undefined) rater = deps.rate ?? geminiRater;
}

// --- Steps -------------------------------------------------------------------------------------------------

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Leads worth asking the AI about: in the CRM, reachable, and overlapping the product's areas or keywords. */
async function candidatesFor(p: Product): Promise<Candidate[]> {
  const dnc = ((await ContactModel.find({ doNotContact: true }, { email: 1 }).lean()) as Array<{ email: string }>).map((c) => c.email);
  const terms = [...new Set([...p.applicationAreas, ...p.tags].map((t) => t.toLowerCase()).filter((t) => t.length > 3))];
  const rx = terms.length ? new RegExp(terms.map(escapeRegex).join('|'), 'i') : null;
  const docs = await LeadModel.find({
    status: { $in: ['approved', 'customer'] },
    'person.email': { $exists: true, $nin: ['', null, ...dnc] },
    doNotContact: { $ne: true },
    inPipeline: { $ne: true },
    ...(rx ? { $or: [{ 'research.applicationAreas': { $in: p.applicationAreas } }, { 'research.topics': rx }, { 'research.summary': rx }, { 'aiScoring.relevanceReasoning': rx }] } : {}),
  })
    .sort({ 'aiScoring.relevanceScore': -1 })
    .limit(600)
    .select({ person: 1, research: 1, 'aiScoring.relevanceReasoning': 1 })
    .lean();
  return docs.map((d) => ({
    id: String(d._id),
    name: d.person?.name ?? '',
    summary: d.research?.summary ?? d.aiScoring?.relevanceReasoning ?? '',
    topics: (d.research?.topics ?? []) as string[],
    areas: (d.research?.applicationAreas ?? []) as string[],
    instruments: ((d.research?.instruments ?? []) as Array<{ brand?: string; model?: string }>).map((i) => [i.brand, i.model].filter(Boolean).join(' ')),
  }));
}

/** The product's photo, stored once as a campaign image so it is embedded in each email. */
async function productImageAsset(p: Product): Promise<string | null> {
  const url = p.images?.[0];
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const type = res.headers.get('content-type')?.split(';')[0] ?? '';
    if (!res.ok || !/^image\/(png|jpe?g|gif|webp)$/.test(type)) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > 1.5 * 1024 * 1024) return null;
    const doc = await CampaignAssetModel.create({ filename: `${p.productId}.${type.split('/')[1]}`, contentType: type, data, size: data.length, createdBy: 'product-launch' });
    return String(doc._id);
  } catch {
    return null;
  }
}

function blocksFor(p: Product, copy: LaunchCopy, assetId: string | null): CampaignBlock[] {
  const url = p.sourceUrl ?? 'https://classonesystems.in';
  return [
    { id: 'h', type: 'heading', text: copy.heading, align: 'left' },
    ...(assetId ? [{ id: 'img', type: 'image' as const, assetId, alt: p.name, link: url, width: 'large' as const, align: 'center' as const }] : []),
    { id: 't', type: 'text', text: copy.paragraphs.join('\n\n') },
    { id: 'p', type: 'product', productId: p.productId, url },
    { id: 'b', type: 'button', label: copy.buttonLabel, url, align: 'center' },
  ];
}

/** Drafts and queues every pending launch. Returns how many campaigns were made. */
export async function processPendingLaunches(now = new Date()): Promise<number> {
  const pending = await ProductLaunchModel.find({ status: 'pending', attempts: { $lt: MAX_ATTEMPTS } }).lean();
  let made = 0;
  for (const launch of pending) {
    try {
      const product = await repositories.products.findByProductId(launch.productId);
      if (!product?.isActive) {
        await ProductLaunchModel.updateOne({ _id: launch._id }, { $set: { status: 'skipped', error: 'Product no longer on the website' } });
        continue;
      }
      const settings = await getLaunchSettings();
      const copy = await copyWriter(product);

      const candidates = await candidatesFor(product);
      const scores = new Map<string, number>();
      for (let i = 0; i < candidates.length; i += 15) {
        const batch = candidates.slice(i, i + 15);
        for (const [id, s] of await rater(product, batch)) scores.set(id, s);
      }
      const chosen = candidates
        .filter((c) => (scores.get(c.id) ?? 0) >= settings.minRelevance)
        .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))
        .slice(0, settings.maxRecipients);

      if (!chosen.length) {
        await ProductLaunchModel.updateOne({ _id: launch._id }, { $set: { status: 'skipped', recipients: 0, error: `Nobody in the CRM rated ${settings.minRelevance}+ for this product` } });
        await notifyTeam(product, null, 0, [], settings, null);
        continue;
      }

      const assetId = await productImageAsset(product);
      const campaign = await createCampaign({ name: `New product: ${product.name}`, createdBy: 'product-launch' });
      await updateCampaign(campaign.id, {
        subject: copy.subject,
        preheader: copy.preheader,
        blocks: blocksFor(product, copy, assetId),
        audience: { statuses: ['approved', 'customer'], leadIds: chosen.map((c) => c.id) },
        paceSeconds: 30,
      });
      const { CampaignModel } = await import('../../models/campaign.model.js');
      let sendAt: Date | null = null;
      if (settings.mode === 'auto') {
        sendAt = nextSendWindow(new Date(now.getTime() + REVIEW_HOURS * 3_600_000));
        await CampaignModel.updateOne({ _id: campaign.id }, { $set: { kind: 'product_launch', productId: product.productId, reviewUntil: sendAt } });
        await startCampaign(campaign.id, { sendAt });
      } else {
        await CampaignModel.updateOne({ _id: campaign.id }, { $set: { kind: 'product_launch', productId: product.productId } });
      }
      await ProductLaunchModel.updateOne({ _id: launch._id }, { $set: { status: 'ready', campaignId: campaign.id, recipients: chosen.length }, $unset: { error: '' } });
      await logActivity({
        type: 'outreach_batch_completed',
        message: `New product ${product.name}: outreach to ${chosen.length} matched ${chosen.length === 1 ? 'person' : 'people'} ${sendAt ? `scheduled for ${sendAt.toISOString()}` : 'drafted for review'}`,
        metadata: { productId: product.productId, campaignId: campaign.id },
      });
      await notifyTeam(product, copy, chosen.length, chosen.slice(0, 8).map((c) => ({ name: c.name, score: scores.get(c.id) ?? 0 })), settings, { id: campaign.id, sendAt });
      made += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0]! : String(error);
      const attempts = (launch.attempts ?? 0) + 1;
      await ProductLaunchModel.updateOne({ _id: launch._id }, { $set: { error: message, attempts, ...(attempts >= MAX_ATTEMPTS ? { status: 'failed' } : {}) } });
      console.error(`[launch] ${launch.productName}: ${message}${attempts < MAX_ATTEMPTS ? ' — will retry' : ' — gave up'}`);
    }
  }
  return made;
}

async function notifyTeam(product: Product, copy: LaunchCopy | null, count: number, sample: Array<{ name: string; score: number }>, settings: LaunchSettings, campaign: { id: string; sendAt: Date | null } | null): Promise<void> {
  const link = campaign ? `${env.appUrl}/campaigns?id=${campaign.id}` : `${env.appUrl}/campaigns`;
  const when = campaign?.sendAt ? campaign.sendAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : null;
  const intro = !campaign
    ? `It was added to the CRM catalog and to discovery's keywords, but nobody in the CRM rated ${settings.minRelevance}+ for it, so no email was prepared.`
    : when
      ? `The AI drafted an announcement and picked <strong>${count}</strong> ${count === 1 ? 'person' : 'people'} it fits. <strong>It sends automatically on ${esc(when)} IST</strong> unless someone pauses or edits it before then.`
      : `The AI drafted an announcement and picked <strong>${count}</strong> ${count === 1 ? 'person' : 'people'} it fits. New-product mode is Manual, so it waits for someone to review and send it.`;
  const html = shell(
    `New product on the website: ${product.name}`,
    intro,
    `${copy ? `<p style="margin:0 0 4px;font-weight:600">${esc(copy.subject)}</p><div style="background:#f3f5f9;border-radius:8px;padding:10px 14px;margin:0 0 14px;white-space:pre-wrap">${esc(copy.paragraphs.join('\n\n'))}</div>` : ''}
${sample.length ? `<p style="margin:0 0 4px;font-weight:600">Best matches</p><ul style="margin:0 0 14px;padding-left:18px">${sample.map((s) => `<li>${esc(s.name)} — relevance ${s.score}</li>`).join('')}</ul>` : ''}
<p>${button(link, campaign ? 'Review the campaign' : 'Open Campaigns')}</p>`,
  );
  await sendToTeam(
    `New product: ${product.name}${campaign ? ` — email to ${count} ${when ? `goes out ${when}` : 'ready to review'}` : ''}`,
    html,
    `New product on the website: ${product.name}. ${campaign ? `${count} matched; ${when ? `sends ${when} IST unless paused` : 'waiting for review'}.` : 'Nobody matched.'} ${link}`,
  );
}

/** Detected products and how their launches stand — the Campaigns page panel. */
export async function listLaunches(limit = 30) {
  return (await ProductLaunchModel.find().sort({ detectedAt: -1 }).limit(limit).lean()).map(({ _id, ...l }) => ({ id: String(_id), ...l }));
}
