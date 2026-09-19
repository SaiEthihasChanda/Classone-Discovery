/**
 * The discovery keyword set — derived, not hand-typed.
 *
 * WHY DERIVED: the keyword list and the product catalog were drifting apart.
 * Someone adds a product on classonesystems.in and discovery keeps searching
 * for last quarter's range. Everything here is computed from data that already
 * exists, so adding a product to the website (then `npm run catalog:export`)
 * widens discovery automatically.
 *
 * Five sources, as agreed:
 *   1. Subject nouns from the website      — `data/websiteKeywords.ts`
 *   2. Brand names, ours and competitors'  — `data/instrumentBrands.ts`
 *   3. Our product names                   — the catalog's model identifiers
 *   4. Application areas                   — the catalog's `applicationAreas`
 *   5. Per-product keywords from Firestore — the catalog's `tags`
 *
 * Sources 2 and 3 are searched against paper FULL TEXT (an instrument is named
 * in a methods section, not an abstract) by the brand search in `sources.ts`,
 * so they are listed here for visibility but never re-spent as title/abstract
 * queries. Sources 1, 4 and 5 are phrase-matched against titles and abstracts.
 */
import { CATALOG } from '../../scripts/catalogData.js';
import {
  DEFAULT_INSTRUMENT_BRANDS,
  KNOWN_COMPETITOR_MODELS,
  LEGACY_CLASSONE_MODELS,
  type InstrumentBrandConfig,
  type KnownModel,
} from '../../data/instrumentBrands.js';
import { ALL_SUBJECT_NOUNS } from '../../data/websiteKeywords.js';

export type KeywordSourceKey =
  | 'subject_nouns'
  | 'application_areas'
  | 'product_keywords'
  | 'product_names'
  | 'brand_names';

export interface KeywordGroup {
  key: KeywordSourceKey;
  label: string;
  description: string;
  /**
   * `title_abstract` phrases cost credits as keyword queries; `fulltext` ones
   * are carried by the brand search and cost nothing extra here.
   */
  searchedAs: 'title_abstract' | 'fulltext';
  phrases: string[];
}

const MODEL_TOKEN =
  /^(?:palmsens\d?|multipalmsens\d?|emstat\d?[a-z]{0,2}|multiemstat\d?|sensit|pstrace|pstouch|multitrace|methodscript|rackmount|cs\d{3,4}[a-z]{0,3})$/i;

/**
 * Phrases too generic to be worth a query: they would match most of chemistry
 * and drown the specific terms. Application areas and product tags are written
 * for a product page, not for a literature search, so a few need dropping.
 */
const TOO_GENERIC = new Set([
  'education',
  'teaching labs',
  'general electrochemistry',
  'materials science',
  'materials processing',
  'sensors',
  'sensor arrays',
  'diagnostics',
  'catalysis',
  'batteries',
  'energy storage',
  'thin films',
  'nanomaterials',
  'electrode preparation',
  'field measurement',
  'lab automation',
  'data analysis',
  'test systems',
  'instrument integration',
  'instrument development',
  'oem integration',
  'embedded control',
  'embedded sensing',
  'battery testing',
  'materials testing',
  'cell assembly',
  'air-sensitive materials',
  'sem sample preparation',
  'surface treatment',
  'adsorption',
  'high-throughput screening',
]);

/**
 * A phrase is worth a query if it is specific, short enough to match verbatim,
 * and not a catalogue artefact.
 *
 * Every phrase that survives costs credits (10 per five), so this is where the
 * website's product tags — written for a product page, not a literature search
 * — are filtered down to the ones a paper would actually contain.
 */
function isSearchablePhrase(phrase: string): boolean {
  const p = phrase.trim().toLowerCase();
  if (p.length < 4) return false;
  if (TOO_GENERIC.has(p)) return false;
  // Four or more words rarely appears verbatim in a title or abstract.
  if (p.split(/\s+/).length > 4) return false;
  // Part and model numbers ("sa307", "sw202-1", "dst3-t") belong to the
  // full-text brand search, where they are matched against a methods section.
  if (/\d/.test(p) && p.split(/\s+/).length <= 2 && !/battery|cell|electrode|voltammetry/.test(p)) {
    return false;
  }
  if (/^\d/.test(p)) return false;
  // A brand name is searched in full text by the brand search; spending a
  // keyword query on it as well is the same lead twice at ten times the price.
  if (BRAND_WORDS.has(p)) return false;
  // A tag naming one of our models is a full-text term, not a topic phrase.
  if (p.split(/[\s/(),]+/).some((w) => MODEL_TOKEN.test(w))) return false;
  // Catalogue nouns ("handheld instrument", "starter kit", "module platform")
  // describe a product, not a piece of research. No paper contains them.
  if (/\b(instrument|platform|device|kit|package|system|core|generator|workstation)$/.test(p)) {
    return false;
  }
  return true;
}

