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

/** ORCID's public limit is 24 req/s; a quarter of that is plenty and polite. */
const orcidLimiter = new RateLimiter(6);

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
