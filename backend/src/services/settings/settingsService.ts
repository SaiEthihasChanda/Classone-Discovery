/**
 * Editable application settings.
 *
 * Precedence: the database wins. The YAML and TypeScript seed files supply the
 * initial values on first run, after which the Settings page is authoritative —
 * so an edit made in the UI is never silently reverted by a file on disk.
 *
 * Settings are cached in memory because discovery reads them repeatedly during a
 * run; the cache is invalidated on every write.
 */
import { randomUUID } from 'node:crypto';
import { SettingsModel } from '../../models/settings.model.js';
import { INDIAN_INSTITUTIONS, type InstitutionKind } from '../../data/indianInstitutions.js';
import {
  DEFAULT_INSTRUMENT_BRANDS,
  type InstrumentBrandConfig,
} from '../../data/instrumentBrands.js';
import { KEYWORD_GROUP_KEYS } from '../discovery/keywords.js';
import { loadScrapeTargetsFromFile } from '../discovery/scrapeTargetsFile.js';
import { DEFAULT_QUERIES, type DiscoveryRegion } from '../discovery/types.js';

export interface ScrapeTargetConfig {
  targetId: string;
  universityName: string;
  department?: string;
  url: string;
  enabled: boolean;
  note?: string;
  lastPeopleFound?: number;
  lastFetchTier?: string;
  lastCheckedAt?: Date;
}

export interface AffiliationRegistryConfig {
  key: string;
  label: string;
  searchUrl: string;
  enabled: boolean;
  /** Why a registry is off by default — shown in Settings so nobody re-enables it blindly. */
  note?: string;
}

/**
 * Registries known to hold current affiliations for Indian researchers.
 *
 * Both are OFF by default, verified 19 Sep 2026: Vidwan's robots.txt disallows
 * every crawler except Googlebot, and every IRINS host (irins.org and the
 * institute instances) answers our identified crawler with a Cloudflare bot
 * challenge (HTTP 403). This service honours robots.txt and never evades a
 * challenge, so enabling them today finds nothing. They stay configurable in
 * case either site opens up or publishes an API; the parser degrades to
 * "nothing found" rather than to wrong data.
 */
export const DEFAULT_AFFILIATION_REGISTRIES: AffiliationRegistryConfig[] = [
  {
    key: 'irins',
    label: 'IRINS (institute research information systems)',
    searchUrl: 'https://irins.org/irins/searchc/search?q={name}',
    enabled: false,
    note: 'Cloudflare bot challenge (HTTP 403) for identified crawlers — checked 19 Sep 2026',
  },
  {
    key: 'vidwan',
    label: 'Vidwan (national expert database)',
    searchUrl: 'https://vidwan.inflibnet.ac.in/searchc/search?q={name}',
    enabled: false,
    note: 'robots.txt disallows all crawlers except Googlebot — checked 19 Sep 2026',
  },
];

/**
 * A person the roster keeps whatever the department gate says — a known
 * customer, a contact the sales team already has. Matched by ORCID, OpenAlex
 * author id, or name (within the institute when one is given).
 */
export interface AlwaysKeepEntry {
  name: string;
  orcid?: string;
  openAlexAuthorId?: string;
  /** Institute name, to keep a common name from matching a namesake elsewhere. */
  institution?: string;
  note?: string;
}

/** Seeded with the customer the pilot showed the gate dropping. */
export const DEFAULT_ALWAYS_KEEP: AlwaysKeepEntry[] = [
  {
    name: 'Siddharth Tallur',
    orcid: '0000-0003-1399-2187',
    openAlexAuthorId: 'A5072493084',
    institution: 'Indian Institute of Technology Bombay',
    note: 'Known PalmSens (Sensit Smart) user; Electrical Engineering, outside the department list',
  },
];

