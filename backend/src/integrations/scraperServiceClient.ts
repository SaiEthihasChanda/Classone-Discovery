/**
 * Client for the Python scraper service.
 *
 * The service returns raw normalised data only — no AI enrichment, no database
 * writes. Everything downstream of "we got some HTML" happens here in Node,
 * which keeps OpenAI spend and prompt versioning in one place.
 */
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { fetchJson } from './httpClient.js';

export interface FacultyTarget {
  university_name: string;
  faculty_page_url: string;
}

export interface NewsTarget {
  university_name: string;
  news_page_url: string;
}

interface ExtractedPerson {
  name: string;
  title?: string | null;
  department?: string | null;
  email?: string | null;
  profile_url?: string | null;
  bio?: string | null;
}

interface ExtractedNewsItem {
  title: string;
  url?: string | null;
  published_at?: string | null;
  summary?: string | null;
  mentioned_names: string[];
}

export interface ScrapeError {
  target: string;
  reason: string;
  detail?: string | null;
}

export interface FacultyScrapeResponse {
  job_id: string;
  status: 'completed' | 'partial' | 'failed';
  results: Array<{
    source_url: string;
    university_name: string;
    extracted: ExtractedPerson[];
    scraped_at: string;
  }>;
  errors: ScrapeError[];
}

export interface NewsScrapeResponse {
  job_id: string;
  status: 'completed' | 'partial' | 'failed';
  results: Array<{
    source_url: string;
    university_name: string;
    extracted: ExtractedNewsItem[];
    scraped_at: string;
  }>;
  errors: ScrapeError[];
}

/**
 * Scraping runs inside a scheduled job, not a user request, so a multi-minute
 * budget is fine. No retry: the service already isolates per-target failures,
 * and re-running a whole batch to recover one bad target would re-fetch every
 * site that already succeeded.
 */
const SCRAPE_TIMEOUT_MS = 240_000;

