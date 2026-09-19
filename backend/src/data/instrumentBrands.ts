/**
 * Electrochemical instrument brands — Class One's own lines and the competitors
 * they sell against.
 *
 * Used two ways:
 *   1. SEARCH — one OpenAlex full-text query per brand, so a paper whose methods
 *      section says "measured on a PalmSens4" surfaces its authors as leads
 *      tagged with that brand. The terms are NOT typed in here: Class One's own
 *      brands derive every model identifier from the product catalog
 *      (`services/discovery/keywords.ts`), and a competitor is searched by
 *      COMPANY NAME ALONE — we do not sell their range and should not be
 *      guessing their model numbers.
 *   2. DETECTION — `modelPatterns` are run over every candidate's text to pull
 *      out which model they actually use ("CHI 660E", "PGSTAT302N"). This is
 *      how a competitor's specific instrument reaches the discovery result.
 *
 * Why this matters for sales: a researcher who already owns a Gamry or an
 * Autolab has a proven budget for exactly this equipment category. One who owns
 * a PalmSens or CorrTest is an existing customer — an upgrade or accessory sale.
 *
 * These are the SEED values. On first run they are copied into the settings
 * document; from then on the Settings page is authoritative.
 *
 * Search-term rules learned from probing the OpenAlex API:
 *   - Multi-word names must be quoted ("CH Instruments"), or the words are
 *     OR-ed individually and match everything.
 *   - Never use a bare hyphen ("Bio-Logic"): the search parser treats it as an
 *     operator and the query explodes to hundreds of thousands of hits.
 *   - Terms are stemmed, so "BioLogic" matches "biological". Brand names that
 *     collide with English words need `searchAliases` instead.
 */

export type InstrumentVendor = 'classone' | 'competitor';

export interface InstrumentBrandConfig {
  /** Stable slug used to join settings to the model patterns below. */
  key: string;
  /** Display name, e.g. "Autolab (Metrohm)". */
  brand: string;
  vendor: InstrumentVendor;
  /**
   * Extra search terms for the rare brand whose name alone will not do:
   * "BioLogic" stems to "biological" (228k hits), so it needs phrases. Class
   * One's own brands additionally get every model name from the catalog, and
   * a competitor with a workable name needs none of this.
   */
  searchAliases?: string[];
  /** Include this brand in discovery at all (search and detection). */
  enabled: boolean;
  /**
   * Spend an OpenAlex query (10 credits) on this brand each run. Detection from
   * text is free and happens regardless, so lower-priority brands can stay
   * detection-only.
   */
  searchEnabled: boolean;
}

export const DEFAULT_INSTRUMENT_BRANDS: InstrumentBrandConfig[] = [
  // --- Class One's own lines --------------------------------------------
  {
    key: 'palmsens',
    brand: 'PalmSens',
    vendor: 'classone',
    // Models come from the catalog. These are the software names a paper cites
    // that are not catalogue items in their own right.
    searchAliases: ['PSTrace', 'PSTouch', 'MultiTrace', 'MethodSCRIPT', 'PalmSens Nexus'],
    enabled: true,
    searchEnabled: true,
  },
  {
    key: 'corrtest',
    brand: 'CorrTest',
    vendor: 'classone',
    // CS-series model numbers come from the catalog.
    searchAliases: ['Corrtest Instruments'],
    enabled: true,
    searchEnabled: true,
  },
  {
    key: 'tob',
    brand: 'TOB New Energy',
    vendor: 'classone',
    searchAliases: ['TOB Machine', 'TOB-YCGT'],
    enabled: true,
    searchEnabled: false,
  },

  // --- Competitors ------------------------------------------------------
  {
    key: 'autolab',
    brand: 'Autolab (Metrohm)',
    vendor: 'competitor',
    // The parenthesised owner is for display; "Autolab" is the searchable name.
    searchAliases: ['Autolab', 'Metrohm'],
    enabled: true,
    searchEnabled: true,
  },
  {
    key: 'gamry',
    brand: 'Gamry',
    vendor: 'competitor',
    enabled: true,
    searchEnabled: true,
  },
  {
    key: 'biologic',
    brand: 'BioLogic SAS',
    vendor: 'competitor',
    searchAliases: [
      'Bio Logic',
      'Biologic SAS',
      'Biologic Science Instruments',
      'BioLogic potentiostat',
      'Biologic potentiostat',
      'EC Lab software',
    ],
    enabled: true,
    searchEnabled: true,
  },
  {
    key: 'chi',
    brand: 'CH Instruments',
    vendor: 'competitor',
    // "CHI" prefixes every model they make; one alias covers the whole range.
    searchAliases: ['CHI electrochemical workstation'],
    enabled: true,
    searchEnabled: true,
  },
  {
    key: 'admiral',
    brand: 'Admiral Instruments',
    vendor: 'competitor',
    // Their instruments are cited as "Squidstat" far more often than by company.
    searchAliases: ['Squidstat'],
    enabled: true,
    searchEnabled: true,
  },

  // --- Other competitors: detected in text, not searched by default ------
  {
    key: 'ivium',
    brand: 'Ivium Technologies',
    vendor: 'competitor',
    searchAliases: ['Ivium', 'IviumStat'],
    enabled: true,
    searchEnabled: false,
  },
  {
    key: 'par',
    brand: 'Princeton Applied Research (AMETEK)',
    vendor: 'competitor',
    searchAliases: ['Princeton Applied Research', 'PARSTAT', 'VersaSTAT'],
    enabled: true,
    searchEnabled: false,
  },
  {
    key: 'zahner',
    brand: 'Zahner',
    vendor: 'competitor',
    searchAliases: ['Zahner Zennium', 'Zennium'],
    enabled: true,
    searchEnabled: false,
  },
  {
    key: 'pine',
    brand: 'Pine Research',
    vendor: 'competitor',
    searchAliases: ['WaveDriver', 'WaveNow'],
    enabled: true,
    searchEnabled: false,
  },
  {
    key: 'solartron',
    brand: 'Solartron Analytical',
    vendor: 'competitor',
    searchAliases: ['Solartron', 'ModuLab XM'],
    enabled: true,
    searchEnabled: false,
  },
];

