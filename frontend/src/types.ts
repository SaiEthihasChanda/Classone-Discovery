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
  | 'manual_discovery_trigger'
  | 'faculty_roster'
  | 'inbound_email'
  | 'website_enquiry';

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
  /** When a new grant of theirs was spotted (funding alerts). */
  fundingAlertAt?: string;
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

// --- Campaigns ------------------------------------------------------------------------------------

export type CampaignBlock =
  | { id: string; type: 'heading'; text: string; size?: 'lg' | 'md'; align?: 'left' | 'center' | 'right' }
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'image'; assetId: string; alt?: string; link?: string; align?: 'left' | 'center' | 'right'; width?: 'full' | 'large' | 'medium' | 'small' }
  | { id: string; type: 'button'; label: string; url: string; align?: 'left' | 'center' | 'right' | 'full'; style?: 'solid' | 'outline' }
  | { id: string; type: 'product'; productId: string; blurb?: string; url?: string }
  | { id: string; type: 'divider' }
  | { id: string; type: 'spacer'; size?: 'sm' | 'md' | 'lg' };

export interface CampaignAudience {
  statuses?: Array<'pending_review' | 'approved' | 'customer'>;
  institutes?: string[];
  applicationAreas?: string[];
  productIds?: string[];
  brands?: string[];
  tags?: string[];
  minScore?: number;
  search?: string;
  /** Pre-picked people (new-product launches: the AI's relevance pick). The filters narrow within it. */
  leadIds?: string[];
}

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'paused' | 'done' | 'cancelled';

export interface Campaign {
  id: string;
  name: string;
  subject: string;
  preheader?: string;
  blocks: CampaignBlock[];
  audience: CampaignAudience;
  status: CampaignStatus;
  sendAt?: string;
  paceSeconds: number;
  startedAt?: string;
  finishedAt?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignListItem extends Omit<Campaign, 'blocks'> {
  kind?: 'manual' | 'product_launch';
  reviewUntil?: string;
  blockCount: number;
  /** opened / clicked: people who opened or clicked at least once (an estimate — see tracking.ts). */
  stats: { total: number; queued: number; sent: number; failed: number; skipped: number; replied: number; opened: number; clicked: number };
}

export interface CampaignRecipient {
  id: string;
  leadId?: string;
  email: string;
  name?: string;
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  sentAt?: string;
  threadId?: string;
  error?: string;
}

export interface AudiencePreview {
  count: number;
  alreadySent: number;
  sample: Array<{ id: string; name?: string; email?: string; institute?: string; score?: number; status?: string }>;
}

/** Someone the sales mailbox has exchanged mail with — one panel in Conversations. */
export interface Person {
  email: string;
  name: string;
  title?: string;
  institution?: string;
  leadId?: string;
  leadStatus?: LeadStatus;
  score?: number;
  doNotContact: boolean;
  conversations: number;
  unread: number;
  needsReply: number;
  drafts: number;
  /** Conversations waiting longer than the overdue limit (48 h by default) for a real answer. */
  overdue: number;
  waitingSince?: string;
  /** Holding replies go out for them when a reply is overdue. */
  autoReply: boolean;
  autoReplyDueAt?: string;
  lastAt?: string;
  lastSnippet?: string;
  lastSubject?: string;
  lastDirection?: 'inbound' | 'outbound';
}

export type PeopleFilter = 'all' | 'needs_reply' | 'overdue' | 'unread' | 'drafts' | 'leads' | 'new';

export interface PersonDetail {
  person: {
    email: string;
    name: string;
    title?: string;
    institution?: string;
    department?: string;
    phone?: string;
    doNotContact: boolean;
    autoReply: boolean;
    /** Override of the global follow-up switch (null = follow it). */
    followUpMode: 'auto' | 'manual' | null;
    lastMessageAt?: string;
  };
  lead: { id: string; status: LeadStatus; score?: number; products: string[]; summary?: string; tags: string[] } | null;
  threads: EmailThread[];
}

/** A mail read from the sales inbox (GET /threads/inbox). */
export interface InboundEmail {
  id: string;
  gmailId: string;
  from: string;
  fromName?: string;
  subject: string;
  bodyText: string;
  receivedAt: string;
  leadId?: string;
  threadId?: string;
  matchedBy?: 'thread' | 'email' | 'new_lead';
  intent?: string;
  summary?: string;
  urgency?: 'low' | 'normal' | 'high';
  action?: string;
  status: 'processed' | 'failed' | 'ignored';
  error?: string;
  attempts?: number;
  leadName?: string;
  leadInstitution?: string;
  leadStatus?: string;
}

export interface EmailThread {
  id: string;
  /** Absent for someone not in the CRM — the conversation is with contactEmail. */
  leadId?: string;
  contactEmail?: string;
  contactName?: string;
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
    fromAddress?: string;
    intent?: string;
    summary?: string;
    readAt?: string;
    sentBy?: string;
    draftedBy?: 'ai' | 'human';
    attachments?: { filename: string; mimeType?: string; size?: number }[];
  }[];
  followUp: { attemptsSent: number; maxAttempts: number; nextCheckAt?: string; replyDetected: boolean };
  /** A pending, unsent draft — present only while status is 'draft'. */
  draftType?: 'initial_outreach' | 'follow_up_1' | 'follow_up_2' | 'response' | 'check_in' | 'grant_note';
  /** A `response` draft: what their mail was about. */
  draftIntent?: string;
  draftSubject?: string;
  draftBody?: string;
  draftModel?: string;
  draftCreatedAt?: string;
  /** Their message still waiting for a real answer (an automatic holding reply doesn't count). */
  awaitingReplySince?: string;
  autoReplyDueAt?: string;
  autoReplySentAt?: string;
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
  aiDerived?: boolean;
  source?: 'seed' | 'website' | 'manual';
  images?: string[];
  lastSyncedAt?: string;
}

