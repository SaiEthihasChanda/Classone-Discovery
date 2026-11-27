/**
 * Thin REST client.
 *
 * One place that knows the base URL and how the API reports errors, so every
 * feature gets consistent error messages instead of each fetch call inventing
 * its own handling.
 */
import type { CampaignResults, BookingSettings, EventInput, FieldPerson, PublicBooking, ScheduleEvent, ActivityLogEntry, CheckInSettings, MailboxImport,
  AudiencePreview,
  Campaign,
  CampaignAudience,
  CampaignBlock,
  CampaignListItem,
  CampaignRecipient,
  InboundEmail,
  Person,
  PeopleFilter,
  PersonDetail,
  DashboardData,
  DashboardRange,
  EmailThread,
  FacultyMember,
  FlowRun,
  FlowRunConfig,
  FlowStage,
  PipelineSchedule,
  PipelineSettings,
  PipelineState,
  StageView,
  RosterConfig,
  RosterJob,
  RosterJobKind,
  RosterRun,
  RosterRunLogLine,
  RosterSummary,
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

/** Set by the AuthProvider once Firebase is ready; returns the current ID token, or null when signed out. */
let tokenProvider: (() => Promise<string | null>) | null = null;
export function setTokenProvider(fn: (() => Promise<string | null>) | null): void {
  tokenProvider = fn;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = tokenProvider ? await tokenProvider() : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()), ...init?.headers },
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

/**
 * Fetches a file the API serves (an export, a log) with the sign-in header a
 * plain <a href> can't send, then saves it or opens it in a new tab.
 */
export async function openApiFile(url: string, opts: { download?: boolean; fallbackName?: string } = {}): Promise<void> {
  const response = await fetch(url, { headers: await authHeaders() });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, body?.error ?? `Request failed with status ${response.status}`);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  if (opts.download) {
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = /filename="([^"]+)"/.exec(disposition)?.[1] ?? opts.fallbackName ?? 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  } else {
    window.open(objectUrl, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }
}

export type Role = 'admin' | 'sales' | 'viewer' | 'pending';

export interface Me {
  uid: string;
  email: string;
  name?: string;
  photoUrl?: string;
  role: Role;
  authEnabled: boolean;
}

export interface OutreachConfig {
  email: { provider: 'ethereal' | 'gmail'; fromName: string; fromAddress: string; gmailConfigured: boolean };
  followUp: { waitDays: number; maxAttempts: number; schedule: string; cronEnabled: boolean };
  ai: { scoringProvider: string; scoringKeySet: boolean; backfillKeySet: boolean; backfillModel: string; backfillUsage: BackfillUsage };
}

export interface AppUser {
  uid: string;
  email: string;
  name?: string;
  photoUrl?: string;
  role: Role;
  lastSeenAt?: string;
}

export interface LeadListParams {
  status?: string;
  source?: string;
  search?: string;
  minScore?: number;
  /** Instrument brand keys; matches leads using ANY of them. */
  brands?: string[];
  /** Only people with a new grant in the last 60 days. */
  newFunding?: '1';
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

  activityLog: (q: { text?: string; actor?: string; kind?: 'people' | 'system'; from?: string; to?: string; before?: string; limit?: number }) => {
    const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
    return request<{ items: ActivityLogEntry[]; actors?: Array<{ actor: string; actorName?: string }> }>(`/admin/activity?${params}`);
  },
  // Schedules
  scheduleEvents: (q: { from: string; to: string; assignee?: string; leadId?: string }) =>
    request<{ events: ScheduleEvent[] }>(`/schedules/events?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as Array<[string, string]>)}`),
  createEvent: (e: EventInput) => request<ScheduleEvent>('/schedules/events', { method: 'POST', body: JSON.stringify(e) }),
  updateEvent: (id: string, e: EventInput) => request<ScheduleEvent>(`/schedules/events/${id}`, { method: 'PUT', body: JSON.stringify(e) }),
  deleteEvent: (id: string) => request<void>(`/schedules/events/${id}`, { method: 'DELETE' }),
  fieldStep: (id: string, step: 'on-the-way' | 'check-in' | 'check-out', p: { lat?: number; lng?: number; accuracy?: number; note?: string }) =>
    request<ScheduleEvent>(`/schedules/events/${id}/${step}`, { method: 'POST', body: JSON.stringify(p) }),
  fieldBoard: (date?: string) => request<{ people: FieldPerson[] }>(`/schedules/board${date ? `?date=${date}` : ''}`),
  schedulePeople: () => request<{ people: Array<{ email: string; name: string; role: string }> }>('/schedules/people'),
  bookingSettings: () => request<{ settings: BookingSettings; slots: number }>('/schedules/booking'),
  setBookingSettings: (patch: Partial<BookingSettings>) => request<BookingSettings>('/schedules/booking', { method: 'PUT', body: JSON.stringify(patch) }),
  publicBooking: () => request<PublicBooking>('/public/booking'),
  book: (b: { start: string; name: string; email: string; institution?: string; phone?: string; message?: string; website?: string }) =>
    request<{ ok: true; start?: string; end?: string; mode?: string }>('/public/booking', { method: 'POST', body: JSON.stringify(b) }),
  sendWeeklySummary: () => request<{ sent: boolean }>('/dashboard/weekly-summary', { method: 'POST' }),
  dashboard: (range: DashboardRange = '30') => request<DashboardData>(`/dashboard?range=${range}`),

