/**
 * API response shapes.
 *
 * Mirrors `backend/src/types/domain.ts`. Kept as a hand-written copy rather than
 * a shared package: the frontend only needs a read-only subset, and a shared
 * workspace package is more build tooling than Phase 1 warrants. If these drift
 * often, promote them to `packages/shared-types` later.
 */

export type LeadStatus = 'pending_review' | 'approved' | 'rejected' | 'customer';

export type LeadSourceType =
  | 'openalex'
  | 'faculty_page'
  | 'university_news'
  | 'grant_portal'
  | 'manual'
  | 'manual_discovery_trigger';

export type FollowUpStatusSummary = 'not_started' | 'in_progress' | 'closed';

export interface Lead {
  id: string;
  status: LeadStatus;
  source: {
    type: LeadSourceType;
    sourceUrl?: string;
    sourceRecordId?: string;
    discoveredAt: string;
  };
  person: {
    name: string;
    normalizedNameKey: string;
    email?: string;
    title?: string;
    orcid?: string;
    profileUrl?: string;
    phone?: string;
    websiteUrl?: string;
  };
  institution: {
    name?: string;
    openAlexId?: string;
    department?: string;
    country?: string;
    websiteUrl?: string;
    affiliation?: LeadAffiliation;
  };
  research: {
    summary?: string;
    topics: string[];
    recentPublications: { title: string; year?: number; url?: string }[];
    recentGrants: { title: string; agency?: string; amount?: number; year?: number }[];
    /** Optional: leads created before instrument detection existed lack it. */
    instruments?: LeadInstrument[];
    /** Funders / grant numbers acknowledged on recent papers. */
    funding?: FundingAcknowledgement[];
    fundingCheckedAt?: string;
    applicationAreas?: string[];
    webEnrichedAt?: string;
  };
  aiScoring: {
    relevanceScore?: number;
    relevanceReasoning?: string;
    qualificationSignals?: {
      productRelevance?: number;
      institutionalStrength?: number;
      recency?: number;
      engagementPotential?: number;
    };
    recommendedProductIds: string[];
    recommendedProductNotes?: string;
  };
  review: {
    reviewedBy?: string;
    reviewedAt?: string;
    decision?: 'approved' | 'rejected';
    rejectionReason?: string;
  };
  followUpStatusSummary: FollowUpStatusSummary;
  activeThreadId?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** Whether the person is still at the institute on the lead, as last checked. */
export interface AffiliationEvidence {
  source: string;
  institution?: string;
  current?: boolean;
  url?: string;
  detail?: string;
}

export interface LeadAffiliation {
  /** `conflict` = sources disagree (ORCID elsewhere, or a merged identity) — kept, needs a person to check. */
  status: 'current' | 'moved' | 'unknown' | 'unverified' | 'conflict';
  verifiedAt: string;
  source: string;
  evidence?: AffiliationEvidence[];
  lastSeenYear?: number;
  previousInstitution?: string;
  previousInstitutionOpenAlexId?: string;
  directoryListed?: boolean;
  note?: string;
}

export type InstrumentVendor = 'classone' | 'competitor';

export type FundingAgency = 'serb' | 'anrf' | 'dst' | 'dbt' | 'icmr' | 'csir' | 'birac' | 'other';

/** A funder (and grant number, when printed) acknowledged on the researcher's recent papers. */
export interface FundingAcknowledgement {
  agency: FundingAgency;
  funder: string;
  funderId?: string;
  awardId?: string;
  /** Decoded from the grant number, e.g. "Core Research Grant (CRG)". */
  scheme?: string;
  /** Sanction year decoded from the grant number. */
  year?: number;
  papers: number;
  workTitle?: string;
  workYear?: number;
  workUrl?: string;
}

/** An instrument the researcher has been seen using, with its evidence. */
export interface LeadInstrument {
  brandKey: string;
  brand: string;
  vendor: InstrumentVendor;
  model?: string;
  evidence: string;
  sourceUrl?: string;
  matchedVia: 'fulltext_search' | 'text_match';
  /** A bare brand name in a paper that does not read as electrochemistry: not counted as ownership. */
  needsReview?: boolean;
}

export interface EmailThread {
  id: string;
  leadId: string;
  leadEmailSnapshot: string;
  subjectLine: string;
  status: 'draft' | 'open' | 'replied' | 'closed';
  closedReason?: 'replied' | 'max_attempts_reached' | 'manual' | 'bounced';
  provider: 'ethereal' | 'gmail';
  messages: {
    messageId: string;
    direction: 'outbound' | 'inbound';
    type: string;
    subject: string;
    bodyText: string;
    sentAt: string;
  }[];
  followUp: { attemptsSent: number; maxAttempts: number; nextCheckAt?: string; replyDetected: boolean };
  /** A pending, unsent draft — present only while status is 'draft'. */
  draftType?: 'initial_outreach' | 'follow_up_1' | 'follow_up_2';
  draftSubject?: string;
  draftBody?: string;
  draftModel?: string;
  draftCreatedAt?: string;
  createdAt: string;
}

export type LeadDetail = Lead & { threads: EmailThread[] };

export interface Product {
  id: string;
  productId: string;
  name: string;
  category: string;
  tags: string[];
  description?: string;
  applicationAreas: string[];
  sdkSupport: string[];
  isActive: boolean;
  sourceUrl?: string;
}

export interface ActivityLogEntry {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  relatedLeadId?: string;
  createdAt: string;
}

export interface DashboardData {
  tiles: {
    activeCustomers: number;
    inProgressDiscoveries: number;
    openThreads: number;
    criticalAlerts: number;
  };
  recentActivity: ActivityLogEntry[];
  generatedAt: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  skip: number;
}

// ---------------------------------------------------------------------------
// Faculty roster
// ---------------------------------------------------------------------------

export type FacultyDomain =
  | 'chemistry'
  | 'biology'
  | 'biotechnology'
  | 'chemical_engineering'
  | 'biochemical_engineering'
  | 'materials'
  | 'energy'
  | 'electrical'
  | 'civil'
  | 'mechanical'
  | 'other';

export type FacultyRoleCategory = 'professor' | 'scientist' | 'officer' | 'fellow' | 'inferred' | 'unknown' | 'excluded';
export type FacultyStatus = 'eligible' | 'excluded' | 'promoted';

export interface FacultyMember {
  id: string;
  status: FacultyStatus;
  exclusionReason?: string;
  person: {
    name: string;
    email?: string;
    title?: string;
    phone?: string;
    websiteUrl?: string;
    profileUrl?: string;
    orcid?: string;
    openAlexAuthorId?: string;
  };
  role: { category: FacultyRoleCategory; rawTitle?: string; basis?: string };
  department: { name?: string; domain: FacultyDomain; gateTerms?: string[] };
  institution: {
    name?: string;
    openAlexId?: string;
    discoveredName?: string;
    discoveredOpenAlexId?: string;
    department?: string;
    country?: string;
    outsideTarget?: boolean;
    affiliation?: LeadAffiliation;
  };
  sources: Array<{ type: string; recordId: string; url?: string; title?: string; department?: string; seenAt: string }>;
  research: {
    topics: string[];
    worksCount?: number;
    hIndex?: number;
    firstPublicationYear?: number;
    lastPublicationYear?: number;
    recentPublications: Array<{ title: string; year?: number; url?: string }>;
    evidenceText?: string;
    instruments: LeadInstrument[];
    funding?: FundingAcknowledgement[];
    fundingCheckedAt?: string;
    /** Focus application areas, strongest first. */
    applicationAreas?: string[];
  };
  relevance: { score?: number; reasoning?: string; recommendedProductIds?: string[]; scoredAt?: string; scoringModel?: string };
  leadId?: string;
  promotedAt?: string;
  tags: string[];
  /** Where this person is on the Prospects conveyor. */
  flow?: MemberFlow;
  createdAt: string;
  updatedAt: string;
}

export type FlowStage = 'verify' | 'score' | 'promote' | 'fill' | 'done';
export type FlowState = 'idle' | 'queued' | 'processing' | 'review' | 'failed';

export interface MemberFlow {
  stage?: FlowStage;
  state?: FlowState;
  forced?: boolean;
  attempts?: number;
  nextAttemptAt?: string;
  lastError?: string;
  note?: string;
  startedAt?: string;
  updatedAt?: string;
  runId?: string;
}

export interface PipelineSettings {
  mode: 'manual' | 'auto';
  threshold: number;
  dailyOpenAlexCredits: number;
  dailyGeminiSearches: number;
  reverifyAfterDays: number;
}

export interface PipelineState {
  settings: PipelineSettings;
  caps: {
    openAlex: { usedToday: number | null; cap: number; remaining: number | null; paused: boolean };
    gemini: { usedToday: number; cap: number; paused: boolean; keySet: boolean };
  };
  /** Per stage: total and a count per state. */
  stages: Record<FlowStage, Partial<Record<FlowState, number>> & { total: number }>;
  excluded: number;
  /** Stages paused because an outside service (Gemini, OpenAlex) is busy; they resume on their own. */
  paused?: Partial<Record<FlowStage, { until: string; reason: string }>>;
}

/** A row in a View stage list — a trimmed FacultyMember. */
export interface StageMember {
  id: string;
  status: FacultyStatus;
  person: { name: string; title?: string };
  institution?: { name?: string; affiliation?: { status?: string } };
  relevance?: { score?: number };
  flow?: MemberFlow;
  leadId?: string;
}

export interface StageView {
  stage: FlowStage;
  processing: StageMember[];
  queued: StageMember[];
  review: StageMember[];
  failed: StageMember[];
  /** Everyone in the queue (the list holds the first 200, in pickup order). */
  queuedTotal: number;
  idleCount: number;
}

export interface FlowRun {
  _id: string;
  kind: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  stage?: string;
  counters: Record<string, number>;
  options?: { label?: string; institutionIds?: string[]; triggeredBy?: string; late?: boolean; scheduleId?: string };
  startedAt: string;
  finishedAt?: string;
  error?: string;
  people: { total: number; inLeads: number; excluded: number; moving: number; attention: number };
  flowing: boolean;
}

export interface PipelineSchedule {
  id: string;
  name: string;
  config: FlowRunConfig;
  type: 'once' | 'recurring';
  runAt?: string;
  weekdays?: number[];
  time?: string;
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  lastRunId?: string;
  lastRunLate?: boolean;
  lastError?: string;
  createdBy?: string;
}

export interface FlowRunConfig {
  label?: string;
  institutionIds: string[];
  sources?: string[];
  includeInferredRoles?: boolean;
  minWorks?: number;
  threshold?: number;
  useScraper?: boolean;
  useGeminiBackfill?: boolean;
  focus?: { items: string[]; as: 'keywords' | 'applicationAreas'; mode: 'add' | 'only' };
}

export interface RosterSummary {
  total: number;
  byStatus: Record<string, number>;
  byRole: Record<string, number>;
  byDomain: Record<string, number>;
  byInstitution: Array<{ name: string; eligible: number; promoted: number; excluded: number }>;
}

export interface RosterConfig {
  institutions: Array<{ id: string; name: string; kind: string }>;
  domains: Record<FacultyDomain, string>;
  brands: Array<{ key: string; brand: string; vendor: 'classone' | 'competitor' }>;
  splitOptions: Array<{ key: string; label: string }>;
  defaultThreshold: number;
  /** Default focus application areas and their match terms. */
  applicationAreas: Array<{ label: string; terms: string[] }>;
  exportLayouts: Array<{ key: 'presentable' | 'full'; label: string }>;
}

export type RosterJobKind = 'roster_build' | 'roster_verify' | 'roster_score' | 'roster_sweep' | 'roster_promote' | 'roster_fill' | 'roster_pipeline';

export interface RosterJob {
  id: string;
  kind: RosterJobKind;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  counters: Record<string, number>;
  stage: string;
  progress?: number;
  log: Array<{ at: string; message: string; level: 'info' | 'warn' | 'error' }>;
  /** Every line ever logged — the file on disk has this many; `log` above is only the live tail. */
  logLineCount?: number;
  result?: unknown;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

/**
 * The durable counterpart to `RosterJob`: every run ever started, kept in
 * Mongo indefinitely (not pruned, survives a restart). `_id` is the same id
 * `RosterJob.id` uses while the job is live.
 */
export interface RosterRun {
  _id: string;
  kind: RosterJobKind;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  stage?: string;
  progress?: number;
  counters: Record<string, number>;
  /** The request body that started the run — institutes, stages, thresholds, etc. */
  options?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  logLineCount: number;
  startedAt: string;
  finishedAt?: string;
}

export interface RosterRunLogLine {
  runId: string;
  seq: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}
