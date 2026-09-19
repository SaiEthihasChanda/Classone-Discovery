/**
 * OpenAlex — the primary discovery source.
 *
 * A free, structured, public API over ~250M scholarly works. No key, no
 * scraping. Supplying a contact email puts requests in the "polite pool", which
 * is faster and more reliable, so `OPENALEX_MAILTO` is passed when set.
 *
 * Strategy: search recent WORKS matching Class One's product domain, then pull
 * the authors off them. A researcher who just published on electrochemical
 * impedance is a far better lead than one who merely lists it as an interest.
 */
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { OpenAlexCacheModel } from '../models/openAlexCache.model.js';
import type { DiscoveredCandidate } from '../services/discovery/types.js';
import type { LeadPublication } from '../types/domain.js';
import {
  hasBudgetFor,
  markExhausted,
  OpenAlexBudgetError,
  recordBudgetHeaders,
} from './openAlexBudget.js';
import { openAlexLimiter } from './rateLimiter.js';

const BASE_URL = 'https://api.openalex.org';

/**
 * What OpenAlex charges, measured from its `X-RateLimit-Credits-Used` header
 * (Sept 2026 pricing): any call with free text — the `search` parameter or a
 * `.search:` filter — costs 10 credits; a filter-only list call costs 1; and
 * the page size changes neither. Single-record lookups by id are free.
 */
export const CREDITS_SEARCH_CALL = 10;
export const CREDITS_FILTER_CALL = 1;

/** OpenAlex's maximum page size. Costs the same as asking for one result. */
export const MAX_PAGE_SIZE = 200;

/** True if a request URL contains free-text search and so bills at the higher rate. */
function isSearchCall(url: URL): boolean {
  if (url.searchParams.has('search')) return true;
  return /(^|,)[a-z_.]*\.search:/.test(url.searchParams.get('filter') ?? '');
}

/** Cache key: the URL with credentials removed, hashed. */
function cacheKeyFor(url: URL): { key: string; canonical: string } {
  const stripped = new URL(url.toString());
  stripped.searchParams.delete('api_key');
  stripped.searchParams.delete('mailto');
  stripped.searchParams.sort();
  const canonical = stripped.toString();
  return { key: createHash('sha256').update(canonical).digest('hex'), canonical };
}

/** Cache reads/writes must never break a request — no DB, no cache, carry on. */
async function readCache<T>(key: string): Promise<T | null> {
  if (mongoose.connection.readyState !== 1) return null;
  try {
    const hit = await OpenAlexCacheModel.findOne({ key }).lean().exec();
    return (hit?.body as T) ?? null;
  } catch {
    return null;
  }
}

async function writeCache(key: string, canonical: string, body: unknown, credits: number): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;
  try {
    await OpenAlexCacheModel.updateOne(
      { key },
      { $set: { url: canonical, body, creditsSaved: credits, createdAt: new Date() } },
      { upsert: true },
    ).exec();
  } catch {
    // Best effort.
  }
}

let cacheHitsThisProcess = 0;
let creditsSavedThisProcess = 0;

/** For the config endpoint — how much the cache has been worth since boot. */
export function getCacheStats(): { hits: number; creditsSaved: number } {
  return { hits: cacheHitsThisProcess, creditsSaved: creditsSavedThisProcess };
}

/**
 * Every OpenAlex request goes through here, which is what makes the rate limit
 * and the daily credit budget enforceable globally — no matter how many
 * discovery sources are running in parallel.
 *
 * Uses `fetch` directly rather than the shared helper so the rate-limit headers
 * can be read off the response; the helper only returns a parsed body.
 */
