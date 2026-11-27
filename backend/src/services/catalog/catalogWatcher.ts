/**
 * Keeps the CRM's product catalog in step with classonesystems.in.
 *
 * Every 30 minutes the website's Firestore is read (read-only, with the
 * website's service-account key): every published product under
 * catalog/<group>/categories/<category>/products. Compared with product_catalog:
 *   - a NEW product is classified by the AI from its title and description
 *     (CRM category, application areas, search keywords, SDKs), added to the
 *     catalog, and gets a product_launches record — productLaunch.ts drafts the
 *     outreach and picks who it is for;
 *   - a CHANGED product (title, description, images) is updated, keeping its
 *     classification;
 *   - a product REMOVED or unpublished on the website is marked inactive.
 * Then discovery's keyword sets are rebuilt from the live catalog, so the next
 * discovery and scoring runs use the new product's keywords and areas.
 *
 * The first run only records what the website already has — no launches for the
 * products that were there before this watcher existed.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Schema, model } from 'mongoose';
import { env } from '../../config/env.js';
import { ProductModel } from '../../models/productCatalog.model.js';
import { getState, setState } from '../../models/systemState.model.js';
import type { ProductCategory } from '../../types/domain.js';
import { slugify } from '../../utils/normalize.js';
import { geminiGenerate, geminiModels } from '../ai/geminiProvider.js';
import { logActivity } from '../activity/activityService.js';
import { refreshKeywordCatalog } from '../discovery/keywords.js';

const WEBSITE_BASE = 'https://classonesystems.in';

// --- Launch records (one per product detected as new) ----------------------------------------------

const launchSchema = new Schema(
  {
    productId: { type: String, required: true, unique: true },
    productName: String,
    detectedAt: { type: Date, required: true },
    /** pending: to draft · ready: campaign made · failed: gave up · skipped: nobody matched / turned off ·
     *  withdrawn: the product left the website before its announcement went out */
    status: { type: String, enum: ['pending', 'ready', 'failed', 'skipped', 'withdrawn'], default: 'pending', index: true },
    campaignId: String,
    recipients: Number,
    attempts: { type: Number, default: 0 },
    error: String,
  },
  { collection: 'product_launches', timestamps: true, versionKey: false },
);
export const ProductLaunchModel = model('ProductLaunch', launchSchema);

// --- Reading the website -------------------------------------------------------------------------------

export interface WebsiteProduct {
  slug: string;
  title: string;
  group: string;
  category: string;
  tags: string[];
  short?: string;
  desc?: string;
  images: string[];
  href?: string;
}

export interface WebsiteSource {
  list(): Promise<WebsiteProduct[]>;
}