export interface AppSettings {
  discovery: {
    /** Additional keyword phrases on top of the derived set. Usually empty. */
    queries: string[];
    /** Derived keyword groups to leave out (keys from `discovery/keywords.ts`). */
    disabledKeywordGroups: string[];
    region: DiscoveryRegion;
    institutionKinds: InstitutionKind[];
    disabledInstitutionIds: string[];
    sinceYear?: number;
    enrichFacultyFromOpenAlex: boolean;
    /**
     * Run one OpenAlex full-text query per brand each run, tagging leads with
     * the instruments they already use. 10 credits per searched brand.
     */
    instrumentSearchEnabled: boolean;
    /**
     * After a brand turns up users, identify the specific model with one
     * full-text query per known model. Costs 10 credits per model queried;
     * brands nobody uses skip theirs.
     */
    identifyModels: boolean;
    /** How many years back brand and model searches look. An instrument outlives a paper. */
    instrumentLookbackYears: number;
    /** Check every new lead is still at the institute, via a free OpenAlex author lookup. */
    verifyAffiliations: boolean;
    /** Also consult the researcher's ORCID employment record (free API) in that check. */
    useOrcidForAffiliation: boolean;
    /**
     * Researcher registries the deep check searches by name. `{name}` in the
     * search URL is replaced by the URL-encoded name. Editable because these
     * sites change their URL patterns; disable one that stops working.
     */
    affiliationRegistries: AffiliationRegistryConfig[];
    /** Class One's brands and their competitors — searched and detected in text. */
    instrumentBrands: InstrumentBrandConfig[];
    /** People the roster always keeps, bypassing the department gate. */
    rosterAlwaysKeep: AlwaysKeepEntry[];
  };
  scraping: {
    allowBrowser: boolean;
    allowProxy: boolean;
    followProfiles: boolean;
    maxProfileFetches: number;
    /** Per-lead web enrichment: follow the lab/personal site and its facilities pages. */
    enrichFromLabSites: boolean;
    /** Page budget for one lead's enrichment (directory + profile + lab pages). */
    maxEnrichmentPagesPerLead: number;
    /** Read open-access copies of the lead's recent papers for the Methods section. */
    readOpenAccessPapers: boolean;
    maxPapersPerLead: number;
  };
  facultyTargets: ScrapeTargetConfig[];
  newsTargets: ScrapeTargetConfig[];
}

let cache: AppSettings | null = null;

/** Builds the initial settings from the seed files. Runs once, on first read. */
function buildDefaults(): AppSettings {
  const fromFile = loadScrapeTargetsFromFile();

  const toConfig = (t: {
    universityName: string;
    department?: string;
    url: string;
    enabled: boolean;
    note?: string;
  }): ScrapeTargetConfig => ({
    targetId: randomUUID(),
    universityName: t.universityName,
    department: t.department,
    url: t.url,
    enabled: t.enabled,
    note: t.note,
  });

  return {
    discovery: {
      queries: [...DEFAULT_QUERIES],
      disabledKeywordGroups: [],
      region: 'indian_institutes',
      institutionKinds: ['IIT', 'NIT', 'IIIT'],
      disabledInstitutionIds: [],
      enrichFacultyFromOpenAlex: true,
      instrumentSearchEnabled: true,
      identifyModels: true,
      instrumentLookbackYears: 7,
      verifyAffiliations: true,
      useOrcidForAffiliation: true,
      affiliationRegistries: DEFAULT_AFFILIATION_REGISTRIES.map((r) => ({ ...r })),
      instrumentBrands: DEFAULT_INSTRUMENT_BRANDS.map((b) => ({
        ...b,
        searchAliases: b.searchAliases ? [...b.searchAliases] : undefined,
      })),
      rosterAlwaysKeep: DEFAULT_ALWAYS_KEEP.map((e) => ({ ...e })),
    },
    scraping: {
      allowBrowser: true,
      allowProxy: true,
      followProfiles: true,
      maxProfileFetches: 20,
      enrichFromLabSites: true,
      maxEnrichmentPagesPerLead: 8,
      readOpenAccessPapers: true,
      maxPapersPerLead: 4,
    },
    facultyTargets: fromFile.faculty.map(toConfig),
    newsTargets: fromFile.news.map(toConfig),
  };
}