async function fetchOpenAlex<T>(url: string, estimatedCredits?: number): Promise<T> {
  const finalUrl = new URL(url);
  const credits = estimatedCredits ?? (isSearchCall(finalUrl) ? CREDITS_SEARCH_CALL : CREDITS_FILTER_CALL);
  // Single-record lookups (/works/W123) are free and uncapped at OpenAlex, so
  // they must not be refused by the reserve that protects paid calls.
  const isFree = credits === 0;

  // Identical request in the last 24 hours? Serve it without spending anything
  // — and without consulting the budget, since a cache hit is free even when
  // the allowance is gone.
  const { key, canonical } = cacheKeyFor(finalUrl);
  const cached = await readCache<T>(key);
  if (cached) {
    cacheHitsThisProcess += 1;
    creditsSavedThisProcess += credits;
    return cached;
  }

  if (!isFree && !hasBudgetFor(credits)) {
    throw new OpenAlexBudgetError();
  }

  await openAlexLimiter.acquire();

  // The free API key raises the daily allowance from $0.10 to $1.00, so it is
  // attached to every request when configured. Passed as a query parameter,
  // which is the form OpenAlex documents.
  if (env.OPENALEX_API_KEY) {
    finalUrl.searchParams.set('api_key', env.OPENALEX_API_KEY);
  }

  const response = await fetch(finalUrl.toString(), {
    headers: {
      'User-Agent': 'ClassOneSalesBot/1.0 (academic lead research)',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(20_000),
  });

  recordBudgetHeaders(response.headers);

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    markExhausted(Number.isFinite(retryAfter) ? retryAfter : null);
    throw new OpenAlexBudgetError();
  }

  if (!response.ok) {
    // Never echo the URL back — it carries the api_key.
    throw new Error(`OpenAlex ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as T;
  await writeCache(key, canonical, body, credits);
  return body;
}


interface OpenAlexAuthor {
  id?: string;
  display_name?: string;
  orcid?: string;
}

interface OpenAlexInstitution {
  id?: string;
  display_name?: string;
  country_code?: string;
  type?: string;
}

interface OpenAlexAuthorship {
  author?: OpenAlexAuthor;
  institutions?: OpenAlexInstitution[];
  is_corresponding?: boolean;
  raw_affiliation_strings?: string[];
}

interface OpenAlexWork {
  id?: string;
  doi?: string;
  title?: string;
  publication_year?: number;
  authorships?: OpenAlexAuthorship[];
  topics?: { display_name?: string }[];
  abstract_inverted_index?: Record<string, number[]>;
}

interface OpenAlexResponse {
  meta?: { count?: number };
  results?: OpenAlexWork[];
}

/**
 * Rebuilds abstract text from OpenAlex's inverted index.
 *
 * OpenAlex stores abstracts as {word: [positions]} for licensing reasons, so the
 * prose has to be reassembled by placing each word at its recorded positions.
 */
function reconstructAbstract(index?: Record<string, number[]>): string {
  if (!index) return '';

  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) {
      words[position] = word;
    }
  }
  // Gaps are possible if the index is sparse; filter them out.
  return words.filter(Boolean).join(' ');
}

/**
 * Finds researchers via their recent publications.
 *
 * Only corresponding authors (falling back to first authors) are taken: they are
 * the ones who typically specify and purchase lab equipment, and it keeps a
 * 40-author collaboration paper from producing 40 weak leads.
 */
export async function discoverViaOpenAlex(params: {
  query: string;
  sinceYear: number;
  maxResults: number;
  /**
   * OpenAlex institution ids to restrict results to (see `data/indianInstitutions.ts`).
   * Filtering server-side means we never download records we would only discard.
   * `lineage` rather than `id` so a department or centre under a parent
   * institution still matches its parent.
   */
  institutionIds?: string[];
  /** ISO country code, e.g. "IN". Broader alternative to a specific institution list. */
  countryCode?: string;
  /**
   * `title_abstract` (default) matches topic phrases against titles and
   * abstracts. `fulltext` uses OpenAlex's `search` parameter, which also
   * covers the full text where OpenAlex has it — the only place an instrument
   * brand ("measured on a PalmSens4") is normally written, since it lives in
   * the methods section, not the abstract. The query may use OR and quoted
   * phrases in this mode.
   *
   * `topics` ignores `query` and filters on OpenAlex topic ids instead
   * (`topicIds`). No free text means a 1-credit call instead of 10, and with
   * no relevance ranking available the results are sorted most-cited first
   * within the year window — for lead purposes, a fine proxy for "active,
   * funded group".
   */
  searchMode?: 'title_abstract' | 'fulltext' | 'topics';
  /** Required for `searchMode: 'topics'`. OR-ed together. */
  topicIds?: string[];
  /**
   * Emit a candidate for EVERY author affiliated with a target institution,
   * not just the corresponding one. Used by the instrument-brand search: the
   * instrument belongs to the lab, so the PI listed last and the student
   * listed first both used it. Falls back to the corresponding author when
   * no institution or country filter is in force.
   */
  allTargetAuthors?: boolean;
  /**
   * Which 200-work page to fetch (1-based). A brand or model used widely
   * across 72 institutes has more than 200 papers; callers page until a short
   * page comes back. Each page is its own call and its own credits.
   */
  page?: number;
}): Promise<DiscoveredCandidate[]> {
  const fullText = params.searchMode === 'fulltext';
  const byTopic = params.searchMode === 'topics';
  if (byTopic && (!params.topicIds || params.topicIds.length === 0)) return [];

  const filterParts = [
    ...(fullText || byTopic ? [] : [`title_and_abstract.search:${params.query}`]),
    ...(byTopic ? [`primary_topic.id:${params.topicIds!.join('|')}`] : []),
    `publication_year:>${params.sinceYear - 1}`,
    'is_paratext:false',
  ];

  if (params.institutionIds && params.institutionIds.length > 0) {
    // Pipe means OR within a single filter. A ~72-id list produces a ~1.1 KB
    // URL, comfortably inside limits.
    filterParts.push(`authorships.institutions.lineage:${params.institutionIds.join('|')}`);
  } else if (params.countryCode) {
    filterParts.push(`authorships.institutions.country_code:${params.countryCode.toLowerCase()}`);
  }

  const filters = filterParts.join(',');

  const url = new URL(`${BASE_URL}/works`);
  url.searchParams.set('filter', filters);
  if (fullText) url.searchParams.set('search', params.query);
  // Page size is free, so always take what was asked for up to the maximum.
  url.searchParams.set('per-page', String(Math.min(params.maxResults, MAX_PAGE_SIZE)));
  if (params.page && params.page > 1) url.searchParams.set('page', String(params.page));
  // Topic calls have no relevance score to sort by; most-cited recent work is
  // the next best signal of a group worth contacting.
  if (byTopic) url.searchParams.set('sort', 'cited_by_count:desc');
  // NO explicit sort — OpenAlex defaults to relevance ranking when a search
  // filter is present, and that is what we want. Sorting by publication_year
  // instead returns the NEWEST papers matching any term rather than the best
  // matches, which pulled in genuinely off-topic work (a longevity paper turned
  // up under an impedance-spectroscopy query). Recency is already handled by the
  // publication_year filter above.
  if (env.OPENALEX_MAILTO) url.searchParams.set('mailto', env.OPENALEX_MAILTO);

  const data = await fetchOpenAlex<OpenAlexResponse>(url.toString());
  const candidates: DiscoveredCandidate[] = [];

  const targetIds = new Set(params.institutionIds ?? []);
  const targetCountry = params.countryCode?.toUpperCase();

  for (const work of data.results ?? []) {
    const authorships = work.authorships ?? [];
    if (authorships.length === 0) continue;

    // A work matches the institution filter if ANY author is affiliated there —
    // which on an international collaboration is often not the corresponding
    // author. Prefer an author actually at one of the target institutions,
    // otherwise the lead gets attributed to the wrong country entirely.
    const atTargetInstitution = (a: OpenAlexAuthorship): boolean =>
      targetIds.size > 0 &&
      (a.institutions ?? []).some((inst) => {
        const id = inst.id?.split('/').pop();
        return id ? targetIds.has(id) : false;
      });
    const inTargetCountry = (a: OpenAlexAuthorship): boolean =>
      Boolean(targetCountry) &&
      (a.institutions ?? []).some((inst) => inst.country_code?.toUpperCase() === targetCountry);

    let chosenAuthorships: OpenAlexAuthorship[];
    if (params.allTargetAuthors && (targetIds.size > 0 || targetCountry)) {
      chosenAuthorships = authorships.filter((a) =>
        targetIds.size > 0 ? atTargetInstitution(a) : inTargetCountry(a),
      );
    } else {
      const chosen =
        // Best case: corresponding author who is also at a target institution.
        authorships.find((a) => a.is_corresponding && atTargetInstitution(a)) ??
        authorships.find((a) => atTargetInstitution(a)) ??
        authorships.find((a) => a.is_corresponding) ??
        authorships[0];
      chosenAuthorships = chosen ? [chosen] : [];
    }

    const abstract = reconstructAbstract(work.abstract_inverted_index);
    const topics = (work.topics ?? [])
      .map((t) => t.display_name)
      .filter((t): t is string => Boolean(t));

    for (const chosen of chosenAuthorships) {
      const author = chosen.author;
      if (!author?.display_name || !author.id) continue;

      // An author often lists several affiliations on one work — a research centre,
      // a department, and the parent institute. Record the TARGET institution when
      // one is present: "Indian Institute of Technology Indore" is a useful CRM
      // record, "Centre of Excellence for Advanced Materials" is not.
      const affiliations = chosen.institutions ?? [];
      const institution =
        affiliations.find((inst) => {
          const id = inst.id?.split('/').pop();
          return id ? targetIds.has(id) : false;
        }) ?? affiliations[0];

      candidates.push({
        sourceType: 'openalex',
        // The OpenAlex author id is stable and globally unique — ideal for dedupe.
        sourceRecordId: author.id,
        sourceUrl: work.doi ?? work.id,
        name: author.display_name,
        orcid: author.orcid?.replace('https://orcid.org/', ''),
        profileUrl: author.id,
        institutionName: institution?.display_name ?? chosen.raw_affiliation_strings?.[0],
        country: institution?.country_code,
        publications: work.title
          ? [
              {
                title: work.title,
                year: work.publication_year,
                url: work.doi ?? work.id,
                sourceId: work.id,
              },
            ]
          : [],
        grants: [],
        topics,
        // Abstracts run long; trim before this ever reaches a prompt.
        evidenceText: [work.title, abstract].filter(Boolean).join('. ').slice(0, 1500),
      });
    }
  }

  return candidates;
}

export interface OpenAccessLocation {
  workId: string;
  title?: string;
  isOpenAccess: boolean;
  /** Direct PDF when OpenAlex knows one — the best input for the Methods reader. */
  pdfUrl?: string;
  /** The open landing page (publisher HTML, PMC, a repository) otherwise. */
  landingPageUrl?: string;
}

/**
 * Where a work can be read for free, if anywhere.
 *
 * A single-record lookup, which OpenAlex does not charge for — so resolving a
 * lead's five recent papers costs nothing, and only the ones that are genuinely
 * open get fetched by the scraper. Papers OpenAlex has no full text for are
 * exactly the ones this exists to reach.
 */
export async function getOpenAccessLocation(workId: string): Promise<OpenAccessLocation | null> {
  const id = workId.split('/').pop();
  if (!id || !/^W\d+$/.test(id)) return null;

  const url = new URL(`${BASE_URL}/works/${id}`);
  url.searchParams.set('select', 'id,title,open_access,best_oa_location,primary_location');
  if (env.OPENALEX_MAILTO) url.searchParams.set('mailto', env.OPENALEX_MAILTO);

  interface Location {
    is_oa?: boolean;
    pdf_url?: string | null;
    landing_page_url?: string | null;
  }
  interface WorkRecord {
    id?: string;
    title?: string;
    open_access?: { is_oa?: boolean };
    best_oa_location?: Location | null;
    primary_location?: Location | null;
  }

  let work: WorkRecord;
  try {
    work = await fetchOpenAlex<WorkRecord>(url.toString(), 0);
  } catch {
    return null;
  }

  const best = work.best_oa_location ?? (work.primary_location?.is_oa ? work.primary_location : null);
  return {
    workId: id,
    title: work.title,
    isOpenAccess: Boolean(work.open_access?.is_oa && best),
    pdfUrl: best?.pdf_url ?? undefined,
    landingPageUrl: best?.landing_page_url ?? undefined,
  };
}

/**
 * A researcher's own papers whose full text matches a query — the basis of the
 * per-lead instrument scan.
 *
 * The bulk discovery run is institute-scoped and page-capped, so it sees a
 * researcher's most relevant paper or two; this asks OpenAlex about ONE
 * author's whole recent output, which is how every instrument a group has
 * written up gets attached to them rather than only the one that happened to
 * surface. Costs a search call (10 credits) per query.
 */
export async function searchAuthorWorks(params: {
  /** OpenAlex author id, "A5072493084" or its URL form. */
  authorId: string;
  /** Full-text expression: brand or model terms, quoted and OR-ed as needed. */
  query: string;
  sinceYear: number;
}): Promise<LeadPublication[]> {
  const id = params.authorId.split('/').pop()!;

  const url = new URL(`${BASE_URL}/works`);
  url.searchParams.set(
    'filter',
    [`authorships.author.id:${id}`, `publication_year:>${params.sinceYear - 1}`, 'is_paratext:false'].join(','),
  );
  url.searchParams.set('search', params.query);
  url.searchParams.set('per-page', String(MAX_PAGE_SIZE));
  url.searchParams.set('select', 'id,doi,title,publication_year');
  if (env.OPENALEX_MAILTO) url.searchParams.set('mailto', env.OPENALEX_MAILTO);

  const data = await fetchOpenAlex<OpenAlexResponse>(url.toString());
  return (data.results ?? [])
    .filter((w) => w.title)
    .map((w) => ({ title: w.title!, year: w.publication_year, url: w.doi ?? w.id, sourceId: w.id }));
}

/**
 * Looks up a named researcher's publication record.
 *
 * WHY THIS EXISTS: faculty-page scraping yields a name, a title and often an
 * email — but no research evidence, so the scorer sees almost nothing and rates
 * them near zero. The result was perverse: the only leads we could actually
 * contact were the ones ranked worst. Pairing the scraped name with its OpenAlex
 * record gives that lead both an email AND a real score.
 *
 * Constrained by institution id when known, which is what makes this safe for
 * common names — "Rahul Verma" alone is ambiguous, "Rahul Verma at IIT Delhi"
 * usually is not.
 */
export async function lookupAuthorProfile(params: {
  name: string;
  /** OpenAlex institution id to disambiguate against, e.g. "I68891433". */
  institutionId?: string;
  institutionName?: string;
  maxWorks?: number;
  /** Also fetch recent works. Doubles the credit cost — used for single lookups only. */
  includeWorks?: boolean;
}): Promise<{
  matched: boolean;
  orcid?: string;
  profileUrl?: string;
  institutionName?: string;
  topics: string[];
  publications: LeadPublication[];
  evidenceText: string;
} | null> {
  const filters = [`display_name.search:${params.name}`];
  if (params.institutionId) {
    filters.push(`last_known_institutions.id:${params.institutionId}`);
  }

  const url = new URL(`${BASE_URL}/authors`);
  url.searchParams.set('filter', filters.join(','));
  url.searchParams.set('per-page', '3');
  if (env.OPENALEX_MAILTO) url.searchParams.set('mailto', env.OPENALEX_MAILTO);

  interface AuthorHit {
    id?: string;
    display_name?: string;
    orcid?: string;
    works_count?: number;
    cited_by_count?: number;
    last_known_institutions?: OpenAlexInstitution[];
    topics?: { display_name?: string; count?: number }[];
  }

  const data = await fetchOpenAlex<{ results?: AuthorHit[] }>(url.toString());
  const author = data.results?.[0];

  // No match, or an author with no output — nothing worth attaching.
  if (!author?.id || !author.display_name || (author.works_count ?? 0) === 0) {
    return { matched: false, topics: [], publications: [], evidenceText: '' };
  }

  const topics = (author.topics ?? [])
    .map((t) => t.display_name)
    .filter((t): t is string => Boolean(t))
    .slice(0, 10);

  // Fetching each author's recent works would double the credit cost of every
  // enrichment — and at 10 credits a call against a 1000/day allowance, a single
  // 58-person faculty run would exhaust the entire budget. The author record's
  // own `topics` are derived from exactly that publication history and are
  // enough to score against, so the second call is only made when explicitly
  // asked for (the by-name lookup, which is one researcher at a time).
  let publications: LeadPublication[] = [];
  let abstracts = '';

  if (params.includeWorks) {
    const worksUrl = new URL(`${BASE_URL}/works`);
    worksUrl.searchParams.set('filter', `authorships.author.id:${author.id.split('/').pop()}`);
    worksUrl.searchParams.set('per-page', String(params.maxWorks ?? 5));
    worksUrl.searchParams.set('sort', 'publication_year:desc');
    if (env.OPENALEX_MAILTO) worksUrl.searchParams.set('mailto', env.OPENALEX_MAILTO);

    try {
      const works = await fetchOpenAlex<OpenAlexResponse>(worksUrl.toString());
      publications = (works.results ?? [])
        .filter((w) => w.title)
        .map((w) => ({
          title: w.title!,
          year: w.publication_year,
          url: w.doi ?? w.id,
          sourceId: w.id,
        }));
      abstracts = (works.results ?? [])
        .slice(0, 2)
        .map((w) => reconstructAbstract(w.abstract_inverted_index))
        .filter(Boolean)
        .join(' ');
    } catch {
      // A bonus, not a requirement — topics alone still score usefully.
    }
  }

  const institution = author.last_known_institutions?.[0];

  return {
    matched: true,
    orcid: author.orcid?.replace('https://orcid.org/', ''),
    profileUrl: author.id,
    institutionName: institution?.display_name ?? params.institutionName,
    topics,
    publications,
    evidenceText: [
      topics.length > 0 ? `Research topics: ${topics.join(', ')}.` : '',
      publications.length > 0
        ? `Recent work: ${publications.map((p) => p.title).join('; ')}.`
        : '',
      abstracts,
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, 1800),
  };
}

/**
 * Looks up one researcher by name — backs the manual "feed a name to the
 * discovery engine" entry point from the proposal.
 */
export async function findAuthorByName(
  name: string,
  /**
   * OpenAlex institution id to restrict the match to. Turns "Rahul Verma"
   * (hundreds of them) into "Rahul Verma at IIT Delhi" (usually one).
   */
  institutionId?: string,
): Promise<DiscoveredCandidate[]> {
  const url = new URL(`${BASE_URL}/authors`);
  url.searchParams.set('search', name);
  if (institutionId) {
    // lineage rather than id, so someone whose last affiliation is a department
    // or centre under the institute still matches.
    url.searchParams.set('filter', `affiliations.institution.lineage:${institutionId}`);
  }
  url.searchParams.set('per-page', '5');
  if (env.OPENALEX_MAILTO) url.searchParams.set('mailto', env.OPENALEX_MAILTO);

  interface AuthorSearchResponse {
    results?: Array<{
      id?: string;
      display_name?: string;
      orcid?: string;
      works_count?: number;
      last_known_institutions?: OpenAlexInstitution[];
      topics?: { display_name?: string }[];
    }>;
  }

  const data = await fetchOpenAlex<AuthorSearchResponse>(url.toString());

  return (data.results ?? [])
    .filter((a) => a.id && a.display_name)
    .map((author) => {
      const institution = author.last_known_institutions?.[0];
      const topics = (author.topics ?? [])
        .map((t) => t.display_name)
        .filter((t): t is string => Boolean(t));

      return {
        sourceType: 'manual_discovery_trigger' as const,
        sourceRecordId: author.id!,
        sourceUrl: author.id,
        name: author.display_name!,
        orcid: author.orcid?.replace('https://orcid.org/', ''),
        profileUrl: author.id,
        institutionName: institution?.display_name,
        country: institution?.country_code,
        publications: [],
        grants: [],
        topics,
        evidenceText: [
          `${author.display_name} has ${author.works_count ?? 0} indexed works.`,
          topics.length > 0 ? `Research topics: ${topics.join(', ')}.` : '',
        ]
          .filter(Boolean)
          .join(' ')
          .slice(0, 1500),
      };
    });
}