export interface ActivityLogEntry {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  relatedLeadId?: string;
  relatedThreadId?: string;
  /** Who did it (email) — absent when the app did it by itself. */
  actor?: string;
  actorName?: string;
  createdAt: string;
}

export type DashboardRange = '7' | '30' | '90' | 'all';

/** GET /dashboard — the analytics Home (backend services/dashboard/dashboardService.ts). */
export interface DashboardData {
  range: DashboardRange;
  from: string | null;
  generatedAt: string;
  headline: {
    inCrm: { value: number; delta: number; deltaLabel: string; prev: number | null };
    awaitingApproval: { value: number };
    discoveriesInProgress: { value: number };
    openConversations: { value: number };
    overdueReplies: { value: number };
    emailsSent: { value: number; prev: number | null };
    replyRate: { value: number | null; prev: number | null; contacted: number; replied: number };
  };
  alerts: Array<{ level: 'critical' | 'warning' | 'info'; title: string; detail: string; to: string }>;
  todo: { toReview: number; needsYou: number; conveyorFailed: number };
  funnel: Array<{ key: string; label: string; count: number }>;
  trends: {
    bucketDays: number;
    buckets: Array<{ start: string; newLeads: number; manual: number; ai: number; automatic: number; campaign: number; replies: number }>;
  };
  outreach: {
    sends: { manual: number; ai: number; automatic: number; campaign: number };
    received: number;
    replyRate: number | null;
    medianReplyHours: number | null;
    followUps: { auto: number; approved: number };
    campaigns: Array<{ id: string; name: string; kind: string; status: string; sent: number; opened: number; clicked: number; replied: number; unsubscribed: number; replyRate: number | null }>;
    topProducts: Array<{ productId: string; name: string; repliers: number }>;
    /** Campaign emails sent in the period and what people did with them (links and demo bookings). */
    engagement?: { emailed: number; opened: number; clicked: number; clickedBooking: number; bookedAfterClick: number; clickedNotBooked: number; bookings: number };
  };
  team: Array<{ who: string; name: string; sent: number; approved: number; medianResponseHours: number | null; waiting: number }>;
  activity: ActivityLogEntry[];
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

/** An import of older mailbox history (Admin → Settings → Mailbox). */
export interface MailboxImport {
  status: 'running' | 'done' | 'failed';
  from: string;
  to: string;
  found: number;
  handled: number;
  failed: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

/** Re-engagement check-ins (drafts for people who went quiet). */
export interface CheckInSettings {
  enabled: boolean;
  quietDays: number;
  dailyMax: number;
}

// --- Schedules ---------------------------------------------------------------------------------------
export type EventType = 'visit' | 'demo' | 'call' | 'meeting' | 'blocked' | 'other';
export type EventStatus = 'scheduled' | 'on_the_way' | 'checked_in' | 'done' | 'cancelled';
export interface FieldPoint {
  at: string;
  lat?: number;
  lng?: number;
  accuracy?: number;
  note?: string;
}
export interface ScheduleEvent {
  id: string;
  title: string;
  type: EventType;
  start: string;
  end: string;
  allDay?: boolean;
  leadId?: string;
  contactEmail?: string;
  contactName?: string;
  institution?: string;
  mode?: 'in_person' | 'online';
  address?: string;
  meetingLink?: string;
  assignee?: string;
  assigneeName?: string;
  notes?: string;
  status: EventStatus;
  /** As shown: a visit whose time passed with no check-in is "missed". */
  displayStatus: EventStatus | 'missed';
  onTheWay?: FieldPoint;
  checkIn?: FieldPoint;
  checkOut?: FieldPoint;
  outcome?: string;
  source?: 'app' | 'booking';
  booking?: { name?: string; email?: string; phone?: string; institution?: string; message?: string };
}
export type EventInput = Partial<Omit<ScheduleEvent, 'id' | 'displayStatus' | 'onTheWay' | 'checkIn' | 'checkOut' | 'assignee'>> & { assignee?: string | null };
export interface FieldPerson {
  email: string;
  name: string;
  state: 'at_visit' | 'on_the_way' | 'scheduled' | 'done_for_day' | 'free';
  current: ScheduleEvent | null;
  next: ScheduleEvent | null;
  lastLocation: { lat: number; lng: number; at: string; eventTitle: string; kind: 'onTheWay' | 'checkIn' | 'checkOut' } | null;
  visits: ScheduleEvent[];
}
export interface BookingSettings {
  enabled: boolean;
  title: string;
  days: number[];
  startTime: string;
  endTime: string;
  durationMinutes: number;
  bufferMinutes: number;
  horizonDays: number;
  noticeHours: number;
  mode: 'online' | 'in_person';
  assignee?: string;
  intro: string;
}
export interface PublicBooking {
  open: boolean;
  title: string;
  intro: string;
  durationMinutes: number;
  mode: 'online' | 'in_person';
  slots: Array<{ start: string; end: string }>;
}

/** One recipient of a sent campaign, and what they did with it. */
export interface CampaignResultRow {
  id: string;
  leadId?: string;
  name?: string;
  email: string;
  status: string;
  sentAt?: string;
  openedAt?: string;
  opens: number;
  clickedAt?: string;
  clicks: number;
  links: Array<{ url: string; at: string }>;
  clickedBooking: boolean;
  booked: { eventId: string; start: string } | null;
  replied: boolean;
  nudged: boolean;
}
export interface CampaignResults {
  rows: CampaignResultRow[];
  summary: { sent: number; opened: number; clicked: number; clickedBooking: number; booked: number; clickedNotBooked: number; replied: number };
}
