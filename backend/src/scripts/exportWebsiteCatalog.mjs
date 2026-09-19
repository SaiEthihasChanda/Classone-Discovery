/**
 * Refreshes `src/data/websiteCatalog.json` from the website's live Firestore.
 *
 * The website repo (C:\Users\saiet\Classone) owns the product catalogue:
 * Firestore path catalog/<group>/categories/<category>/products/<slug>, edited
 * through its admin UI. This tool reads it (read-only) and writes the trimmed
 * copy this backend seeds its product catalog from, so the CRM's notion of
 * "what Class One sells" stays in step with the website without coupling the
 * two codebases at runtime.
 *
 * Prereqs — both live in the website repo, nothing is installed here:
 *   - firebase-admin, in <website-repo>/functions/node_modules
 *   - serviceAccountKey.json at the website repo root (gitignored there)
 *
 * Run:  npm run catalog:export                    (default repo path below)
 *       npm run catalog:export -- C:\path\to\Classone
 * Then: npm run seed:catalog                      (loads it into MongoDB)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../data/websiteCatalog.json');
const websiteRepo = path.resolve(process.argv[2] ?? 'C:\\Users\\saiet\\Classone');

const keyPath = path.join(websiteRepo, 'serviceAccountKey.json');
if (!fs.existsSync(keyPath)) {
  console.error(`No serviceAccountKey.json at ${keyPath}. Generate one in the Firebase console → Project settings → Service accounts.`);
  process.exit(1);
}

// Resolve firebase-admin from the website repo's functions folder, which is
// where it is installed. ESM has no NODE_PATH, hence createRequire.
const requireFromWebsite = createRequire(path.join(websiteRepo, 'functions', 'package.json'));
const { initializeApp, cert } = requireFromWebsite('firebase-admin/app');
const { getFirestore } = requireFromWebsite('firebase-admin/firestore');

initializeApp({ credential: cert(JSON.parse(fs.readFileSync(keyPath, 'utf8'))) });
const db = getFirestore();

const decode = (s) =>
  (s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#0?38;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const catLabels = {};
for (const c of (await db.collectionGroup('categories').get()).docs) catLabels[c.id] = c.data().title || c.id;
const groupLabels = {};
for (const g of (await db.collection('catalog').get()).docs) groupLabels[g.id] = g.data().label || g.id;

const snap = await db.collectionGroup('products').get();
const products = snap.docs
  .map((d) => d.data())
  .filter((p) => !p.deleted && p.group && p.group !== 'unpublished')
  .map((p) => ({
    slug: p.slug,
    title: decode(p.title),
    productType: p.productType || undefined,
    group: p.group,
    groupLabel: groupLabels[p.group] || p.group,
    category: p.category,
    categoryLabel: catLabels[p.category] || p.category,
    tags: Array.isArray(p.tags) ? p.tags : [],
    short: decode(p.shortHtml).slice(0, 400) || undefined,
    desc: decode(p.descHtml).slice(0, 600) || undefined,
  }))
  .sort((a, b) => `${a.group}${a.category}${a.slug}`.localeCompare(`${b.group}${b.category}${b.slug}`));

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      exportedAt: new Date().toISOString().slice(0, 10),
      source: 'Firestore project classone-systems, collectionGroup("products")',
      products,
    },
    null,
    1,
  ) + '\n',
);

console.log(`wrote ${products.length} products to ${path.relative(process.cwd(), OUT)}`);
process.exit(0);