function toPlain(doc: Record<string, any>): AppSettings {
  return {
    discovery: {
      queries: doc.discovery?.queries ?? [],
      disabledKeywordGroups: (doc.discovery?.disabledKeywordGroups ?? []).filter((k: string) =>
        KEYWORD_GROUP_KEYS.includes(k as never),
      ),
      region: doc.discovery?.region ?? 'indian_institutes',
      institutionKinds: doc.discovery?.institutionKinds ?? ['IIT', 'NIT', 'IIIT'],
      disabledInstitutionIds: doc.discovery?.disabledInstitutionIds ?? [],
      sinceYear: doc.discovery?.sinceYear,
      enrichFacultyFromOpenAlex: doc.discovery?.enrichFacultyFromOpenAlex ?? true,
      instrumentSearchEnabled: doc.discovery?.instrumentSearchEnabled ?? true,
      identifyModels: doc.discovery?.identifyModels ?? true,
      instrumentLookbackYears: doc.discovery?.instrumentLookbackYears ?? 7,
      verifyAffiliations: doc.discovery?.verifyAffiliations ?? true,
      useOrcidForAffiliation: doc.discovery?.useOrcidForAffiliation ?? true,
      affiliationRegistries:
        Array.isArray(doc.discovery?.affiliationRegistries) && doc.discovery.affiliationRegistries.length > 0
          ? doc.discovery.affiliationRegistries.map((r: Record<string, any>) => ({
              key: String(r.key),
              label: String(r.label ?? r.key),
              searchUrl: String(r.searchUrl),
              enabled: r.enabled ?? false,
              note: r.note ? String(r.note) : DEFAULT_AFFILIATION_REGISTRIES.find((d) => d.key === r.key)?.note,
            }))
          : DEFAULT_AFFILIATION_REGISTRIES.map((r) => ({ ...r })),
      // A settings document written before brands existed gets the seed list,
      // so the feature works on upgrade without a manual reset.
      instrumentBrands:
        Array.isArray(doc.discovery?.instrumentBrands) && doc.discovery.instrumentBrands.length > 0
          ? doc.discovery.instrumentBrands.map(toBrandConfig)
          : DEFAULT_INSTRUMENT_BRANDS.map((b) => ({ ...b })),
      // Absent on documents written before the list existed → the seed entry.
      rosterAlwaysKeep: Array.isArray(doc.discovery?.rosterAlwaysKeep)
        ? doc.discovery.rosterAlwaysKeep.map((e: Record<string, any>) => ({
            name: String(e.name ?? ''),
            orcid: e.orcid ? String(e.orcid) : undefined,
            openAlexAuthorId: e.openAlexAuthorId ? String(e.openAlexAuthorId) : undefined,
            institution: e.institution ? String(e.institution) : undefined,
            note: e.note ? String(e.note) : undefined,
          }))
        : DEFAULT_ALWAYS_KEEP.map((e) => ({ ...e })),
    },
    scraping: {
      allowBrowser: doc.scraping?.allowBrowser ?? true,
      allowProxy: doc.scraping?.allowProxy ?? true,
      followProfiles: doc.scraping?.followProfiles ?? true,
      maxProfileFetches: doc.scraping?.maxProfileFetches ?? 20,
      enrichFromLabSites: doc.scraping?.enrichFromLabSites ?? true,
      maxEnrichmentPagesPerLead: doc.scraping?.maxEnrichmentPagesPerLead ?? 8,
      readOpenAccessPapers: doc.scraping?.readOpenAccessPapers ?? true,
      maxPapersPerLead: doc.scraping?.maxPapersPerLead ?? 4,
    },
    facultyTargets: doc.facultyTargets ?? [],
    newsTargets: doc.newsTargets ?? [],
  };
}