/** Brand words, so the keyword groups never re-spend on what the brand search covers. */
const BRAND_WORDS = new Set(
  DEFAULT_INSTRUMENT_BRANDS.flatMap((b) => [
    b.brand.toLowerCase(),
    b.brand.toLowerCase().replace(/\s*\([^)]*\)/, '').trim(),
    ...(b.searchAliases ?? []).map((a) => a.toLowerCase()),
  ]),
);

function dedupe(phrases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const phrase of phrases) {
    const key = phrase.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(phrase.trim());
  }
  return out;
}

/**
 * Model identifiers in a product name that are distinctive enough to search
 * full text for.
 *
 * "PalmSens4" and "CS350M" identify an instrument; "Educational Kit" and
 * "Nexus" are ordinary English and would match thousands of unrelated works.
 */

export function modelNamesFromCatalog(): string[] {
  const names: string[] = [];

  for (const product of CATALOG) {
    // Multi-word model names ("EmStat Pico", "Sensit BT") are kept whole; the
    // rest contribute their distinctive token only.
    const words = product.name.split(/[\s/(),]+/).filter(Boolean);
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i]!;
      if (!MODEL_TOKEN.test(word)) continue;
      const next = words[i + 1];
      // "EmStat Pico", "Sensit BT", "EmStat4M Module" → keep the qualifier when
      // it is a short token rather than a descriptive word.
      if (next && /^(?:pico|go|mux|bt|smart|wearable|core|\d[a-z]?|[a-z]{1,3}\d*)$/i.test(next) && next.length <= 8) {
        names.push(`${word} ${next}`);
      }
      names.push(word);
    }
  }

  return dedupe(names).sort((a, b) => a.localeCompare(b));
}

/**
 * Full-text search terms for one brand.
 *
 * Class One's own brands get every model identifier the catalog knows about —
 * nobody types these in, and they cannot go stale. Competitors get their
 * company name only: the specific model they use is read out of the paper text
 * afterwards by the detector, which is both cheaper and more accurate than
 * guessing model numbers we do not sell.
 */
export function brandSearchTerms(brand: InstrumentBrandConfig): string[] {
  if (brand.vendor === 'classone') {
    const models = modelNamesFromCatalog().filter((name) => {
      const n = name.toLowerCase();
      if (brand.key === 'palmsens') return /^(?:palmsens|multipalmsens|emstat|multiemstat|sensit|pstrace|pstouch|multitrace|methodscript|rackmount)/.test(n);
      if (brand.key === 'corrtest') return /^cs\d/.test(n);
      return false;
    });
    return dedupe([brand.brand, ...models, ...(brand.searchAliases ?? [])]);
  }

  // Competitor: the company name, plus the aliases needed where the name alone
  // does not work as a search term (see `searchAliases` in instrumentBrands.ts).
  return dedupe([brand.brand, ...(brand.searchAliases ?? [])]);
}

/**
 * The specific models to identify for one brand, once its users are found.
 *
 * Ours come from the catalog (brand tokens like "EmStat" and software names
 * like "PSTrace" are left out — they are not a device). Competitors' come from
 * the reference list in `instrumentBrands.ts`.
 */