/**
 * Regexes that pull a specific MODEL out of free text, keyed by brand.
 *
 * `brandPatterns` establish that the brand is mentioned at all. `modelPatterns`
 * are more specific and each yields the model string as match[0]. A model
 * pattern marked `standalone` is distinctive enough to count on its own
 * ("PGSTAT302N"); the rest only count when a brand pattern also matched,
 * because e.g. "Reference 600" or "CS350" alone appear in unrelated contexts.
 */
export interface BrandDetectionRules {
  brandPatterns: RegExp[];
  modelPatterns: Array<{ pattern: RegExp; standalone: boolean }>;
}

/**
 * Model names a paper would write, per competitor — for IDENTIFICATION only.
 *
 * The brand search finds a Gamry user by the company name; this list is what
 * lets a second pass ask "which Gamry?" one model at a time against full text,
 * since the abstract we hold almost never says. Not used to find new leads
 * for a competitor, and not editable in the UI: it is reference data about
 * other people's product ranges. Class One's own models come from the catalog.
 *
 * `standalone: false` means the model number is an ordinary phrase on its own
 * ("Reference 600", "SP-150") and must be queried together with the brand.
 */
export interface KnownModel {
  model: string;
  standalone?: boolean;
}

export const KNOWN_COMPETITOR_MODELS: Record<string, KnownModel[]> = {
  // Current and legacy alike: a PGSTAT30 bought in 2010 is still a working
  // potentiostat on a bench, and its owner is still a prospect.
  autolab: [
    { model: 'PGSTAT302N', standalone: true },
    { model: 'PGSTAT302', standalone: true },
    { model: 'PGSTAT204', standalone: true },
    { model: 'PGSTAT128N', standalone: true },
    { model: 'PGSTAT100N', standalone: true },
    { model: 'PGSTAT101', standalone: true },
    { model: 'PGSTAT30', standalone: true },
    { model: 'PGSTAT20', standalone: true },
    { model: 'PGSTAT12', standalone: true },
    { model: 'PGSTAT10', standalone: true },
    { model: 'Multi Autolab', standalone: true },
    { model: 'µAutolab', standalone: true },
    { model: 'Autolab M204', standalone: true },
    { model: 'Autolab M101', standalone: true },
  ],
  gamry: [
    { model: 'Interface 1010' },
    { model: 'Interface 1000' },
    { model: 'Interface 5000' },
    { model: 'Reference 600' },
    { model: 'Reference 620' },
    { model: 'Reference 3000' },
    { model: 'Reference 3000AE' },
    { model: 'PCI4' },
    { model: 'Series G 300' },
    { model: 'Series G 750' },
  ],
  biologic: [
    { model: 'SP-50' },
    { model: 'SP-150' },
    { model: 'SP-200' },
    { model: 'SP-240' },
    { model: 'SP-300' },
    { model: 'VSP' },
    { model: 'VSP-300' },
    { model: 'VMP3', standalone: true },
    { model: 'VMP-300' },
    { model: 'MPG-2' },
    { model: 'MPG-205' },
    { model: 'BCS-805' },
    { model: 'BCS-810' },
    { model: 'HCP-803' },
  ],
  chi: [
    { model: 'CHI600E', standalone: true },
    { model: 'CHI600D', standalone: true },
    { model: 'CHI604E', standalone: true },
    { model: 'CHI608E', standalone: true },
    { model: 'CHI620E', standalone: true },
    { model: 'CHI650E', standalone: true },
    { model: 'CHI660E', standalone: true },
    { model: 'CHI660D', standalone: true },
    { model: 'CHI660C', standalone: true },
    { model: 'CHI700E', standalone: true },
    { model: 'CHI760E', standalone: true },
    { model: 'CHI760D', standalone: true },
    { model: 'CHI800D', standalone: true },
    { model: 'CHI832', standalone: true },
    { model: 'CHI920D', standalone: true },
    { model: 'CHI1040C', standalone: true },
    { model: 'CHI1140C', standalone: true },
  ],
  admiral: [
    { model: 'Squidstat Plus', standalone: true },
    { model: 'Squidstat Prime', standalone: true },
    { model: 'Squidstat Solo', standalone: true },
    { model: 'Squidstat Cycler', standalone: true },
    { model: 'Squidstat Penta', standalone: true },
  ],
  ivium: [
    { model: 'IviumStat', standalone: true },
    { model: 'CompactStat', standalone: true },
    { model: 'Vertex' },
  ],
  par: [
    { model: 'PARSTAT 4000', standalone: true },
    { model: 'PARSTAT MC', standalone: true },
    { model: 'VersaSTAT 3', standalone: true },
    { model: 'VersaSTAT 4', standalone: true },
  ],
  zahner: [{ model: 'Zennium Pro', standalone: true }, { model: 'Zennium X', standalone: true }],
  pine: [{ model: 'WaveDriver 200', standalone: true }, { model: 'WaveNow', standalone: true }],
  solartron: [{ model: 'ModuLab XM', standalone: true }, { model: '1287' }, { model: '1260' }],
};

