/**
 * Thin REST client.
 *
 * One place that knows the base URL and how the API reports errors, so every
 * feature gets consistent error messages instead of each fetch call inventing
 * its own handling.
 */
import type {
  DashboardData,
  InstrumentVendor,
  Lead,
  LeadDetail,
  LeadInstrument,
  Paginated,
  Product,
} from '../types';

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    // A network-level failure here almost always means the backend is not running,
    // so say that rather than surfacing a bare "Failed to fetch".
    throw new ApiError(0, `Cannot reach the API at ${BASE_URL}. Is the backend running?`);
  }

  if (response.status === 204) return undefined as T;

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      response.status,
      body?.error ?? `Request failed with status ${response.status}`,
      body?.details,
    );
  }

  return body as T;
}

export interface LeadListParams {
  status?: string;
  source?: string;
  search?: string;
  minScore?: number;
  /** Instrument brand keys; matches leads using ANY of them. */
  brands?: string[];
  limit?: number;
  skip?: number;
  sortBy?: 'createdAt' | 'score' | 'name';
  sortDir?: 'asc' | 'desc';
}

/** Turns list params into a query string; arrays become comma lists, blanks are dropped. */
function leadQueryString(params: LeadListParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) query.set(key, value.join(','));
      continue;
    }
    query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `?${suffix}` : '';
}

export interface BulkReviewPayload {
  decision: 'approved' | 'rejected';
  reviewedBy?: string;
  rejectionReason?: string;
  minScore?: number;
  brands?: string[];
  ids?: string[];
}

export interface BulkReviewResult {
  decision: 'approved' | 'rejected';
  updated: number;
  skipped: number;
}

export interface BrandOption {
  key: string;
  brand: string;
  vendor: InstrumentVendor;
}

export interface CreateLeadPayload {
  name: string;
  email?: string;
  title?: string;
  institutionName?: string;
  department?: string;
  country?: string;
  profileUrl?: string;
  researchSummary?: string;
  tags?: string[];
}

