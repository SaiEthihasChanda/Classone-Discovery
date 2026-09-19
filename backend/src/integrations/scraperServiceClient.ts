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
  options: { maxPagesPerTarget?: number; timeoutSecPerPage?: number } = {},
): Promise<FacultyScrapeResponse> {
  return fetchJson<FacultyScrapeResponse>(`${env.SCRAPER_SERVICE_URL}/scrape/faculty`, {
    method: 'POST',
    timeoutMs: SCRAPE_TIMEOUT_MS,
    retries: 0,
    body: {
      job_id: randomUUID(),
      targets,
      options: {
        max_pages_per_target: options.maxPagesPerTarget ?? 5,
        respect_robots_txt: true,
        timeout_sec_per_page: options.timeoutSecPerPage ?? 20,
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

export interface PaperTextResponse {
  job_id: string;
  results: Array<{ id: string; url: string; kind: 'pdf' | 'html'; chars: number; snippets: string[] }>;
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
