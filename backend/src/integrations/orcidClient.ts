/**
 * ORCID public API — the researcher's own account of where they work.
 *
 * Keyless, free, JSON. An employment record with no end date, entered by the
 * researcher, is the most direct evidence of a current affiliation that exists
 * outside the institute itself; its limit is coverage (not every researcher
 * keeps ORCID current). Responses are cached for a day, like OpenAlex, so a
 * discovery run can consult it for every new lead without hammering ORCID.
 */
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { OpenAlexCacheModel } from '../models/openAlexCache.model.js';
import { RateLimiter } from './rateLimiter.js';

const BASE_URL = 'https://pub.orcid.org/v3.0';
const USER_AGENT = 'ClassOneSalesBot/1.0 (academic lead research)';

/** ORCID's public limit is 24 req/s; this stays under it with room for the affiliation checks. */
const orcidLimiter = new RateLimiter(20);

export interface OrcidEmployment {
  organization: string;
  department?: string;
  role?: string;
  startYear?: number;
  endYear?: number;
  /** No end date on the record. */
  current: boolean;
  /** Organisation identifier ORCID holds, e.g. "https://ror.org/02qyf5152", when present. */
  orgId?: string;
}

export interface OrcidRecord {
  orcid: string;
  employments: OrcidEmployment[];
}

const ORCID_RE = /\d{4}-\d{4}-\d{4}-\d{3}[\dX]/;

async function cachedGet<T>(url: string): Promise<T | null> {
  const key = createHash('sha256').update(`orcid:${url}`).digest('hex');
  const connected = mongoose.connection.readyState === 1;

  if (connected) {
    try {
      const hit = await OpenAlexCacheModel.findOne({ key }).lean().exec();
      if (hit) return hit.body as T;
    } catch {
      // Cache is best effort.
    }
  }

  await orcidLimiter.acquire();
  let body: T;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    body = (await response.json()) as T;
  } catch {
    return null;
  }

  if (connected) {
    try {
      await OpenAlexCacheModel.updateOne(
        { key },
        { $set: { url, body, creditsSaved: 0, createdAt: new Date() } },
        { upsert: true },
      ).exec();
    } catch {
      // Best effort.
    }
  }
  return body;
}

/** Employment history from the public record, or null when ORCID has nothing usable. */
export async function getOrcidEmployments(orcid: string): Promise<OrcidRecord | null> {
  const m = ORCID_RE.exec(orcid ?? '');
  if (!m) return null;
  const id = m[0];

  interface Summary {
    'organization'?: { name?: string; 'disambiguated-organization'?: { 'disambiguated-organization-identifier'?: string } };
    'department-name'?: string | null;
    'role-title'?: string | null;
    'start-date'?: { year?: { value?: string } } | null;
    'end-date'?: { year?: { value?: string } } | null;
  }
  interface Response {
    'affiliation-group'?: Array<{ summaries?: Array<{ 'employment-summary'?: Summary }> }>;
  }

  const data = await cachedGet<Response>(`${BASE_URL}/${id}/employments`);
  if (!data) return null;

  const employments: OrcidEmployment[] = [];
  for (const group of data['affiliation-group'] ?? []) {
    for (const s of group.summaries ?? []) {
      const e = s['employment-summary'];
      const org = e?.organization?.name;
      if (!org) continue;
      const startYear = Number(e['start-date']?.year?.value) || undefined;
      const endYear = Number(e['end-date']?.year?.value) || undefined;
      employments.push({
        organization: org,
        department: e['department-name'] ?? undefined,
        role: e['role-title'] ?? undefined,
        startYear,
        endYear,
        current: !e['end-date'],
        orgId: e.organization?.['disambiguated-organization']?.['disambiguated-organization-identifier'],
      });
    }
  }

  // Most recent first: current ones, then by start year descending.
  employments.sort((a, b) => Number(b.current) - Number(a.current) || (b.startYear ?? 0) - (a.startYear ?? 0));
  return { orcid: id, employments };
}

// ---------------------------------------------------------------------------
// Roster building: everyone who lists an institute, and their public details
// ---------------------------------------------------------------------------

export interface OrcidSearchHit {
  orcid: string;
  name: string;
  /** Every affiliation name on the record, employment and education alike. */
  institutionNames: string[];
  /** Public email addresses, when the researcher has made any visible. */
  emails: string[];
}

/** ORCID's expanded search pages at most 200 rows, and refuses to page past 11,000. */
const SEARCH_ROWS = 200;
const SEARCH_CEILING = 11_000;

/** Lucene phrase, with embedded quotes stripped rather than escaped. */
function phrase(value: string): string {
  return `"${value.replace(/"/g, '')}"`;
}

/**
 * Everyone whose ORCID record names the institute — by ROR id when ORCID
 * holds one on the affiliation (the exact match) and by the institute's names
 * otherwise. This is the superset: alumni, students and visitors are in it
 * too, which is why every hit then goes through `getOrcidEmployments`.
 *
 * `onPage` lets a long search report progress; the whole listing for a large
 * IIT can run to several thousand records.
 */