const decode = (s?: string) =>
  (s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#0?38;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

let firestoreSource: WebsiteSource | null = null;

/** The live website, through firebase-admin with the website's service-account key (read-only use). */
/** The website's Firestore (its own named firebase-admin app), shared by the catalog and enquiry watchers. */
export async function websiteFirestore() {
  const keyPath = env.WEBSITE_FIREBASE_KEY_PATH;
  if (!fs.existsSync(keyPath)) throw new Error(`No website service-account key at ${keyPath} — set WEBSITE_FIREBASE_KEY_PATH.`);
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const app = getApps().find((a) => a.name === 'website') ?? initializeApp({ credential: cert(JSON.parse(fs.readFileSync(keyPath, 'utf8'))) }, 'website');
  return getFirestore(app);
}

export async function websiteFirestoreSource(): Promise<WebsiteSource> {
  if (firestoreSource) return firestoreSource;
  const db = await websiteFirestore();
  firestoreSource = {
    async list() {
      const snap = await db.collectionGroup('products').get();
      return snap.docs
        .map((d) => d.data() as Record<string, unknown>)
        .filter((p) => !p.deleted && p.group && p.group !== 'unpublished' && p.slug)
        .map((p) => ({
          slug: String(p.slug),
          title: decode(String(p.title ?? p.slug)),
          group: String(p.group),
          category: String(p.category ?? ''),
          tags: Array.isArray(p.tags) ? (p.tags as unknown[]).map(String) : [],
          short: decode(p.shortHtml as string).slice(0, 600) || undefined,
          desc: decode(p.descHtml as string).slice(0, 2000) || undefined,
          images: (Array.isArray(p.images) ? (p.images as unknown[]).map(String) : p.image ? [String(p.image)] : []).filter((u) => /^https?:\/\//.test(u)),
          href: typeof p.href === 'string' && p.href ? p.href : undefined,
        }));
    },
  };
  return firestoreSource;
}

const urlOf = (p: WebsiteProduct) => (p.href && /^https?:\/\//.test(p.href) ? p.href : `${WEBSITE_BASE}/product/${encodeURIComponent(p.slug)}`);
const hashOf = (p: WebsiteProduct) => createHash('sha1').update(JSON.stringify([p.title, p.short, p.desc, p.images])).digest('hex').slice(0, 16);

// --- Classifying a new product -----------------------------------------------------------------------

const CATEGORIES: ProductCategory[] = [
  'potentiostat_portable',
  'potentiostat_benchtop',
  'multi_channel_workstation',
  'single_channel_workstation',
  'biosensor_kit',
  'spectroelectrochemistry',
  'application_kit',
  'oem_module',
  'battery_equipment',
  'thin_film_deposition',
  'electrode',
  'software_sdk',
  'accessory',
];

export interface Classification {
  category: ProductCategory;
  applicationAreas: string[];
  keywords: string[];
  sdkSupport: string[];
}

const CLASSIFY_PROMPT = `You classify a new product from Class One Systems (an Indian supplier of electrochemical research instrumentation) for its sales CRM. From the product's name and description decide:
- category: the one best fit from the list given.
- application_areas: 3-8 research areas the product serves, as short lowercase phrases a researcher would use (e.g. "batteries", "corrosion", "biosensors", "electrocatalysis", "thin films").
- keywords: 3-10 lowercase search phrases (2-4 words) that would appear in the title or abstract of papers by researchers who need this product (techniques, measurements, materials). No brand or product names, no generic words like "research" or "analysis".
- sdk_support: any of python, matlab, labview, dotnet, methodscript the description says it can be driven from; empty if not stated.
Use only what the description supports.`;

type Classifier = (p: WebsiteProduct) => Promise<Classification>;

const geminiClassifier: Classifier = async (p) => {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set — new products cannot be classified.');
  const { text } = await geminiGenerate({
    apiKey: env.GEMINI_API_KEY.trim(),
    models: geminiModels(),
    systemPrompt: CLASSIFY_PROMPT,
    userPrompt: [`Name: ${p.title}`, `Website section: ${p.group} / ${p.category}`, p.tags.length ? `Website tags: ${p.tags.join(', ')}` : '', `Description: ${[p.short, p.desc].filter(Boolean).join(' ').slice(0, 2500) || '(none)'}`, `Categories: ${CATEGORIES.join(', ')}`]
      .filter(Boolean)
      .join('\n'),
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          category: { type: 'STRING', enum: CATEGORIES },
          application_areas: { type: 'ARRAY', items: { type: 'STRING' } },
          keywords: { type: 'ARRAY', items: { type: 'STRING' } },
          sdk_support: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['category', 'application_areas', 'keywords', 'sdk_support'],
      },
    },
    timeoutMs: 45_000,
  });
  const r = JSON.parse(text) as { category: string; application_areas: string[]; keywords: string[]; sdk_support: string[] };
  const clean = (xs: string[], max: number) => [...new Set((xs ?? []).map((x) => x.toLowerCase().trim()).filter((x) => x.length > 2 && x.length < 60))].slice(0, max);
  return {
    category: (CATEGORIES as string[]).includes(r.category) ? (r.category as ProductCategory) : 'accessory',
    applicationAreas: clean(r.application_areas, 8),
    keywords: clean(r.keywords, 10),
    sdkSupport: clean(r.sdk_support, 5).filter((s) => ['python', 'matlab', 'labview', 'dotnet', 'methodscript'].includes(s)),
  };
};

let classifier: Classifier = geminiClassifier;
let sourceOverride: WebsiteSource | null = null;

/** Test seams. */
export function setCatalogWatcherDeps(deps: { source?: WebsiteSource | null; classifier?: Classifier | null }): void {
  if (deps.source !== undefined) sourceOverride = deps.source;
  if (deps.classifier !== undefined) classifier = deps.classifier ?? geminiClassifier;
}

// --- One sync ---------------------------------------------------------------------------------------------

export interface SyncResult {
  firstRun: boolean;
  seen: number;
  added: string[];
  updated: string[];
  deactivated: string[];
  failed: Array<{ slug: string; error: string }>;
}

export async function syncWebsiteCatalog(now = new Date()): Promise<SyncResult> {
  const source = sourceOverride ?? (await websiteFirestoreSource());
  const products = await source.list();
  const known = new Set((await getState<string[]>('websiteKnownSlugs')) ?? []);
  const firstRun = !(await getState<boolean>('websiteCatalogBaseline'));
  const out: SyncResult = { firstRun, seen: products.length, added: [], updated: [], deactivated: [], failed: [] };

  for (const p of products) {
    const productId = slugify(p.slug);
    const existing = (await ProductModel.findOne({ productId }).lean()) as { websiteHash?: string; isActive?: boolean } | null;
    const hash = hashOf(p);
    if (existing) {
      if (existing.websiteHash !== hash || existing.isActive === false) {
        await ProductModel.updateOne(
          { productId },
          { $set: { name: p.title, description: [p.short, p.desc].filter(Boolean).join(' ').slice(0, 1500) || undefined, images: p.images, sourceUrl: urlOf(p), websiteHash: hash, isActive: true, lastSyncedAt: now } },
        );
        if (existing.websiteHash) out.updated.push(p.title);
      }
      known.add(p.slug);
      continue;
    }
    // Not in the CRM catalog yet: classify it.
    try {
      const c = await classifier(p);
      await ProductModel.create({
        productId,
        name: p.title,
        category: c.category,
        tags: [...new Set([...c.keywords, ...p.tags.map((t) => t.toLowerCase()).filter((t) => t.includes(' '))])].slice(0, 20),
        description: [p.short, p.desc].filter(Boolean).join(' ').slice(0, 1500) || undefined,
        applicationAreas: c.applicationAreas,
        sdkSupport: c.sdkSupport,
        isActive: true,
        sourceUrl: urlOf(p),
        images: p.images,
        websiteHash: hash,
        source: 'website',
        aiDerived: true,
        lastSyncedAt: now,
      });
      out.added.push(p.title);
      // Genuinely new (not just missing from the seed data on the first run): launch it.
      if (!firstRun && !known.has(p.slug)) {
        await ProductLaunchModel.updateOne({ productId }, { $setOnInsert: { productId, productName: p.title, detectedAt: now, status: 'pending' } }, { upsert: true });
        await logActivity({ type: 'lead_discovered', message: `New product on the website: ${p.title} — outreach being prepared`, metadata: { productId } });
      }
      known.add(p.slug);
    } catch (error) {
      out.failed.push({ slug: p.slug, error: error instanceof Error ? error.message.split('\n')[0]! : String(error) });
    }
  }

  // Website products no longer published: inactive in the CRM (SDKs and other non-website entries untouched).
  const live = new Set(products.map((p) => slugify(p.slug)));
  const websiteProducts = (await ProductModel.find({ isActive: true, sourceUrl: { $regex: `^${WEBSITE_BASE}/product/` } }, { productId: 1, name: 1 }).lean()) as Array<{ productId: string; name: string }>;
  if (products.length > 0) {
    for (const wp of websiteProducts) {
      if (live.has(wp.productId)) continue;
      await ProductModel.updateOne({ productId: wp.productId }, { $set: { isActive: false, lastSyncedAt: now } });
      await withdrawLaunch(wp.productId);
      out.deactivated.push(wp.name);
    }
  }

  await setState('websiteKnownSlugs', [...known]);
  await setState('websiteCatalogBaseline', true);
  await setState('websiteCatalogLastSync', { at: now.toISOString(), seen: out.seen, added: out.added.length, failed: out.failed.length });
  if (out.added.length || out.updated.length || out.deactivated.length) await refreshKeywordCatalog();
  return out;
}

// --- Ticker -------------------------------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let busy = false;

/** One watcher pass: sync the catalog, then draft any pending launches. Safe to call any time ("Check now"). */
export async function catalogWatchTick(): Promise<SyncResult | null> {
  if (busy) return null;
  busy = true;
  try {
    const r = await syncWebsiteCatalog();
    if (r.added.length || r.updated.length || r.deactivated.length || r.failed.length) {
      console.log(
        `[catalog] website: ${r.seen} products · ${r.added.length} added${r.firstRun ? ' (first run — no launches)' : ''} · ${r.updated.length} updated · ${r.deactivated.length} removed${r.failed.length ? ` · ${r.failed.length} could not be classified (retried next run)` : ''}`,
      );
    }
    const { processPendingLaunches } = await import('../campaigns/productLaunch.js');
    await processPendingLaunches();
    return r;
  } finally {
    busy = false;
  }
}

export function startCatalogWatcher(): void {
  if (!fs.existsSync(env.WEBSITE_FIREBASE_KEY_PATH)) {
    console.log(`[catalog] not watching the website: no service-account key at ${env.WEBSITE_FIREBASE_KEY_PATH}`);
    void refreshKeywordCatalog().catch(() => {});
    return;
  }
  const tick = () => void catalogWatchTick().catch((e) => console.error('[catalog] watch failed:', e instanceof Error ? e.message : e));
  void refreshKeywordCatalog().catch(() => {}).finally(tick);
  timer = setInterval(tick, env.CATALOG_WATCH_MINUTES * 60_000);
  console.log(`[catalog] watching classonesystems.in for new products every ${env.CATALOG_WATCH_MINUTES} min`);
}

export function stopCatalogWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * A product removed from the website must not still be announced: a launch not yet drafted is dropped,
 * and its campaign is cancelled unless it has already finished sending.
 */
async function withdrawLaunch(productId: string): Promise<void> {
  const launch = await ProductLaunchModel.findOne({ productId, status: { $in: ['pending', 'ready'] } }).lean();
  if (!launch) return;
  if (launch.campaignId) {
    const { cancelCampaign } = await import('../campaigns/campaignService.js');
    const c = await cancelCampaign(launch.campaignId).catch(() => null);
    if (c?.status === 'done') return; // already sent in full — nothing to withdraw
  }
  await ProductLaunchModel.updateOne({ _id: launch._id }, { $set: { status: 'withdrawn' } });
  console.log(`[launch] ${launch.productName}: product removed from the website — announcement withdrawn`);
}
