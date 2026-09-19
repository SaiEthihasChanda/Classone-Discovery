/**
 * Source adapters — each returns normalised candidates and never throws.
 *
 * Every adapter catches its own failures and reports them in `SourceResult.errors`.
 * That is the rule that keeps one flaky university or a rate-limited API from
 * aborting an entire weekly run.
 */
import { env } from '../../config/env.js';
import { INDIAN_INSTITUTIONS, type InstitutionKind } from '../../data/indianInstitutions.js';
import type { InstrumentBrandConfig, KnownModel } from '../../data/instrumentBrands.js';
import type { TopicGroup } from '../../data/openAlexTopics.js';
import { brandSearchTerms, modelsToIdentify } from './keywords.js';
import { OpenAlexBudgetError } from '../../integrations/openAlexBudget.js';
import {
  getActiveInstitutionIds,
  getEnabledTargets,
} from '../settings/settingsService.js';
import { normalizeInstitutionKey } from '../../utils/normalize.js';
import { discoverViaNih, discoverViaNsf } from '../../integrations/grantClients.js';
import { discoverViaOpenAlex, lookupAuthorProfile } from '../../integrations/openAlexClient.js';
import { isExhausted } from '../../integrations/openAlexBudget.js';
import {
  isScraperAvailable,
  scrapeFacultyPages,
  scrapeNewsPages,
} from '../../integrations/scraperServiceClient.js';
import { DEFAULT_REGION, type DiscoveredCandidate, type DiscoveryRegion, type SourceResult } from './types.js';

// ---------------------------------------------------------------------------
// Adapters
//
// Scrape targets and institution selection come from the settings service
// (database-backed, editable in the UI), not from the YAML file directly. The
// file only seeds the initial values.
// ---------------------------------------------------------------------------

export interface ScrapeTarget {
  universityName: string;
  department?: string;
  url: string;
}

export interface OpenAlexTargeting {
  region?: DiscoveryRegion;
  institutionKinds?: InstitutionKind[];
  /** Specific institutes to search; overrides `institutionKinds`. */
  institutionIds?: string[];
  /** Brands to run full-text queries for. Empty or absent means no brand search. */
  instrumentBrands?: InstrumentBrandConfig[];
  /**
   * Topic groups to query by OpenAlex topic id — 1 credit per group instead of
   * 10 per keyword. Empty or absent means topic search is off.
   */
  topicGroups?: TopicGroup[];
  /**
   * After a brand turns up users, ask which model — one full-text query per
   * known model (10 credits each). Only runs for brands that found someone.
   */
  identifyModels?: boolean;
  /** How many years back the brand and model searches look. Default 7. */
  instrumentLookbackYears?: number;
}

/**
 * Fetches every page of a brand or model query, not just the first 200.
 *
 * Across 72 institutes a common instrument has well over 200 papers, and the
 * users on page two were simply never seen. Pages are fetched until a short
 * one comes back, up to a ceiling — each page is another 10 credits.
 */
async function fetchAllPages(
  params: Omit<Parameters<typeof discoverViaOpenAlex>[0], 'page'>,
  maxPages: number,
): Promise<DiscoveredCandidate[]> {
  const all: DiscoveredCandidate[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const found = await discoverViaOpenAlex({ ...params, page });
    all.push(...found);
    // Candidates are per author, so count works: a full page of works means
    // there may be more; the client cannot tell us the work count directly,
    // so use the distinct works seen as the proxy.
    const worksOnPage = new Set(found.map((c) => c.publications[0]?.sourceId ?? c.sourceUrl)).size;
    if (worksOnPage < MAX_RESULTS_PER_CALL) break;
  }
  return all;
}

/** The searchable company name for a brand: "Autolab (Metrohm)" → "Autolab". */
function brandCoreName(brand: InstrumentBrandConfig): string {
  return brand.brand.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
}

/**
 * The full-text expression that identifies one model. Distinctive numbers
 * stand alone; ordinary-looking ones are AND-ed with the brand, which is what
 * a space between terms means to OpenAlex.
 */