export async function searchOrcidByInstitution(params: {
  ror?: string;
  names: string[];
  onPage?: (fetched: number, total: number) => void;
  /** Stop after this many hits (tests, dry runs). */
  limit?: number;
}): Promise<{ hits: OrcidSearchHit[]; total: number; truncated: boolean }> {
  const clauses: string[] = [];
  if (params.ror) clauses.push(`ror-org-id:${phrase(params.ror)}`);
  for (const name of params.names) if (name.trim()) clauses.push(`affiliation-org-name:${phrase(name.trim())}`);
  if (clauses.length === 0) return { hits: [], total: 0, truncated: false };
  const q = clauses.join(' OR ');

  interface Result {
    'orcid-id'?: string;
    'given-names'?: string | null;
    'family-names'?: string | null;
    'credit-name'?: string | null;
    email?: string[];
    'institution-name'?: string[];
  }
  interface Response {
    'num-found'?: number;
    'expanded-result'?: Result[] | null;
  }

  const hits: OrcidSearchHit[] = [];
  const seen = new Set<string>();
  let total = 0;
  let truncated = false;

  for (let start = 0; ; start += SEARCH_ROWS) {
    if (start >= SEARCH_CEILING) {
      truncated = true;
      break;
    }
    const url = new URL(`${BASE_URL}/expanded-search/`);
    url.searchParams.set('q', q);
    url.searchParams.set('start', String(start));
    url.searchParams.set('rows', String(SEARCH_ROWS));
    const page = await cachedGet<Response>(url.toString());
    if (!page) break;
    total = page['num-found'] ?? total;
    const rows = page['expanded-result'] ?? [];
    for (const r of rows) {
      const id = r['orcid-id'];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name =
        r['credit-name']?.trim() ||
        [r['given-names'], r['family-names']].filter(Boolean).join(' ').trim();
      if (!name) continue;
      hits.push({
        orcid: id,
        name,
        institutionNames: r['institution-name'] ?? [],
        emails: (r.email ?? []).map((e) => e.toLowerCase()),
      });
      if (params.limit && hits.length >= params.limit) break;
    }
    params.onPage?.(Math.min(start + rows.length, total), total);
    if (params.limit && hits.length >= params.limit) break;
    if (rows.length < SEARCH_ROWS || start + rows.length >= total) break;
  }

  return { hits, total, truncated };
}

export interface OrcidPerson {
  orcid: string;
  name?: string;
  emails: string[];
  keywords: string[];
  /** Researcher URLs: lab pages, personal sites, institute profiles. */
  urls: Array<{ name?: string; url: string }>;
}

/** The public person section: name, visible emails, keywords and websites. One free call. */
export async function getOrcidPerson(orcid: string): Promise<OrcidPerson | null> {
  const m = ORCID_RE.exec(orcid ?? '');
  if (!m) return null;
  const id = m[0];

  interface Response {
    name?: { 'given-names'?: { value?: string } | null; 'family-name'?: { value?: string } | null; 'credit-name'?: { value?: string } | null } | null;
    emails?: { email?: Array<{ email?: string; verified?: boolean }> } | null;
    keywords?: { keyword?: Array<{ content?: string }> } | null;
    'researcher-urls'?: { 'researcher-url'?: Array<{ 'url-name'?: string | null; url?: { value?: string } }> } | null;
  }
  const data = await cachedGet<Response>(`${BASE_URL}/${id}/person`);
  if (!data) return null;

  const name =
    data.name?.['credit-name']?.value?.trim() ||
    [data.name?.['given-names']?.value, data.name?.['family-name']?.value].filter(Boolean).join(' ').trim() ||
    undefined;

  return {
    orcid: id,
    name,
    emails: (data.emails?.email ?? []).map((e) => e.email?.toLowerCase()).filter((e): e is string => Boolean(e)),
    keywords: (data.keywords?.keyword ?? []).map((k) => k.content?.trim()).filter((k): k is string => Boolean(k)),
    urls: (data['researcher-urls']?.['researcher-url'] ?? [])
      .map((u) => ({ name: u['url-name'] ?? undefined, url: u.url?.value ?? '' }))
      .filter((u) => /^https?:\/\//i.test(u.url)),
  };
}

/** Titles and years of the record's works — research evidence for someone OpenAlex has not indexed. Free. */
export async function getOrcidWorkTitles(orcid: string, limit = 25): Promise<Array<{ title: string; year?: number; url?: string }>> {
  const m = ORCID_RE.exec(orcid ?? '');
  if (!m) return [];
  interface Summary {
    title?: { title?: { value?: string } } | null;
    'publication-date'?: { year?: { value?: string } | null } | null;
    'external-ids'?: { 'external-id'?: Array<{ 'external-id-type'?: string; 'external-id-value'?: string }> } | null;
  }
  interface Response {
    group?: Array<{ 'work-summary'?: Summary[] }>;
  }
  const data = await cachedGet<Response>(`${BASE_URL}/${m[0]}/works`);
  if (!data) return [];
  const out: Array<{ title: string; year?: number; url?: string }> = [];
  for (const g of data.group ?? []) {
    const w = g['work-summary']?.[0];
    const title = w?.title?.title?.value?.trim();
    if (!title) continue;
    const doi = w?.['external-ids']?.['external-id']?.find((e) => e['external-id-type'] === 'doi')?.['external-id-value'];
    out.push({
      title,
      year: Number(w?.['publication-date']?.year?.value) || undefined,
      url: doi ? `https://doi.org/${doi}` : undefined,
    });
  }
  out.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  return out.slice(0, limit);
}
