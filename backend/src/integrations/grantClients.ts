/**
 * Grant discovery — NIH RePORTER and NSF Award Search.
 *
 * The original proposal called for scraping grant portals. Both of these
 * agencies publish real public JSON APIs instead (no key, no rate-limit
 * paperwork), so this replaces the legally-greyest and most fragile part of the
 * plan with ordinary API calls.
 *
 * Funding data is a strong buying signal: a researcher who just won an award for
 * electrochemistry work has budget, and often a deadline to spend it.
 */
import type { DiscoveredCandidate } from '../services/discovery/types.js';
import { fetchJson } from './httpClient.js';

// ---------------------------------------------------------------------------
// NIH RePORTER
// ---------------------------------------------------------------------------

const NIH_URL = 'https://api.reporter.nih.gov/v2/projects/search';

interface NihProject {
  project_num?: string;
  project_title?: string;
  fiscal_year?: number;
  award_amount?: number;
  abstract_text?: string;
  organization?: {
    org_name?: string;
    org_city?: string;
    org_country?: string;
  };
  principal_investigators?: Array<{
    profile_id?: number;
    full_name?: string;
    title?: string;
    is_contact_pi?: boolean;
  }>;
}

interface NihResponse {
  meta?: { total?: number };
  results?: NihProject[];
}

export async function discoverViaNih(params: {
  query: string;
  sinceYear: number;
  maxResults: number;
}): Promise<DiscoveredCandidate[]> {
  const fiscalYears = [params.sinceYear, params.sinceYear + 1, params.sinceYear + 2].filter(
    (year) => year <= new Date().getFullYear(),
  );

  const data = await fetchJson<NihResponse>(NIH_URL, {
    method: 'POST',
    body: {
      criteria: {
        advanced_text_search: {
          operator: 'and',
          search_field: 'projecttitle,abstracttext',
          search_text: params.query,
        },
        ...(fiscalYears.length > 0 ? { fiscal_years: fiscalYears } : {}),
      },
      limit: Math.min(params.maxResults, 50),
      include_fields: [
        'ProjectTitle',
        'PrincipalInvestigators',
        'Organization',
        'AwardAmount',
        'FiscalYear',
        'ProjectNum',
        'AbstractText',
      ],
    },
  });

  const candidates: DiscoveredCandidate[] = [];

  for (const project of data.results ?? []) {
    // The contact PI is the decision-maker; other PIs on the same award are
    // usually collaborators at other institutions.
    const investigators = project.principal_investigators ?? [];
    const pi = investigators.find((p) => p.is_contact_pi) ?? investigators[0];
    if (!pi?.full_name || !pi.profile_id) continue;

    candidates.push({
      sourceType: 'grant_portal',
      sourceRecordId: `nih:${pi.profile_id}`,
      sourceUrl: project.project_num
        ? `https://reporter.nih.gov/search/?projectNums=${project.project_num}`
        : undefined,
      // NIH returns names in caps; normalise so the CRM does not shout.
      name: toTitleCase(pi.full_name),
      title: pi.title ? toTitleCase(pi.title) : undefined,
      institutionName: project.organization?.org_name
        ? toTitleCase(project.organization.org_name)
        : undefined,
      country: project.organization?.org_country,
      publications: [],
      grants: project.project_title
        ? [
            {
              title: project.project_title,
              agency: 'NIH',
              amount: project.award_amount,
              year: project.fiscal_year,
              sourceId: project.project_num,
            },
          ]
        : [],
      topics: [],
      evidenceText: [project.project_title, project.abstract_text]
        .filter(Boolean)
        .join('. ')
        .slice(0, 1500),
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// NSF Award Search
// ---------------------------------------------------------------------------

const NSF_URL = 'https://www.research.gov/awardapi-service/v1/awards.json';

interface NsfAward {
  id?: string;
  title?: string;
  abstractText?: string;
  piFirstName?: string;
  piLastName?: string;
  piEmail?: string;
  awardeeName?: string;
  awardeeStateCode?: string;
  estimatedTotalAmt?: string | number;
  date?: string;
  startDate?: string;
}

interface NsfResponse {
  response?: { award?: NsfAward[] };
}

export async function discoverViaNsf(params: {
  query: string;
  maxResults: number;
}): Promise<DiscoveredCandidate[]> {
  const url = new URL(NSF_URL);
  url.searchParams.set('keyword', params.query);
  url.searchParams.set('rpp', String(Math.min(params.maxResults, 25)));
  url.searchParams.set(
    'printFields',
    [
      'id',
      'title',
      'abstractText',
      'piFirstName',
      'piLastName',
      'piEmail',
      'awardeeName',
      'awardeeStateCode',
      'estimatedTotalAmt',
      'startDate',
    ].join(','),
  );

  const data = await fetchJson<NsfResponse>(url.toString());
  const candidates: DiscoveredCandidate[] = [];

  for (const award of data.response?.award ?? []) {
    const name = [award.piFirstName, award.piLastName].filter(Boolean).join(' ').trim();
    if (!name || !award.id) continue;

    const amount =
      typeof award.estimatedTotalAmt === 'string'
        ? Number.parseInt(award.estimatedTotalAmt, 10)
        : award.estimatedTotalAmt;

    candidates.push({
      sourceType: 'grant_portal',
      sourceRecordId: `nsf:${name.toLowerCase().replace(/\s+/g, '-')}`,
      sourceUrl: `https://www.nsf.gov/awardsearch/showAward?AWD_ID=${award.id}`,
      name,
      // NSF publishes PI email directly — unusually valuable, since most
      // discovery sources yield no contact address at all.
      email: award.piEmail,
      institutionName: award.awardeeName,
      country: 'US',
      publications: [],
      grants: award.title
        ? [
            {
              title: award.title,
              agency: 'NSF',
              amount: Number.isFinite(amount) ? (amount as number) : undefined,
              year: award.startDate ? parseYear(award.startDate) : undefined,
              sourceId: award.id,
            },
          ]
        : [],
      topics: [],
      evidenceText: [award.title, award.abstractText].filter(Boolean).join('. ').slice(0, 1500),
    });
  }

  return candidates;
}

/** NSF dates arrive as MM/DD/YYYY. */
function parseYear(date: string): number | undefined {
  const match = /(\d{4})/.exec(date);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

/** "BRIDGET MARIE BARKER" -> "Bridget Marie Barker". */
function toTitleCase(input: string): string {
  return input
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ')
    .trim();
}