export function buildModelQuery(brand: InstrumentBrandConfig, model: KnownModel): string {
  const quote = (t: string) => (/[\s-]/.test(t) ? `"${t}"` : t);
  if (model.standalone) {
    // Papers write the same model both ways — "CHI660E" and "CHI 660E",
    // "PGSTAT302N" and "PGSTAT 302N" — and full-text search tokenises them
    // differently, so a standalone model is asked for in every spelling.
    return modelSpellings(model.model).map(quote).join(' OR ');
  }
  // BioLogic's name is unusable alone (it stems to "biological"), so the
  // co-term for its models is a phrase that does work.
  const core = brand.key === 'biologic' ? '"Bio Logic"' : quote(brandCoreName(brand));
  return `${core} ${quote(model.model)}`;
}

/**
 * The spellings a model number appears under: as written, with a space at
 * each letter/digit boundary ("CHI660E" → "CHI 660E"), and with hyphens or
 * spaces removed ("SP-150" → "SP150", "EmStat 4X" → "EmStat4X").
 */
export function modelSpellings(model: string): string[] {
  const out = new Set<string>([model]);
  const compact = model.replace(/[\s-]+/g, '');
  out.add(compact);
  // At the first letter/digit boundary, both a space and a hyphen are seen in
  // print: "CHI660E", "CHI 660E", "CHI-660E"; "EmStat4S", "EmStat 4S".
  const spaced = compact.replace(/^([A-Za-zµ]+)(\d)/, '$1 $2');
  if (spaced !== compact) {
    out.add(spaced);
    out.add(compact.replace(/^([A-Za-zµ]+)(\d)/, '$1-$2'));
  }
  // A trailing letter is often separated too: "CHI 660 E", "PGSTAT 302 N".
  const trailing = spaced.replace(/(\d)([A-Za-z])$/, '$1 $2');
  if (trailing !== spaced) out.add(trailing);
  return [...out].filter(Boolean);
}

/** Keyword phrases OR-ed into one search call. Five keeps the URL short and the ranking sane. */
const KEYWORDS_PER_CALL = 5;

/**
 * Turns a batch of keyword phrases into one OpenAlex search expression.
 * Each phrase is quoted so it matches as a phrase; five phrases in one call
 * costs the same 10 credits as one phrase alone.
 */
export function buildKeywordBatchQuery(phrases: string[]): string {
  return phrases
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (/[\s-]/.test(p) ? `"${p}"` : p))
    .join(' OR ');
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Interleaves result lists so a cap applied afterwards keeps the top of every
 * list rather than exhausting itself on the first.
 */
function roundRobin<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i += 1) {
    for (const list of lists) if (i < list.length) out.push(list[i]!);
  }
  return out;
}

/**
 * Builds the OpenAlex boolean expression for one brand: every term OR-ed,
 * multi-word and hyphenated terms quoted so they match as phrases — an unquoted
 * hyphen is parsed as an operator and "Bio-Logic" matches 200k works.
 *
 * The terms are derived, never typed: Class One's brands from the catalog's
 * model names, competitors from their company name (see `keywords.ts`).
 */
export function buildBrandQuery(brand: InstrumentBrandConfig): string {
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const raw of brandSearchTerms(brand)) {
    // A parenthesised owner is display text, not a search term: "Autolab
    // (Metrohm)" searches as "Autolab", which the alias list also holds.
    const term = raw.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    terms.push(/[\s-]/.test(term) ? `"${term}"` : term);
  }

  return terms.join(' OR ');
}