export async function scrapeFacultyPages(
  targets: FacultyTarget[],
  options: {
    maxPagesPerTarget?: number;
    timeoutSecPerPage?: number;
    /** Fetch profile pages for people whose index entry has no email. */
    followProfiles?: boolean;
    maxProfileFetches?: number;
    allowBrowser?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<FacultyScrapeResponse> {
  return fetchJson<FacultyScrapeResponse>(`${env.SCRAPER_SERVICE_URL}/scrape/faculty`, {
    method: 'POST',
    timeoutMs: options.timeoutMs ?? SCRAPE_TIMEOUT_MS,
    retries: 0,
    body: {
      job_id: randomUUID(),
      targets,
      options: {
        max_pages_per_target: options.maxPagesPerTarget ?? 5,
        respect_robots_txt: true,
        timeout_sec_per_page: options.timeoutSecPerPage ?? 20,
        ...(options.followProfiles === undefined ? {} : { follow_profiles: options.followProfiles }),
        ...(options.maxProfileFetches === undefined ? {} : { max_profile_fetches: options.maxProfileFetches }),
        ...(options.allowBrowser === undefined ? {} : { allow_browser: options.allowBrowser }),
      },
    },
  });
}

export async function scrapeNewsPages(
  targets: NewsTarget[],
  options: { timeoutSecPerPage?: number } = {},
): Promise<NewsScrapeResponse> {
  return fetchJson<NewsScrapeResponse>(`${env.SCRAPER_SERVICE_URL}/scrape/news`, {
    method: 'POST',
    timeoutMs: SCRAPE_TIMEOUT_MS,
    retries: 0,
    body: {
      job_id: randomUUID(),
      targets,
      options: {
        respect_robots_txt: true,
        timeout_sec_per_page: options.timeoutSecPerPage ?? 20,
      },
    },
  });
}

/** True if the scraper service is up. Lets discovery skip scrape sources cleanly. */
export async function isScraperAvailable(): Promise<boolean> {
  try {
    await fetchJson(`${env.SCRAPER_SERVICE_URL}/health`, { timeoutMs: 3000, retries: 0 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-lead enrichment and open-access paper reading
// ---------------------------------------------------------------------------

export interface EnrichLeadPayload {
  name: string;
  institutionName?: string;
  orcid?: string;
  /** An institute profile page already known — never an OpenAlex URL. */
  profileUrl?: string;
  /** Faculty directory pages for the lead's institute, from settings. */
  directoryUrls: string[];
  /** Brand and model names; sentences mentioning any come back as snippets. */
  instrumentTerms: string[];
  options?: {
    maxPages?: number;
    followLabSites?: boolean;
    useOrcid?: boolean;
    allowBrowser?: boolean;
    timeoutSecPerPage?: number;
  };
}

export interface TextSnippet {
  url: string;
  text: string;
}

export interface EnrichLeadResponse {
  job_id: string;
  directory_checked?: boolean;
  directory_listed?: boolean | null;
  profile_url?: string | null;
  email?: string | null;
  phone?: string | null;
  designation?: string | null;
  department?: string | null;
  websites: string[];
  snippets: TextSnippet[];
  pages_visited: string[];
  errors: ScrapeError[];
}

export async function enrichLeadViaScraper(payload: EnrichLeadPayload): Promise<EnrichLeadResponse> {
  const o = payload.options ?? {};
  return fetchJson<EnrichLeadResponse>(`${env.SCRAPER_SERVICE_URL}/scrape/enrich-lead`, {
    method: 'POST',
    timeoutMs: SCRAPE_TIMEOUT_MS,
    retries: 0,
    body: {
      job_id: randomUUID(),
      name: payload.name,
      institution_name: payload.institutionName,
      orcid: payload.orcid,
      profile_url: payload.profileUrl,
      directory_urls: payload.directoryUrls,
      instrument_terms: payload.instrumentTerms,
      options: {
        max_pages: o.maxPages ?? 8,
        follow_lab_sites: o.followLabSites ?? true,
        use_orcid: o.useOrcid ?? true,
        allow_browser: o.allowBrowser ?? true,
        timeout_sec_per_page: o.timeoutSecPerPage ?? 20,
      },
    },
  });
}

export interface RegistrySpec {
  key: string;
  label: string;
  /** Search URL with {name} where the URL-encoded name goes. */
  searchUrl: string;
}

export interface AffiliationHit {
  source: string;
  profile_url: string;
  matched_name: string;
  institution?: string | null;
  department?: string | null;
  designation?: string | null;
  detail?: string | null;
}

export interface AffiliationResponse {
  job_id: string;
  directory_checked: boolean;
  directory_listed?: boolean | null;
  directory_url?: string | null;
  hits: AffiliationHit[];
  errors: ScrapeError[];
}

/** Where is this person now, per the institute directory and the researcher registries? */
export async function checkAffiliationViaScraper(payload: {
  name: string;
  institutionName?: string;
  knownInstitutions: string[];
  directoryUrls: string[];
  registries: RegistrySpec[];
  allowBrowser?: boolean;
}): Promise<AffiliationResponse> {
  return fetchJson<AffiliationResponse>(`${env.SCRAPER_SERVICE_URL}/scrape/affiliation`, {
    method: 'POST',
    timeoutMs: SCRAPE_TIMEOUT_MS,
    retries: 0,
    body: {
      job_id: randomUUID(),
      name: payload.name,
      institution_name: payload.institutionName,
      known_institutions: payload.knownInstitutions,
      directory_urls: payload.directoryUrls,
      registries: payload.registries.map((r) => ({ key: r.key, label: r.label, search_url: r.searchUrl })),
      timeout_sec_per_page: 20,
      allow_browser: payload.allowBrowser ?? true,
    },
  });
}

export interface PaperTextResponse {
  job_id: string;
  results: Array<{ id: string; url: string; kind: 'pdf' | 'html'; chars: number; snippets: string[]; emails?: string[] }>;
  errors: ScrapeError[];
}

export async function extractPaperSnippets(payload: {
  papers: Array<{ id: string; url: string; title?: string }>;
  instrumentTerms: string[];
  timeoutSecPerPage?: number;
}): Promise<PaperTextResponse> {
  return fetchJson<PaperTextResponse>(`${env.SCRAPER_SERVICE_URL}/scrape/paper-text`, {
    method: 'POST',
    timeoutMs: SCRAPE_TIMEOUT_MS,
    retries: 0,
    body: {
      job_id: randomUUID(),
      papers: payload.papers,
      instrument_terms: payload.instrumentTerms,
      timeout_sec_per_page: payload.timeoutSecPerPage ?? 30,
    },
  });
}

// ---------------------------------------------------------------------------
// Faculty-page discovery for the roster build
// ---------------------------------------------------------------------------

export interface FoundFacultyPage {
  url: string;
  department?: string | null;
  people: number;
  emails: number;
  profiles: number;
  sample: string[];
  hop: number;
  /** Link text that led to the page ("Faculty"). */
  label?: string | null;
}

export interface FindFacultyPagesResponse {
  job_id: string;
  results: Array<{ institution: string; pages: FoundFacultyPage[]; error?: string | null; detail?: string | null }>;
}

/** Long: up to `maxProbes` rate-limited fetches per institute, all institutes in parallel. */
const FIND_PAGES_TIMEOUT_MS = 1_800_000;

/**
 * Asks the scraper to locate the department faculty listings of each
 * institute from its homepage. `departmentHints` are the name fragments to
 * follow ("chem", "material", ...).
 */
export async function findFacultyPages(payload: {
  institutions: Array<{ name: string; homepageUrl: string }>;
  departmentHints: string[];
  maxProbes?: number;
  timeoutSecPerPage?: number;
}): Promise<FindFacultyPagesResponse> {
  return fetchJson<FindFacultyPagesResponse>(`${env.SCRAPER_SERVICE_URL}/scrape/find-faculty-pages`, {
    method: 'POST',
    timeoutMs: FIND_PAGES_TIMEOUT_MS,
    retries: 0,
    body: {
      job_id: randomUUID(),
      institutions: payload.institutions.map((i) => ({ name: i.name, homepage_url: i.homepageUrl })),
      department_hints: payload.departmentHints,
      max_probes_per_institution: payload.maxProbes ?? 30,
      timeout_sec_per_page: payload.timeoutSecPerPage ?? 20,
    },
  });
}

// ---------------------------------------------------------------------------
// Vidwan search for the roster build
// ---------------------------------------------------------------------------

export interface VidwanRow {
  vidwan_id: string;
  profile_url: string;
  name: string;
  designation?: string | null;
  /** Vidwan's broad subject on the card ("Chemical Sciences"). */
  subject?: string | null;
  institute?: string | null;
  department?: string | null;
  /** "(2009)" or "1986 - 2022" as printed beside the institute — an end year means a former position. */
  years?: string | null;
  state?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  expertise?: string | null;
  orcid?: string | null;
  scopus_id?: string | null;
  scholar_id?: string | null;
  profile_text?: string | null;
  card_text?: string | null;
  /** Only the listing card was read (student title, or profile fetch skipped). */
  card_only?: boolean;
  error?: string | null;
}

export interface VidwanSearchResponse {
  job_id: string;
  rows: VidwanRow[];
  listing_profiles: number;
  site_total?: number | null;
  pages_fetched: number;
  profiles_fetched?: number;
  requests: number;
  blocked: boolean;
  errors: ScrapeError[];
}

/** Sequential, delayed fetches: a few hundred profiles take 10–15 minutes. */
const VIDWAN_TIMEOUT_MS = 40 * 60_000;

/**
 * Searches Vidwan (India's national researcher database) for the given
 * queries — an institute's names — and reads each matching profile.
 */
export async function searchVidwan(payload: {
  queries: string[];
  institutionTerms?: string[];
  maxPagesPerQuery?: number;
  maxProfiles?: number;
  fetchProfiles?: boolean;
}): Promise<VidwanSearchResponse> {
  return fetchJson<VidwanSearchResponse>(`${env.SCRAPER_SERVICE_URL}/scrape/vidwan`, {
    method: 'POST',
    timeoutMs: VIDWAN_TIMEOUT_MS,
    retries: 0,
    body: {
      job_id: randomUUID(),
      queries: payload.queries,
      institution_terms: payload.institutionTerms ?? [],
      max_pages_per_query: payload.maxPagesPerQuery ?? 50,
      max_profiles: payload.maxProfiles ?? 600,
      fetch_profiles: payload.fetchProfiles ?? true,
    },
  });
}