export function modelsToIdentify(brand: InstrumentBrandConfig): KnownModel[] {
  if (brand.vendor !== 'classone') {
    return KNOWN_COMPETITOR_MODELS[brand.key] ?? [];
  }

  const BARE_TOKENS = /^(?:palmsens|emstat|sensit|rackmount|pstrace|pstouch|multitrace|methodscript|corrtest)$/i;
  const current = brandSearchTerms(brand)
    .filter((t) => !BARE_TOKENS.test(t) && !/^(?:PalmSens Nexus|Corrtest Instruments|TOB.*)$/i.test(t))
    .filter((t) => t !== brand.brand)
    // "EmStat 4X", "CS350M" are unmistakable on their own; "EmStat Go" and
    // "RackMount 16CH" read as English and need the brand alongside.
    .map((t) => ({ model: t, standalone: !/^(?:EmStat Go|RackMount.*)$/i.test(t) }));

  // Plus the models the catalog has moved on from but labs have not.
  const seen = new Set(current.map((m) => m.model.toLowerCase()));
  const legacy = (LEGACY_CLASSONE_MODELS[brand.key] ?? []).filter((m) => !seen.has(m.model.toLowerCase()));
  return [...current, ...legacy];
}

export const KEYWORD_GROUP_KEYS: KeywordSourceKey[] = [
  'subject_nouns',
  'application_areas',
  'product_keywords',
  'product_names',
  'brand_names',
];

/**
 * Product tags that distinguish a product rather than describe the whole range.
 *
 * A tag on nearly every product ("electrode", "potentiostat") is already
 * covered by the subject terms and adds nothing; a tag on exactly one product
 * is usually a part number. What is left in between is the useful middle.
 */
function distinctiveTags(products: Array<{ tags: string[] }>): string[] {
  const counts = new Map<string, number>();
  for (const p of products) {
    for (const tag of new Set(p.tags.map((t) => t.trim().toLowerCase()))) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  const ceiling = Math.max(3, Math.floor(products.length / 3));
  return dedupe(
    [...counts.entries()]
      .filter(([tag, n]) => n <= ceiling && tag.split(/\s+/).length >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([tag]) => tag),
  );
}

/** The five keyword groups, computed from the catalog and brand data. */
export function buildKeywordGroups(
  brands: InstrumentBrandConfig[] = DEFAULT_INSTRUMENT_BRANDS,
): KeywordGroup[] {
  const activeProducts = CATALOG.filter((p) => p.isActive);

  return [
    {
      key: 'subject_nouns',
      label: 'Subject terms from classonesystems.in',
      description: 'Techniques, measurements and topics the website itself is about.',
      searchedAs: 'title_abstract',
      phrases: dedupe(ALL_SUBJECT_NOUNS).filter(isSearchablePhrase),
    },
    {
      key: 'application_areas',
      label: 'Application areas',
      description: 'The research areas each catalog product serves.',
      searchedAs: 'title_abstract',
      phrases: dedupe(activeProducts.flatMap((p) => p.applicationAreas)).filter(isSearchablePhrase),
    },
    {
      key: 'product_keywords',
      label: 'Product keywords (from the website)',
      description: 'The tags stored against each product in the website’s Firestore.',
      searchedAs: 'title_abstract',
      // One product's tags repeat its neighbours' almost exactly (32 electrode
      // variants), so only tags shared by fewer than a third of the catalog —
      // i.e. the distinguishing ones — are worth a query.
      phrases: distinctiveTags(activeProducts).filter(isSearchablePhrase),
    },
    {
      key: 'product_names',
      label: 'Our product names',
      description: 'Model identifiers from the catalog — searched in paper full text by the brand search.',
      searchedAs: 'fulltext',
      phrases: modelNamesFromCatalog(),
    },
    {
      key: 'brand_names',
      label: 'Brand names (ours and competitors)',
      description: 'Searched in paper full text; the specific model is then read out of the text.',
      searchedAs: 'fulltext',
      phrases: brands.filter((b) => b.enabled).map((b) => b.brand),
    },
  ];
}

/**
 * The phrases a run actually spends keyword queries on: every enabled
 * title/abstract group, plus whatever was typed into "additional keywords".
 */
export function buildKeywordPhrases(options: {
  brands?: InstrumentBrandConfig[];
  disabledGroups?: string[];
  extraKeywords?: string[];
} = {}): string[] {
  const disabled = new Set(options.disabledGroups ?? []);

  const derived = buildKeywordGroups(options.brands)
    .filter((g) => g.searchedAs === 'title_abstract' && !disabled.has(g.key))
    .flatMap((g) => g.phrases);

  return dedupe([...derived, ...(options.extraKeywords ?? []).filter(isSearchablePhrase)]);
}