export async function fetchFromOpenAlex(
  queries: string[],
  sinceYear: number,
  targeting: OpenAlexTargeting = {},
): Promise<SourceResult> {
  const errors: string[] = [];
  let budgetExhausted = false;

  const brands = (targeting.instrumentBrands ?? []).filter(
    (b) => b.enabled && b.searchEnabled && brandSearchTerms(b).length > 0,
  );
  const topicGroups = targeting.topicGroups ?? [];
  const keywordBatches = chunk(queries.filter((q) => q.trim().length > 0), KEYWORDS_PER_CALL);

  // Page size is free at OpenAlex, so every call asks for a full page.
  const perCall = MAX_RESULTS_PER_CALL;

  // One failure mode, one message. Once the allowance is gone every further
  // call would fail identically, so stop issuing them and say so once.
  const noteBudgetGone = (): void => {
    if (budgetExhausted) return;
    budgetExhausted = true;
    errors.push(new OpenAlexBudgetError().message);
  };

  const region = targeting.region ?? DEFAULT_REGION;
  // A specific institute wins outright. Otherwise honour both the category
  // filter and any individually disabled institutes set on the Settings page.
  const institutionIds =
    targeting.institutionIds && targeting.institutionIds.length > 0
      ? targeting.institutionIds
      : region === 'indian_institutes'
        ? await getActiveInstitutionIds(targeting.institutionKinds)
        : undefined;
  const countryCode = !institutionIds && region === 'india' ? 'IN' : undefined;

  const perCallResults: DiscoveredCandidate[][] = [];

  // --- Topic-group calls: 1 credit each -----------------------------------
  for (const group of topicGroups) {
    if (budgetExhausted) break;
    try {
      perCallResults.push(
        await discoverViaOpenAlex({
          query: '',
          sinceYear,
          maxResults: perCall,
          institutionIds,
          countryCode,
          searchMode: 'topics',
          topicIds: group.topics.map((t) => t.id),
        }),
      );
    } catch (error) {
      if (error instanceof OpenAlexBudgetError) {
        noteBudgetGone();
        break;
      }
      errors.push(`OpenAlex topics "${group.label}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // --- Keyword calls: 10 credits each, five phrases per call --------------
  for (const batch of keywordBatches) {
    if (budgetExhausted) break;
    try {
      perCallResults.push(
        await discoverViaOpenAlex({
          query: buildKeywordBatchQuery(batch),
          sinceYear,
          maxResults: perCall,
          institutionIds,
          countryCode,
        }),
      );
    } catch (error) {
      if (error instanceof OpenAlexBudgetError) {
        noteBudgetGone();
        break;
      }
      errors.push(`OpenAlex "${batch.join(' / ')}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const topicCandidates = roundRobin(perCallResults);
  const brandCandidates: DiscoveredCandidate[] = [];

  // --- Brand queries: full text -------------------------------------------
  // One query per brand, so each hit is attributable: a work returned for the
  // Gamry query is a Gamry user. Full text because instrument names live in
  // methods sections, which abstracts almost never repeat.
  //
  // Every author at the target institution is taken, not just the
  // corresponding one — the instrument belongs to the lab, and the PI who
  // bought it is usually listed last. And the look-back is wider than for
  // topic queries: a potentiostat bought in 2019 is still on the bench.
  const lookback = targeting.instrumentLookbackYears ?? INSTRUMENT_LOOKBACK_YEARS;
  const brandSinceYear = Math.min(sinceYear, new Date().getFullYear() - lookback);

  for (const brand of brands) {
    if (budgetExhausted) break;
    const query = buildBrandQuery(brand);
    try {
      const found = await fetchAllPages(
        {
          query,
          sinceYear: brandSinceYear,
          maxResults: BRAND_WORKS_PER_QUERY,
          institutionIds,
          countryCode,
          searchMode: 'fulltext',
          allTargetAuthors: true,
        },
        MAX_PAGES_PER_INSTRUMENT_QUERY,
      );

      for (const candidate of found) {
        const paper = candidate.publications[0]?.title;
        candidate.instruments = [
          {
            brandKey: brand.key,
            brand: brand.brand,
            vendor: brand.vendor,
            evidence: paper
              ? `Full text of "${paper}" mentions ${brand.brand}.`
              : `A recent paper's full text mentions ${brand.brand}.`,
            sourceUrl: candidate.sourceUrl,
            matchedVia: 'fulltext_search',
          },
        ];
      }

      brandCandidates.push(...found);

      // --- Which model? One query per known model, only when someone uses the
      // brand at all. The abstract we hold almost never names the instrument,
      // so this is the only way the specific device reaches the lead.
      if (targeting.identifyModels && found.length > 0) {
        for (const model of modelsToIdentify(brand)) {
          if (budgetExhausted) break;
          try {
            const users = await fetchAllPages(
              {
                query: buildModelQuery(brand, model),
                sinceYear: brandSinceYear,
                maxResults: BRAND_WORKS_PER_QUERY,
                institutionIds,
                countryCode,
                searchMode: 'fulltext',
                allTargetAuthors: true,
              },
              MAX_PAGES_PER_INSTRUMENT_QUERY,
            );
            for (const candidate of users) {
              const paper = candidate.publications[0]?.title;
              candidate.instruments = [
                {
                  brandKey: brand.key,
                  brand: brand.brand,
                  vendor: brand.vendor,
                  model: model.model,
                  evidence: paper
                    ? `Full text of "${paper}" mentions the ${model.model}.`
                    : `A recent paper's full text mentions the ${model.model}.`,
                  sourceUrl: candidate.sourceUrl,
                  matchedVia: 'fulltext_search',
                },
              ];
            }
            brandCandidates.push(...users);
          } catch (error) {
            if (error instanceof OpenAlexBudgetError) {
              noteBudgetGone();
              break;
            }
            errors.push(
              `OpenAlex model search "${model.model}": ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof OpenAlexBudgetError) {
        noteBudgetGone();
        break;
      }
      errors.push(
        `OpenAlex brand search "${brand.brand}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    source: 'openalex',
    candidates: [...topicCandidates, ...brandCandidates],
    errors,
    budgetExhausted,
  };
}

/**
 * Credits a run will spend on OpenAlex, before it starts. Cache hits make the
 * real figure lower, never higher.
 */
export function estimateOpenAlexCredits(input: {
  topicGroups: number;
  keywords: number;
  brands: number;
  /** Model-identification queries; the worst case, since brands with no users skip theirs. */
  models?: number;
}): number {
  return (
    input.topicGroups * 1 +
    Math.ceil(input.keywords / KEYWORDS_PER_CALL) * 10 +
    input.brands * 10 +
    (input.models ?? 0) * 10
  );
}

/** How many model queries a run could issue, for the cost estimate. */
export function countModelQueries(brands: InstrumentBrandConfig[]): number {
  return brands
    .filter((b) => b.enabled && b.searchEnabled)
    .reduce((sum, b) => sum + modelsToIdentify(b).length, 0);
}

/**
 * Works fetched per OpenAlex call — its page maximum, and the same credit cost
 * as asking for one. There is deliberately no cap on how many candidates a run
 * produces: the cost driver is the number of CALLS, not the number of results.
 */
const MAX_RESULTS_PER_CALL = 200;
/** Works fetched per brand query page. */
const BRAND_WORKS_PER_QUERY = MAX_RESULTS_PER_CALL;
/**
 * Pages a brand or model query may fetch — 5 × 200 = 1,000 works. Autolab
 * across every IIT runs to several hundred papers; a brand that needs more
 * than a thousand is not one whose users we are short of.
 */
const MAX_PAGES_PER_INSTRUMENT_QUERY = 5;
/** How far back brand searches look by default, regardless of the topic-query window. */
export const INSTRUMENT_LOOKBACK_YEARS = 7;

/**
 * True if a scrape target belongs to one of the selected institutes.
 *
 * Target names in the seed file use the full OpenAlex names ("Indian Institute
 * of Technology Delhi"), so a normalised equality check is usually exact; the
 * containment fallback covers hand-entered short forms.
 */
export function targetMatchesInstitutions(
  universityName: string,
  institutionIds: string[] | undefined,
): boolean {
  if (!institutionIds || institutionIds.length === 0) return true;

  const wanted = new Set(institutionIds);
  // Hand-entered targets often use the short form; expand it so "IIT Madras"
  // compares equal to the full OpenAlex name.
  const expanded = universityName
    .replace(/\bIIIT\b/gi, 'Indian Institute of Information Technology')
    .replace(/\bIIT\b/gi, 'Indian Institute of Technology')
    .replace(/\bNIT\b/gi, 'National Institute of Technology');
  const targetKey = normalizeInstitutionKey(expanded);
  if (!targetKey) return false;

  return INDIAN_INSTITUTIONS.some((inst) => {
    if (!wanted.has(inst.openAlexId)) return false;
    const key = normalizeInstitutionKey(inst.name);
    if (!key) return false;
    return key === targetKey || key.includes(targetKey) || targetKey.includes(key);
  });
}

export async function fetchFromGrants(
  queries: string[],
  sinceYear: number,
  agencies: Array<'nih' | 'nsf'>,
): Promise<SourceResult> {
  const candidates: DiscoveredCandidate[] = [];
  const errors: string[] = [];
  // US funders are a secondary source; a page each keeps them from dominating.
  const perQuery = 50;

  for (const query of queries) {
    if (agencies.includes('nih')) {
      try {
        candidates.push(...(await discoverViaNih({ query, sinceYear, maxResults: perQuery })));
      } catch (error) {
        errors.push(`NIH "${query}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (agencies.includes('nsf')) {
      try {
        candidates.push(...(await discoverViaNsf({ query, maxResults: perQuery })));
      } catch (error) {
        errors.push(`NSF "${query}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { source: 'grants', candidates, errors };
}

export async function fetchFromFacultyPages(
  enrichFromOpenAlex = true,
  institutionIds?: string[],
): Promise<SourceResult> {
  const errors: string[] = [];
  const { faculty: allFaculty } = await getEnabledTargets();
  const faculty = allFaculty.filter((t) => targetMatchesInstitutions(t.universityName, institutionIds));

  if (faculty.length === 0) {
    return {
      source: 'faculty',
      candidates: [],
      errors: [
        allFaculty.length === 0
          ? 'No enabled faculty targets configured'
          : 'No enabled faculty targets for the selected institute',
      ],
    };
  }

  if (!(await isScraperAvailable())) {
    return {
      source: 'faculty',
      candidates: [],
      errors: [`Scraper service unreachable at ${env.SCRAPER_SERVICE_URL} — skipping`],
    };
  }

  const candidates: DiscoveredCandidate[] = [];

  try {
    const response = await scrapeFacultyPages(
      faculty.map((t) => ({ university_name: t.universityName, faculty_page_url: t.url })),
    );

    for (const error of response.errors) {
      errors.push(`${error.target}: ${error.reason}${error.detail ? ` (${error.detail})` : ''}`);
    }

    for (const result of response.results) {
      const department = faculty.find((t) => t.url === result.source_url)?.department;

      for (const person of result.extracted) {
        candidates.push({
          sourceType: 'faculty_page',
          // No stable upstream id exists, so derive one from the page and name.
          sourceRecordId: `faculty:${new URL(result.source_url).hostname}:${person.name.toLowerCase().replace(/\s+/g, '-')}`,
          sourceUrl: person.profile_url ?? result.source_url,
          name: person.name,
          email: person.email ?? undefined,
          title: person.title ?? undefined,
          profileUrl: person.profile_url ?? undefined,
          institutionName: result.university_name,
          department: person.department ?? department,
          publications: [],
          grants: [],
          topics: [],
          evidenceText: (person.bio ?? `${person.name} — ${person.title ?? 'faculty member'} at ${result.university_name}`).slice(0, 1500),
        });
      }
    }
  } catch (error) {
    errors.push(`Faculty scrape failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (enrichFromOpenAlex && candidates.length > 0) {
    const enrichErrors = await attachOpenAlexProfiles(candidates);
    errors.push(...enrichErrors);
  }

  return { source: 'faculty', candidates, errors };
}

/**
 * Attaches each scraped person's OpenAlex publication record, in place.
 *
 * This is what makes faculty-page leads usable. Scraping gives a name, a title
 * and often an email but no research evidence, so the scorer rates them near
 * zero — leaving the only contactable leads ranked worst. Adding their real
 * publication record fixes the score while keeping the email.
 *
 * Runs in small concurrent batches: OpenAlex asks for courtesy rather than
 * enforcing a hard limit, and a 40-person faculty list issued all at once is
 * not courteous.
 */
async function attachOpenAlexProfiles(candidates: DiscoveredCandidate[]): Promise<string[]> {
  const errors: string[] = [];
  const BATCH_SIZE = 4;

  // Maps a scraped university name onto its OpenAlex id so the author lookup can
  // be disambiguated — essential for common names.
  const institutionIdByName = new Map(
    INDIAN_INSTITUTIONS.map((i) => [i.name.toLowerCase(), i.openAlexId]),
  );

  const resolveInstitutionId = (name?: string): string | undefined => {
    if (!name) return undefined;
    const key = name.toLowerCase();
    if (institutionIdByName.has(key)) return institutionIdByName.get(key);
    // Scraped names are not always exact ("IIIT Hyderabad" vs the full title).
    for (const [known, id] of institutionIdByName) {
      if (known.includes(key) || key.includes(known)) return id;
    }
    return undefined;
  };

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    // Stop as soon as the allowance runs out rather than issuing dozens of
    // doomed requests and silently leaving every remaining lead unscored.
    if (isExhausted()) {
      errors.push(
        `OpenAlex budget exhausted — ${candidates.length - i} faculty leads left unenriched ` +
          `(they will score low until the allowance resets at midnight UTC)`,
      );
      break;
    }

    const batch = candidates.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (candidate) => {
        try {
          const profile = await lookupAuthorProfile({
            name: candidate.name,
            institutionId: resolveInstitutionId(candidate.institutionName),
            institutionName: candidate.institutionName,
            // One call per person. Fetching works too would double the credit
            // cost and blow the daily allowance on a single faculty list.
            includeWorks: false,
          });

          if (!profile?.matched) return;

          // Scraped data wins on contact details (an email from the institution's
          // own page is more trustworthy); OpenAlex wins on research evidence.
          candidate.orcid ??= profile.orcid;
          candidate.profileUrl ??= profile.profileUrl;
          candidate.topics = profile.topics;
          candidate.publications = profile.publications;
          candidate.evidenceText =
            `${candidate.evidenceText}\n\n${profile.evidenceText}`.slice(0, 2500);
        } catch (error) {
          errors.push(
            `OpenAlex lookup for "${candidate.name}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  }

  return errors;
}

/**
 * News is an ENGAGEMENT signal, not a lead source.
 *
 * An article does not give you an email or an institution — but it does tell you
 * a named researcher is newsworthy right now. These candidates carry the
 * mentioned name and headline so dedupe can attach them to an existing lead;
 * ones that match nobody score low and get filtered at review.
 */
export async function fetchFromNews(institutionIds?: string[]): Promise<SourceResult> {
  const errors: string[] = [];
  const { news: allNews } = await getEnabledTargets();
  const news = allNews.filter((t) => targetMatchesInstitutions(t.universityName, institutionIds));

  if (news.length === 0) {
    return {
      source: 'news',
      candidates: [],
      errors: [
        allNews.length === 0
          ? 'No enabled news targets configured'
          : 'No enabled news feeds for the selected institute',
      ],
    };
  }

  if (!(await isScraperAvailable())) {
    return {
      source: 'news',
      candidates: [],
      errors: [`Scraper service unreachable at ${env.SCRAPER_SERVICE_URL} — skipping`],
    };
  }

  const candidates: DiscoveredCandidate[] = [];

  try {
    const response = await scrapeNewsPages(
      news.map((t) => ({ university_name: t.universityName, news_page_url: t.url })),
    );

    for (const error of response.errors) {
      errors.push(`${error.target}: ${error.reason}${error.detail ? ` (${error.detail})` : ''}`);
    }

    for (const result of response.results) {
      for (const item of result.extracted) {
        for (const name of item.mentioned_names) {
          candidates.push({
            sourceType: 'university_news',
            sourceRecordId: `news:${name.toLowerCase().replace(/\s+/g, '-')}`,
            sourceUrl: item.url ?? result.source_url,
            name,
            institutionName: undefined,
            publications: [],
            grants: [],
            topics: [],
            evidenceText: [item.title, item.summary].filter(Boolean).join('. ').slice(0, 1500),
          });
        }
      }
    }
  } catch (error) {
    errors.push(`News scrape failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { source: 'news', candidates, errors };
}