function toBrandConfig(raw: Record<string, any>): InstrumentBrandConfig {
  return {
    key: String(raw.key),
    brand: String(raw.brand),
    vendor: raw.vendor === 'classone' ? 'classone' : 'competitor',
    // Pre-rework documents stored a hand-typed `searchTerms`; those are now
    // derived, so anything stored is treated as an alias list.
    searchAliases: Array.isArray(raw.searchAliases)
      ? raw.searchAliases.map(String)
      : Array.isArray(raw.searchTerms)
        ? raw.searchTerms.map(String)
        : undefined,
    enabled: raw.enabled ?? true,
    searchEnabled: raw.searchEnabled ?? false,
  };
}

/** Reads settings, seeding from the files on first ever call. */
export async function getSettings(): Promise<AppSettings> {
  if (cache) return cache;

  const existing = await SettingsModel.findOne({ singleton: 'app' }).lean().exec();
  if (existing) {
    cache = toPlain(existing as Record<string, any>);
    return cache;
  }

  const defaults = buildDefaults();
  await SettingsModel.create({ singleton: 'app', ...defaults });
  console.log(
    `[settings] seeded from files — ${defaults.facultyTargets.length} faculty targets, ` +
      `${defaults.newsTargets.length} news feeds, ${defaults.discovery.queries.length} queries`,
  );

  cache = defaults;
  return cache;
}

/** Applies a partial update and returns the full new settings. */
export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();

  const merged: AppSettings = {
    discovery: { ...current.discovery, ...patch.discovery },
    scraping: { ...current.scraping, ...patch.scraping },
    facultyTargets: patch.facultyTargets ?? current.facultyTargets,
    newsTargets: patch.newsTargets ?? current.newsTargets,
  };

  await SettingsModel.findOneAndUpdate(
    { singleton: 'app' },
    { $set: merged },
    { upsert: true, runValidators: true },
  ).exec();

  cache = merged;
  return merged;
}

/** Restores everything to the seed-file values. */
export async function resetSettings(): Promise<AppSettings> {
  const defaults = buildDefaults();
  await SettingsModel.findOneAndUpdate(
    { singleton: 'app' },
    { $set: defaults },
    { upsert: true },
  ).exec();
  cache = defaults;
  return defaults;
}

/** Drops the in-memory copy. Used by tests that write settings directly. */
export function invalidateSettingsCache(): void {
  cache = null;
}

/** Enabled targets in the shape the discovery sources expect. */
export async function getEnabledTargets(): Promise<{
  faculty: Array<{ universityName: string; department?: string; url: string }>;
  news: Array<{ universityName: string; department?: string; url: string }>;
}> {
  const settings = await getSettings();
  const pick = (targets: ScrapeTargetConfig[]) =>
    targets
      .filter((t) => t.enabled)
      .map((t) => ({ universityName: t.universityName, department: t.department, url: t.url }));

  return { faculty: pick(settings.facultyTargets), news: pick(settings.newsTargets) };
}

/**
 * Institution ids to search, honouring both the category filter and any
 * individually disabled institutes.
 */
export async function getActiveInstitutionIds(
  kindsOverride?: InstitutionKind[],
): Promise<string[]> {
  const settings = await getSettings();
  const kinds = kindsOverride ?? settings.discovery.institutionKinds;
  const disabled = new Set(settings.discovery.disabledInstitutionIds);
  const wanted = kinds.length > 0 ? new Set(kinds) : null;

  return INDIAN_INSTITUTIONS.filter(
    (i) => (!wanted || wanted.has(i.kind)) && !disabled.has(i.openAlexId),
  ).map((i) => i.openAlexId);
}

/** Records what a target actually produced, so the UI can show real yield. */
export async function recordTargetResult(
  url: string,
  result: { peopleFound: number; fetchTier: string },
): Promise<void> {
  try {
    await SettingsModel.updateOne(
      { singleton: 'app', 'facultyTargets.url': url },
      {
        $set: {
          'facultyTargets.$.lastPeopleFound': result.peopleFound,
          'facultyTargets.$.lastFetchTier': result.fetchTier,
          'facultyTargets.$.lastCheckedAt': new Date(),
        },
      },
    ).exec();
    invalidateSettingsCache();
  } catch (error) {
    // Bookkeeping only — never fail a discovery run over it.
    console.error('[settings] could not record target result:', error);
  }
}