  listLeads: (params: LeadListParams = {}) =>
    request<Paginated<Lead>>(`/leads${leadQueryString(params)}`),

  /**
   * Every lead matching the same filters as the list, as a CSV blob. Returned
   * rather than navigated to, so a failure surfaces as an error message instead
   * of a blank tab.
   */
  exportLeadsCsv: async (params: LeadListParams = {}): Promise<{ blob: Blob; filename: string }> => {
    const { limit: _l, skip: _s, ...filters } = params;
    const response = await fetch(`${BASE_URL}/leads/export.csv${leadQueryString(filters)}`, { headers: await authHeaders() });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new ApiError(response.status, body?.error ?? `Export failed with status ${response.status}`);
    }
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'leads.csv';
    return { blob: await response.blob(), filename };
  },

  leadBrandOptions: () => request<{ items: BrandOption[] }>('/leads/brand-options'),

  me: () => request<Me>('/me'),
  outreachConfig: () => request<OutreachConfig>('/settings/outreach'),
  listUsers: () => request<{ items: AppUser[] }>('/users'),
  setUserRole: (uid: string, role: Role) =>
    request<AppUser>(`/users/${uid}`, { method: 'PATCH', body: JSON.stringify({ role }) }),

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
  updateProduct: (id: string, patch: Partial<Pick<Product, 'applicationAreas' | 'tags' | 'isActive' | 'description'>>) =>
    request<Product>(`/catalog/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

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
  mailboxImport: () => request<{ import: MailboxImport | null }>('/settings/mailbox-import'),
  startMailboxImport: (from: string, to: string) =>
    request<{ import: MailboxImport }>('/settings/mailbox-import', { method: 'POST', body: JSON.stringify({ from, to }) }),

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

  /** This month's Gemini grounding usage/cost, for the backfill button label. */
  backfillAiUsage: () => request<BackfillUsage>('/leads/backfill-ai/usage'),

  /** Web-search backfill for one lead — needs GEMINI_BACKFILL_API_KEY (billed tier). */
  backfillLeadAi: (id: string) =>
    request<GeminiBackfillResult>(`/leads/${id}/backfill-ai`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
    }),

  /** Drafts (or refreshes) a lead's next outreach message. Never sends. */
  draftOutreach: (leadId: string) =>
    request<EmailThread>(`/leads/${leadId}/draft-outreach`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
    }),

  /** Pending drafts (default) or any other status — the Outreach page's list. */
  inbox: () => request<{ items: InboundEmail[] }>('/threads/inbox'),

  // New products from the website → launch campaigns
  launches: () =>
    request<{
      settings: { mode: 'auto' | 'manual'; minRelevance: number; maxRecipients: number };
      items: Array<{ id: string; productId: string; productName?: string; detectedAt: string; status: 'pending' | 'ready' | 'failed' | 'skipped' | 'withdrawn'; campaignId?: string; recipients?: number; attempts?: number; error?: string }>;
      lastSync: { at: string; seen: number; added: number; failed: number } | null;
    }>('/campaigns/launches'),
  setLaunchSettings: (patch: Partial<{ mode: 'auto' | 'manual'; minRelevance: number; maxRecipients: number }>) =>
    request<{ mode: 'auto' | 'manual'; minRelevance: number; maxRecipients: number }>('/campaigns/launches/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  checkWebsiteNow: () =>
    request<{ seen?: number; added?: string[]; updated?: string[]; removed?: string[]; failed?: Array<{ slug: string; error: string }>; firstRun?: boolean; busy?: boolean }>('/campaigns/launches/check', { method: 'POST' }),

  // Campaigns
  campaigns: () => request<{ items: CampaignListItem[]; sentToday: number; dailyCap: number }>('/campaigns'),
  campaign: (id: string) => request<Campaign>(`/campaigns/${id}`),
  createCampaign: (name: string) => request<Campaign>('/campaigns', { method: 'POST', body: JSON.stringify({ name }) }),
  updateCampaign: (id: string, patch: Partial<Pick<Campaign, 'name' | 'subject' | 'preheader' | 'blocks' | 'audience' | 'paceSeconds'>>) =>
    request<Campaign>(`/campaigns/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteCampaign: (id: string) => request<{ ok: true }>(`/campaigns/${id}`, { method: 'DELETE' }),
  duplicateCampaign: (id: string) => request<Campaign>(`/campaigns/${id}/duplicate`, { method: 'POST' }),
  campaignResults: (id: string) => request<CampaignResults>(`/campaigns/${id}/results`),
  nudgeNonBookers: (id: string) => request<{ drafted: number }>(`/campaigns/${id}/nudge-non-bookers`, { method: 'POST' }),
  campaignRecipients: (id: string) => request<{ items: CampaignRecipient[] }>(`/campaigns/${id}/recipients`),
  campaignAudienceOptions: () => request<{ institutes: string[]; applicationAreas: string[]; tags: string[]; products: Array<{ id: string; name: string }> }>('/campaigns/audience/options'),
  campaignAudiencePreview: (audience: CampaignAudience, campaignId?: string) =>
    request<AudiencePreview>('/campaigns/audience/preview', { method: 'POST', body: JSON.stringify({ audience, campaignId }) }),
  campaignPreview: (input: { subject: string; preheader?: string; blocks: CampaignBlock[]; leadId?: string }) =>
    request<{ subject: string; html: string; text: string }>('/campaigns/preview', { method: 'POST', body: JSON.stringify(input) }),
  campaignAiText: (brief: string, products?: string[]) => request<{ text: string; model: string }>('/campaigns/ai-text', { method: 'POST', body: JSON.stringify({ brief, products }) }),
  uploadCampaignAsset: (input: { filename: string; contentType: string; data: string; width?: number; height?: number }) =>
    request<{ id: string; filename: string; size: number }>('/campaigns/assets', { method: 'POST', body: JSON.stringify(input) }),
  sendCampaignTest: (id: string, to?: string) => request<{ ok: true; to: string }>(`/campaigns/${id}/test`, { method: 'POST', body: JSON.stringify(to ? { to } : {}) }),
  startCampaign: (id: string, sendAt?: string) => request<Campaign>(`/campaigns/${id}/start`, { method: 'POST', body: JSON.stringify(sendAt ? { sendAt } : {}) }),
  pauseCampaign: (id: string) => request<Campaign>(`/campaigns/${id}/pause`, { method: 'POST' }),
  cancelCampaign: (id: string) => request<Campaign>(`/campaigns/${id}/cancel`, { method: 'POST' }),

  // Conversations — the mailbox by person
  people: (filter: PeopleFilter = 'all', q = '') =>
    request<{ items: Person[] }>(`/conversations/people?${new URLSearchParams({ filter, ...(q ? { q } : {}) })}`),
  needsYou: () =>
    request<{
      items: Array<{
        threadId: string;
        kind: 'reply' | 'followup';
        person: { email: string; name: string; title?: string; institution?: string; isLead: boolean; doNotContact: boolean };
        topic: string;
        waitingSince?: string;
        overdue: boolean;
        theirMessage?: { subject: string; body: string; intent?: string; at: string };
        draft?: { subject?: string; body: string; type?: string };
        autoReplyDueAt?: string;
        autoReplySent: boolean;
        conversations: number;
      }>;
    }>('/conversations/queue'),
  conversationSummary: () => request<{ unreadPeople: number; drafts: number; needsReply: number }>('/conversations/summary'),
  person: (email: string) => request<PersonDetail>(`/conversations/people/${encodeURIComponent(email)}`),
  personToLead: (email: string) => request<{ leadId: string }>(`/conversations/people/${encodeURIComponent(email)}/to-lead`, { method: 'POST' }),
  setDoNotContact: (email: string, value: boolean) =>
    request<{ ok: true }>(`/conversations/people/${encodeURIComponent(email)}/do-not-contact`, { method: 'PUT', body: JSON.stringify({ value }) }),
  conversationSettings: () => request<{ followUpMode: 'auto' | 'manual' }>('/conversations/settings'),
  checkInSettings: () => request<CheckInSettings>('/conversations/check-ins'),
  setCheckInSettings: (patch: Partial<CheckInSettings>) => request<CheckInSettings>('/conversations/check-ins', { method: 'PUT', body: JSON.stringify(patch) }),
  setFollowUpMode: (followUpMode: 'auto' | 'manual') => request<{ followUpMode: 'auto' | 'manual' }>('/conversations/settings', { method: 'PUT', body: JSON.stringify({ followUpMode }) }),
  setPersonFollowUpMode: (email: string, value: 'auto' | 'manual' | null) =>
    request<{ ok: true }>(`/conversations/people/${encodeURIComponent(email)}/follow-up-mode`, { method: 'PUT', body: JSON.stringify({ value }) }),
  setAutoReply: (email: string, value: boolean) =>
    request<{ ok: true }>(`/conversations/people/${encodeURIComponent(email)}/auto-reply`, { method: 'PUT', body: JSON.stringify({ value }) }),
  markConversationHandled: (threadId: string) => request<{ ok: true }>(`/conversations/threads/${threadId}/handled`, { method: 'POST' }),
  publicDraft: (token: string) =>
    request<{
      to: { name: string; email?: string };
      subject?: string;
      body?: string;
      theirMessage: { subject: string; body: string; at: string } | null;
      waitingSince?: string;
    }>(`/public/drafts/${encodeURIComponent(token)}`),
  sendPublicDraft: (token: string) => request<{ ok: true; to: string }>(`/public/drafts/${encodeURIComponent(token)}/send`, { method: 'POST' }),
  markConversationRead: (threadId: string) => request<{ ok: true }>(`/conversations/threads/${threadId}/read`, { method: 'POST' }),
  replyOnConversation: (threadId: string, body: string) =>
    request<EmailThread>(`/conversations/threads/${threadId}/reply`, { method: 'POST', body: JSON.stringify({ body }) }),
  aiDraftReply: (threadId: string) => request<{ body: string; model: string }>(`/conversations/threads/${threadId}/ai-draft`, { method: 'POST' }),
  sendWaitingDraft: (threadId: string) => request<EmailThread>(`/conversations/threads/${threadId}/send-draft`, { method: 'POST' }),
  discardWaitingDraft: (threadId: string) => request<EmailThread>(`/conversations/threads/${threadId}/discard-draft`, { method: 'POST' }),
  composeMessage: (input: { to: string; subject: string; body: string }) =>
    request<EmailThread>('/conversations/compose', { method: 'POST', body: JSON.stringify(input) }),
  listThreads: (status?: EmailThread['status']) =>
    request<{ items: Array<EmailThread & { leadName?: string; leadInstitution?: string }> }>(
      `/threads${status ? `?status=${status}` : ''}`,
    ),

  /** Sends a thread's pending draft. The only path that actually sends email. */
  approveSendOutreach: (threadId: string) =>
    request<EmailThread>(`/threads/${threadId}/approve-send`, { method: 'POST', signal: AbortSignal.timeout(30_000) }),

  rejectDraft: (threadId: string) =>
    request<EmailThread>(`/threads/${threadId}/reject-draft`, { method: 'POST' }),

  markReplied: (threadId: string) =>
    request<EmailThread>(`/threads/${threadId}/mark-replied`, { method: 'POST' }),

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

  // --- Faculty roster --------------------------------------------------------
  rosterConfig: () => request<RosterConfig>('/roster/config'),
  rosterSummary: () => request<RosterSummary>('/roster/summary'),
  listRoster: (params: RosterListParams = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== null) q.set(k, String(v));
    return request<Paginated<FacultyMember> & { page: number }>(`/roster?${q.toString()}`);
  },
  rosterExportUrl: (params: RosterListParams = {}, format: 'csv' | 'xlsx' = 'csv', extra: { filename?: string; splitBy?: string; layout?: 'presentable' | 'full' } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== null && k !== 'page' && k !== 'limit') q.set(k, String(v));
    if (extra.filename) q.set('filename', extra.filename);
    if (extra.splitBy) q.set('splitBy', extra.splitBy);
    if (extra.layout) q.set('layout', extra.layout);
    return `${BASE_URL}/roster/export.${format}?${q.toString()}`;
  },
  getRosterMember: (id: string) => request<{ member: FacultyMember }>(`/roster/${id}`),
  setRosterStatus: (id: string, status: 'eligible' | 'excluded', reason?: string) =>
    request<{ member: FacultyMember }>(`/roster/${id}`, { method: 'PATCH', body: JSON.stringify({ status, reason }) }),
  rosterBuild: (payload: { institutionIds: string[]; sources?: string[]; includeInferredRoles?: boolean; minWorks?: number; maxProbesPerInstitution?: number }) =>
    request<{ job: RosterJob }>('/roster/build', { method: 'POST', body: JSON.stringify(payload) }),
  rosterVerify: (payload: { freshDays?: number } = {}) =>
    request<{ job: RosterJob }>('/roster/verify', { method: 'POST', body: JSON.stringify(payload) }),
  rosterScoreEstimate: (rescore = false) =>
    request<{ members: number; withOpenAlex: number; credits: number }>(`/roster/score/estimate?rescore=${rescore}`),
  rosterScore: (payload: { rescore?: boolean; sinceYears?: number } = {}) =>
    request<{ job: RosterJob }>('/roster/score', { method: 'POST', body: JSON.stringify(payload) }),
  rosterSweepEstimate: (institutions: number) =>
    request<{ min: number; max: number; brands: number }>(`/roster/sweep/estimate?institutions=${institutions}`),
  rosterSweep: (payload: { institutionIds: string[]; rescore?: boolean }) =>
    request<{ job: RosterJob }>('/roster/sweep', { method: 'POST', body: JSON.stringify(payload) }),
  rosterPromoteEstimate: (threshold: number) =>
    request<{ candidates: number; byInstrument: number; withOpenAlex: number; scanCreditsPerLead: { min: number; max: number } }>(`/roster/promote/estimate?threshold=${threshold}`),
  rosterPromote: (payload: { threshold?: number; identifyInstruments?: boolean } = {}) =>
    request<{ job: RosterJob }>('/roster/promote', { method: 'POST', body: JSON.stringify(payload) }),
  rosterFill: (payload: { useScraper?: boolean; useGeminiBackfill?: boolean } = {}) =>
    request<{ job: RosterJob }>('/roster/fill', { method: 'POST', body: JSON.stringify(payload) }),
  rosterJobs: (kind?: RosterJobKind) => request<{ jobs: RosterJob[] }>(`/roster/jobs${kind ? `?kind=${kind}` : ''}`),
  rosterJob: (id: string) => request<RosterJob>(`/roster/jobs/${id}`),
  rosterJobLogUrl: (id: string, download = false) => `${BASE_URL}/roster/jobs/${id}/log${download ? '?download=1' : ''}`,
  cancelRosterJob: (id: string) => request<{ ok: boolean }>(`/roster/jobs/${id}/cancel`, { method: 'POST' }),
  rosterImport: (csv: string, source: 'vidwan_import' | 'manual' = 'vidwan_import') =>
    request<{ rows: number; unknownInstitution: number; created: number; updated: number; excludedRole: number; excludedDomain: number; droppedUnconfirmed: number }>(
      '/roster/import',
      { method: 'POST', body: JSON.stringify({ csv, source }) },
    ),
  wipeRoster: () => request<{ deleted: number }>('/roster', { method: 'DELETE', body: JSON.stringify({ confirm: 'WIPE ROSTER' }) }),
  rosterPipelineEstimate: (payload: RosterPipelinePayload) =>
    request<{ scoreCredits: number; scoreMembersKnown: number; scoreOutsideAreas: number; sweepCredits: { min: number; max: number }; promoteScanCredits: { min: number; max: number }; note: string }>(
      '/roster/pipeline/estimate',
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  rosterPipeline: (payload: RosterPipelinePayload) =>
    request<{ job: RosterJob }>('/roster/pipeline', { method: 'POST', body: JSON.stringify(payload) }),

  // --- Run history (durable, in Mongo — every run ever started) --------------
  rosterRuns: (params: { kind?: string; status?: string; page?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    return request<{ items: RosterRun[]; total: number; page: number; limit: number }>(`/roster/runs?${q.toString()}`);
  },
  rosterRun: (id: string) => request<{ run: RosterRun }>(`/roster/runs/${id}`),
  rosterRunLog: (id: string, params: { level?: string; page?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    return request<{ items: RosterRunLogLine[]; total: number; page: number; limit: number }>(`/roster/runs/${id}/log?${q.toString()}`);
  },
  rosterRunLogUrl: (id: string, download = false) => `${BASE_URL}/roster/runs/${id}/log.txt${download ? '?download=1' : ''}`,

  // --- Prospects conveyor ---------------------------------------------------
  pipelineState: () => request<PipelineState>('/pipeline/state'),
  updatePipelineSettings: (patch: Partial<PipelineSettings>) =>
    request<{ settings: PipelineSettings }>('/pipeline/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  pipelineAutoPreview: () =>
    request<{ waiting: Record<'verify' | 'score' | 'promote' | 'fill', number>; belowThreshold: number; threshold: number; estimatedScoringCredits: number }>('/pipeline/auto-preview'),
  pipelineStage: (stage: FlowStage) => request<StageView>(`/pipeline/stages/${stage}`),
  runPipelineStage: (stage: Exclude<FlowStage, 'done'>) => request<{ queued: number }>(`/pipeline/stages/${stage}/run`, { method: 'POST' }),
  memberFlowAction: (id: string, action: 'next' | 'redo' | 'retry') =>
    request<{ ok: boolean }>(`/pipeline/members/${id}/action`, { method: 'POST', body: JSON.stringify({ action }) }),
  flowRuns: () => request<{ items: FlowRun[] }>('/pipeline/runs'),
  startFlowRun: (config: FlowRunConfig) => request<{ job: { id: string } }>('/pipeline/runs', { method: 'POST', body: JSON.stringify(config) }),
  pipelineSchedules: () => request<{ items: PipelineSchedule[] }>('/pipeline/schedules'),
  createPipelineSchedule: (s: Omit<PipelineSchedule, 'id' | 'enabled'> & { enabled?: boolean }) =>
    request<{ id: string }>('/pipeline/schedules', { method: 'POST', body: JSON.stringify(s) }),
  updatePipelineSchedule: (id: string, s: Omit<PipelineSchedule, 'id'>) =>
    request<{ ok: boolean }>(`/pipeline/schedules/${id}`, { method: 'PUT', body: JSON.stringify(s) }),
  deletePipelineSchedule: (id: string) => request<{ ok: boolean }>(`/pipeline/schedules/${id}`, { method: 'DELETE' }),
};

export type RosterPipelineStage = 'build' | 'verify' | 'score' | 'sweep' | 'promote' | 'fill';

export interface RosterPipelinePayload {
  institutionIds: string[];
  stages: RosterPipelineStage[];
  sources?: string[];
  includeInferredRoles?: boolean;
  minWorks?: number;
  threshold?: number;
  identifyInstruments?: boolean;
  includeInstrumentOwners?: boolean;
  sweepBrands?: string[];
  useScraper?: boolean;
  useGeminiBackfill?: boolean;
  /** Keyword / application-area override for this run. */
  focus?: KeywordOverride;
}

export interface KeywordOverride {
  items: string[];
  /** Treat the list as relevance keywords, or as application areas. */
  as: 'keywords' | 'applicationAreas';
  /** Add to the defaults, or use only this list. */
  mode: 'add' | 'only';
}

export interface RosterListParams {
  /** Prospects board column. */
  stage?: 'found' | 'verified' | 'scored' | 'filling' | 'crm' | 'excluded';
  /** Comma-separated conveyor states. */
  flowState?: string;
  status?: string;
  /** Comma-separated for several. */
  domain?: string;
  role?: string;
  institutionId?: string;
  affiliation?: string;
  tag?: string;
  source?: string;
  brand?: string;
  vendor?: 'classone' | 'competitor' | 'none';
  /** Comma-separated agency keys (serb,dst…), or "any" / "none". */
  funder?: string;
  /** Tracked-agency grant sanctioned in or after this year. */
  fundedSince?: number;
  /** Application-area labels separated by "|" (labels contain commas), or "any" / "none". */
  area?: string;
  hasEmail?: 'yes' | 'no';
  hasTitle?: 'yes' | 'no';
  hasPhone?: 'yes' | 'no';
  outsideTarget?: 'yes' | 'no';
  minScore?: number;
  maxScore?: number;
  scored?: 'yes' | 'no';
  missing?: string;
  q?: string;
  sort?: 'score' | 'name' | 'newest' | 'works';
  page?: number;
  limit?: number;
}

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

export interface GeminiBackfillResult {
  lead: Lead;
  filled: Array<'email' | 'title' | 'department' | 'phone' | 'websiteUrl'>;
  sources: string[];
}

export interface BackfillUsage {
  monthKey: string;
  count: number;
  freeAllowance: number;
  overFreeAllowance: boolean;
  estimatedMonthCostUsd: number;
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
    rosterAlwaysKeep: Array<{ name: string; orcid?: string; openAlexAuthorId?: string; institution?: string; note?: string }>;
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