export const api = {
  health: () => request<{ status: string; dependencies: Record<string, string> }>('/health'),

  dashboard: () => request<DashboardData>('/dashboard'),

  listLeads: (params: LeadListParams = {}) =>
    request<Paginated<Lead>>(`/leads${leadQueryString(params)}`),

  /**
   * Every lead matching the same filters as the list, as a CSV blob. Returned
   * rather than navigated to, so a failure surfaces as an error message instead
   * of a blank tab.
   */
  exportLeadsCsv: async (params: LeadListParams = {}): Promise<{ blob: Blob; filename: string }> => {
    const { limit: _l, skip: _s, ...filters } = params;
    const response = await fetch(`${BASE_URL}/leads/export.csv${leadQueryString(filters)}`);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new ApiError(response.status, body?.error ?? `Export failed with status ${response.status}`);
    }
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'leads.csv';
    return { blob: await response.blob(), filename };
  },

  leadBrandOptions: () => request<{ items: BrandOption[] }>('/leads/brand-options'),

  bulkReview: (payload: BulkReviewPayload) =>
    request<BulkReviewResult>('/leads/review-bulk', {
      method: 'POST',
      body: JSON.stringify({ reviewedBy: 'sales-team', ...payload }),
    }),

  getLead: (id: string) => request<LeadDetail>(`/leads/${id}`),

  createLead: (payload: CreateLeadPayload) =>
    request<{ lead: Lead; wasDuplicate: boolean }>('/leads', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateLead: (id: string, payload: Partial<CreateLeadPayload>) =>
    request<Lead>(`/leads/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),

  reviewLead: (id: string, decision: 'approved' | 'rejected', rejectionReason?: string) =>
    request<Lead>(`/leads/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision, reviewedBy: 'sales-team', rejectionReason }),
    }),

  deleteLead: (id: string) => request<void>(`/leads/${id}`, { method: 'DELETE' }),

  listProducts: () => request<{ items: Product[]; total: number }>('/catalog'),

  discoveryConfig: () => request<DiscoveryConfig>('/discovery/config'),

  runDiscovery: (payload: RunDiscoveryPayload) =>
    request<DiscoveryRunSummary>('/discovery/run', {
      method: 'POST',
      body: JSON.stringify(payload),
      // A run hits several live APIs sequentially; the default fetch timeout
      // would abort a legitimate long run.
      signal: AbortSignal.timeout(300_000),
    }),

  discoverByName: (name: string, institutionId?: string) =>
    request<DiscoverByNameResult>('/discovery/by-name', {
      method: 'POST',
      body: JSON.stringify({ name, ...(institutionId ? { institutionId } : {}) }),
      signal: AbortSignal.timeout(60_000),
    }),

  discoverByNames: (names: string[], institutionId?: string) =>
    request<BatchNameResult>('/discovery/by-names', {
      method: 'POST',
      body: JSON.stringify({ names, ...(institutionId ? { institutionId } : {}) }),
      // Up to 50 sequential OpenAlex lookups plus scoring.
      signal: AbortSignal.timeout(300_000),
    }),

  listInstitutions: (kind?: InstitutionKind) =>
    request<{
      items: Institution[];
      total: number;
      counts: Record<InstitutionKind, number>;
    }>(`/discovery/institutions${kind ? `?kind=${kind}` : ''}`),

  getSettings: () => request<SettingsResponse>('/settings'),

  updateSettings: (patch: SettingsPatch) =>
    request<AppSettings>('/settings', { method: 'PATCH', body: JSON.stringify(patch) }),

  addTarget: (payload: NewTargetPayload) =>
    request<AppSettings>('/settings/targets', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteTarget: (targetId: string) =>
    request<AppSettings>(`/settings/targets/${targetId}`, { method: 'DELETE' }),

  resetSettings: () => request<AppSettings>('/settings/reset', { method: 'POST' }),

  crmStats: () => request<CrmStats>('/admin/crm-stats'),

  /** Deletes every lead, thread and activity entry. The phrase is the safety catch. */
  /** "Still at this institute?" — one lead, via a free OpenAlex author lookup. */
  verifyAffiliation: (id: string, deep = false) =>
    request<{ lead: Lead; assessment: { status: string } | null }>(`/leads/${id}/verify-affiliation`, {
      method: 'POST',
      body: JSON.stringify({ deep }),
      signal: AbortSignal.timeout(deep ? 300_000 : 60_000),
    }),

  verifyAffiliations: (params: { ids?: string[]; status?: string; brands?: string[]; limit?: number; deep?: boolean }) =>
    request<{ checked: number; current: number; moved: number; unknown: number; skipped: number }>(
      '/leads/verify-affiliations',
      { method: 'POST', body: JSON.stringify(params), signal: AbortSignal.timeout(900_000) },
    ),

  /** Profile page, ORCID, lab site and open-access papers for one lead. */
  enrichLeadFromWeb: (id: string) =>
    request<WebEnrichmentResult>(`/leads/${id}/enrich-web`, {
      method: 'POST',
      signal: AbortSignal.timeout(300_000),
    }),

  enrichLeadsFromWeb: (ids: string[]) =>
    request<{ results: BulkEnrichmentRow[] }>('/leads/enrich-web-bulk', {
      method: 'POST',
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(900_000),
    }),

  scanInstrumentsEstimate: () => request<{ min: number; max: number }>('/leads/scan-instruments/estimate'),

  /** Every instrument this researcher has written up, from their own papers. */
  scanInstruments: (id: string) =>
    request<InstrumentScanResult>(`/leads/${id}/scan-instruments`, {
      method: 'POST',
      // Up to ~60 sequential OpenAlex calls.
      signal: AbortSignal.timeout(300_000),
    }),

  wipeCrm: () =>
    request<CrmStats>('/admin/wipe-crm', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'WIPE' }),
    }),
};

export interface WebEnrichmentResult {
  lead: Lead;
  filled: Array<'email' | 'title' | 'department' | 'phone' | 'websiteUrl'>;
  profileUrl?: string;
  websites: string[];
  instrumentsFound: LeadInstrument[];
  papers: { considered: number; openAccess: number; read: number };
  pagesVisited: number;
  errors: string[];
}

export interface BulkEnrichmentRow {
  leadId: string;
  name?: string;
  error?: string;
  filled?: string[];
  instruments?: string[];
  papersRead?: number;
  pagesVisited?: number;
  errors?: number;
}

export interface InstrumentScanResult {
  lead: Lead;
  found: LeadInstrument[];
  brandsWithoutHits: string[];
  queriesIssued: number;
  stoppedEarly?: string;
}

export interface CrmStats {
  leads: number;
  threads: number;
  activity: number;
}

export interface ScrapeTargetConfig {
  targetId: string;
  universityName: string;
  department?: string;
  url: string;
  enabled: boolean;
  note?: string;
  lastPeopleFound?: number;
  lastFetchTier?: string;
  lastCheckedAt?: string;
}

export interface InstrumentBrandConfig {
  key: string;
  brand: string;
  vendor: InstrumentVendor;
  /** Only for brands whose name alone is not a usable search term. */
  searchAliases?: string[];
  enabled: boolean;
  searchEnabled: boolean;
}