/**
 * Class One brand models that are no longer in the catalog but are still on
 * benches — a PalmSens3 owner is exactly the upgrade prospect PalmSens4 is
 * for. Current models come from the catalog; these are the ones it cannot know.
 */
export const LEGACY_CLASSONE_MODELS: Record<string, KnownModel[]> = {
  palmsens: [
    { model: 'PalmSens3', standalone: true },
    { model: 'PalmSens2', standalone: true },
    { model: 'EmStat3 Blue', standalone: true },
    { model: 'EmStat Blue', standalone: true },
    { model: 'EmStat3+', standalone: true },
    { model: 'EmStat2', standalone: true },
    { model: 'MultiEmStat3', standalone: true },
    { model: 'MultiPalmSens3', standalone: true },
  ],
  corrtest: [
    { model: 'CS350', standalone: true },
    { model: 'CS310', standalone: true },
    { model: 'CS300', standalone: true },
    { model: 'CS150', standalone: true },
    { model: 'CS2350', standalone: true },
    { model: 'CS1350', standalone: true },
  ],
};

export const BRAND_DETECTION_RULES: Record<string, BrandDetectionRules> = {
  palmsens: {
    brandPatterns: [/\bPalmSens\b/i],
    modelPatterns: [
      { pattern: /\bPalmSens\s?[34]\b/i, standalone: true },
      { pattern: /\bMultiPalmSens\s?4?\b/i, standalone: true },
      { pattern: /\bMultiEmStat\s?[34]?\b/i, standalone: true },
      { pattern: /\bEmStat\s?(?:4[SXMTR]?|3\+?|Pico|Blue|Go|MUX)\b/i, standalone: true },
      { pattern: /\bPalmSens\s?Nexus\b/i, standalone: true },
      { pattern: /\bRackMount\s?16CH\b/i, standalone: true },
      { pattern: /\bEmStat\b/i, standalone: true },
      { pattern: /\bSensit\s?(?:BT|Smart|Wearable)\b/i, standalone: true },
      { pattern: /\bPSTrace\b/i, standalone: true },
      { pattern: /\bMethodSCRIPT\b/, standalone: true },
    ],
  },
  corrtest: {
    brandPatterns: [/\bCorr\s?Test\b/i],
    modelPatterns: [
      // Full model numbers with a suffix (CS350M, CS1350Pro, CS100ME) are
      // distinctive on their own; a bare "CS350" needs the brand nearby.
      { pattern: /\bCS\s?-?\d{3,4}(?:Pro|ME|M)\b/, standalone: true },
      { pattern: /\bCS\s?-?\d{3,4}[A-Z]{0,2}\b/, standalone: false },
    ],
  },
  tob: {
    brandPatterns: [/\bTOB New Energy\b/i],
    modelPatterns: [],
  },
  autolab: {
    brandPatterns: [/\bAutolab\b/i, /\bMetrohm\b/],
    modelPatterns: [
      { pattern: /\bPGSTAT\s?-?\d{2,3}[A-Z]{0,2}\b/i, standalone: true },
      { pattern: /\bMulti\s?Autolab\b/i, standalone: true },
      { pattern: /\bAutolab\s?(?:M\d{3}|µAutolab|microAutolab)\b/i, standalone: true },
    ],
  },
  gamry: {
    brandPatterns: [/\bGamry\b/],
    modelPatterns: [
      {
        pattern: /\b(?:Interface|Reference)\s?-?(?:1000E?|1010[BET]?|5000[EP]?|600\+?|620|3000A?E?)\b/i,
        standalone: false,
      },
    ],
  },
  biologic: {
    // Hyphenated or camel-cased only — plain "biologic" is an English word.
    brandPatterns: [/\bBio-Logic\b/i, /\bBioLogic\b/, /\bBiologic\s+(?:SAS|Science Instruments)\b/i, /\bEC-Lab\b/],
    modelPatterns: [
      { pattern: /\bVMP-?\s?3\b/, standalone: true },
      { pattern: /\bVSP-?\s?(?:300|3e)?\b/, standalone: false },
      { pattern: /\b(?:SP|MPG)-?\s?(?:50|150|200|240|300|2)\b/, standalone: false },
      { pattern: /\bBCS-?\s?8\d{2}\b/, standalone: true },
    ],
  },
  chi: {
    brandPatterns: [/\bCH\s?Instruments\b/i],
    modelPatterns: [{ pattern: /\bCHI\s?-?\d{3,4}[A-Z]?\b/, standalone: true }],
  },
  admiral: {
    brandPatterns: [/\bAdmiral\s?Instruments\b/i, /\bSquidstat\b/i],
    modelPatterns: [
      { pattern: /\bSquidstat\s?(?:Plus|Prime|Solo|Cycler|Penta)\b/i, standalone: true },
      { pattern: /\bSquidstat\b/i, standalone: true },
    ],
  },
  ivium: {
    brandPatterns: [/\bIvium\b/],
    modelPatterns: [
      { pattern: /\bIviumStat(?:\.h|\.XR[ie]?)?\b/i, standalone: true },
      { pattern: /\bCompactStat(?:\.h|\.e)?\b/i, standalone: true },
      { pattern: /\bVertex(?:\.One|\.C)?\b/, standalone: false },
    ],
  },
  par: {
    brandPatterns: [/\bPrinceton Applied Research\b/i, /\bAMETEK\b/],
    modelPatterns: [
      { pattern: /\bPARSTAT\s?-?\s?(?:\d{3,4}[A-Z]?|MC)?\b/i, standalone: true },
      { pattern: /\bVersaSTAT\s?-?\s?(?:[34]F?|MC)?\b/i, standalone: true },
    ],
  },
  zahner: {
    brandPatterns: [/\bZahner\b/],
    modelPatterns: [{ pattern: /\bZennium\s?(?:Pro|X|XC|E)?\b/i, standalone: true }],
  },
  pine: {
    brandPatterns: [/\bPine Research\b/i],
    modelPatterns: [
      { pattern: /\bWaveDriver\s?(?:10|20|40|100|200)?\b/i, standalone: true },
      { pattern: /\bWaveNow\s?(?:XV|Wireless)?\b/i, standalone: true },
    ],
  },
  solartron: {
    brandPatterns: [/\bSolartron\b/],
    modelPatterns: [
      { pattern: /\bModuLab\s?(?:XM)?\b/i, standalone: true },
      { pattern: /\bSolartron\s?12(?:60|87|55|70)A?\b/i, standalone: true },
    ],
  },
};