export interface AppSettings {
  discovery: {
    /** Additional keywords only — the main set is derived from the catalog. */
    queries: string[];
    region: DiscoveryRegion;
    institutionKinds: InstitutionKind[];
    disabledInstitutionIds: string[];
    sinceYear?: number;
    enrichFacultyFromOpenAlex: boolean;
    instrumentSearchEnabled: boolean;
    identifyModels: boolean;
    instrumentLookbackYears: number;
    verifyAffiliations: boolean;
    useOrcidForAffiliation: boolean;
    affiliationRegistries: Array<{ key: string; label: string; searchUrl: string; enabled: boolean; note?: string }>;
    instrumentBrands: InstrumentBrandConfig[];
    /** Derived keyword groups switched off; see `DiscoveryConfig.keywordSearch`. */
    disabledKeywordGroups: string[];
  };
  scraping: {
    allowBrowser: boolean;
    allowProxy: boolean;
    followProfiles: boolean;
    maxProfileFetches: number;
    enrichFromLabSites: boolean;
    maxEnrichmentPagesPerLead: number;
    readOpenAccessPapers: boolean;
    maxPapersPerLead: number;
  };
  facultyTargets: ScrapeTargetConfig[];
  newsTargets: ScrapeTargetConfig[];
}

export interface SettingsResponse extends AppSettings {
  institutions: {
    items: Institution[];
    counts: Record<InstitutionKind, number>;
    total: number;
  };
}

export type SettingsPatch = {
  discovery?: Partial<AppSettings['discovery']>;
  scraping?: Partial<AppSettings['scraping']>;
  facultyTargets?: ScrapeTargetConfig[];
  newsTargets?: ScrapeTargetConfig[];
};

export interface NewTargetPayload {
  kind: 'faculty' | 'news';
  universityName: string;
  department?: string;
  url: string;
  enabled: boolean;
  note?: string;
}

export type InstitutionKind = 'IIT' | 'NIT' | 'IIIT';
export type DiscoveryRegion = 'indian_institutes' | 'india' | 'global';

export interface Institution {
  openAlexId: string;
  name: string;
  kind: InstitutionKind;
  worksCount: number;
}

export interface DiscoveryConfig {
  defaultQueries: string[];
  aiProvider: { name: string; billable: boolean };
  budgetUsd: number;
  scrapeTargets: { faculty: number; news: number };
  cronEnabled: boolean;
  discoverySchedule: string;
  defaultRegion: DiscoveryRegion;
  institutions: { counts: Record<InstitutionKind, number>; total: number };
  instrumentSearch: {
    enabledByDefault: boolean;
    searchedBrands: Array<{ key: string; brand: string; vendor: InstrumentVendor }>;
    detectedBrands: number;
    /** The derived full-text search terms and identifiable models, per brand key. */
    brands: Array<{ key: string; terms: string[]; models: string[] }>;
    identifyModels: boolean;
    /** Worst-case model-identification queries per run (10 credits each). */
    modelQueries: number;
  };
  topicSearch: {
    groups: Array<{ key: string; label: string; productLine: string; topics: number }>;
  };
  keywordSearch: {
    phrases: number;
    groups: Array<{
      key: string;
      label: string;
      description: string;
      searchedAs: 'title_abstract' | 'fulltext';
      count: number;
      phrases: string[];
      enabled: boolean;
    }>;
    extra: string[];
  };
  estimatedCreditsPerRun: number;
  openAlexCache: { hits: number; creditsSaved: number };
  openAlexApiKeyConfigured: boolean;
  openAlexBudget: {
    creditsRemaining: number | null;
    usdRemaining: number | null;
    creditsLimit: number | null;
    exhausted: boolean;
    resetInSeconds: number | null;
  };
}

export interface RunDiscoveryPayload {
  queries?: string[];
  sinceYear?: number;
  sources?: Array<'openalex' | 'nih' | 'nsf' | 'faculty' | 'news'>;
  skipEnrichment?: boolean;
  region?: DiscoveryRegion;
  institutionKinds?: InstitutionKind[];
  institutionIds?: string[];
  includeInstrumentSearch?: boolean;
  includeTopicSearch?: boolean;
  includeKeywordSearch?: boolean;
}

export interface DiscoveryRunSummary {
  runId: string;
  sourcesRun: string[];
  candidatesFound: number;
  leadsCreated: number;
  duplicatesSkipped: number;
  enrichedCount: number;
  instrumentsDetected: number;
  openAlexExhausted: boolean;
  openAlexCreditsEstimated: number;
  errors: string[];
  estimatedCostUsd: number;
  durationMs: number;
}

export interface BatchNameOutcome {
  name: string;
  status: 'created' | 'duplicate' | 'not_found' | 'skipped' | 'error';
  lead?: Lead;
  message?: string;
}

export interface BatchNameResult {
  outcomes: BatchNameOutcome[];
  created: number;
  duplicates: number;
  notFound: number;
  skipped: number;
  errors: number;
}

export interface DiscoverByNameResult {
  lead: Lead | null;
  wasDuplicate: boolean;
  alternatives: Array<{ name: string; institution?: string; profileUrl?: string }>;
}
