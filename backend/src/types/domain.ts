/**
 * Domain types — the shapes the application layer speaks in.
 *
 * These are deliberately plain TypeScript, with no Mongoose (or later Firestore)
 * types leaking in. Repositories map storage documents to these on the way out,
 * so swapping MongoDB for Firestore changes the repository implementations and
 * nothing above them.
 *
 * `id` is always a string. Mongo's ObjectId and Firestore's document id are both
 * representable as strings; nothing above the repository layer knows which.
 */

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

/** Where a lead came from. Drives dedupe and tells reviewers how much to trust it. */
export type LeadSourceType =
  | 'openalex'
  | 'faculty_page'
  | 'university_news'
  | 'grant_portal'
  | 'manual'
  | 'manual_discovery_trigger';

/**
 * Lifecycle of a lead.
 * `pending_review` -> human approves/rejects -> `approved` | `rejected`.
 * `customer` is set once a lead converts, so the dashboard can count real customers.
 */
export type LeadStatus = 'pending_review' | 'approved' | 'rejected' | 'customer';

/** Denormalised rollup of the lead's active thread, so list views need no join. */
export type FollowUpStatusSummary = 'not_started' | 'in_progress' | 'closed';

export interface LeadSource {
  type: LeadSourceType;
  sourceUrl?: string;
  /** Stable id from the origin system (e.g. an OpenAlex author id) — makes re-discovery idempotent. */
  sourceRecordId?: string;
  discoveredAt: Date;
}

export interface LeadPerson {
  name: string;
  /** Lowercased, punctuation-stripped name used for dedupe matching. */
  normalizedNameKey: string;
  email?: string;
  title?: string;
  orcid?: string;
  profileUrl?: string;
  /** From the institute profile page, when published there. */
  phone?: string;
  /** The lab or personal website, from the profile page or ORCID. */
  websiteUrl?: string;
}

export interface LeadInstitution {
  name?: string;
  normalizedNameKey?: string;
  department?: string;
  country?: string;
  websiteUrl?: string;
}

export interface LeadPublication {
  title: string;
  year?: number;
  url?: string;
  sourceId?: string;
}

export interface LeadGrant {
  title: string;
  agency?: string;
  amount?: number;
  year?: number;
  sourceId?: string;
}

/**
 * An instrument the researcher has been seen using, with the evidence for it.
 *
 * `vendor` is the sales meaning: `classone` = a PalmSens/CorrTest owner (an
 * existing customer — upgrade/accessory sale); `competitor` = owns a Gamry,
 * Autolab, BioLogic, CH Instruments or Admiral unit (a proven buyer of this
 * equipment category).
 */
export interface LeadInstrument {
  /** Slug from `data/instrumentBrands.ts`, e.g. "autolab". */
  brandKey: string;
  brand: string;
  vendor: 'classone' | 'competitor';
  /** Specific model when the text named one, e.g. "PGSTAT302N". */
  model?: string;
  /** Human-readable justification, e.g. the paper whose full text mentions it. */
  evidence: string;
  sourceUrl?: string;
  matchedVia: 'fulltext_search' | 'text_match';
}

export interface LeadResearch {
  summary?: string;
  summaryGeneratedAt?: Date;
  summaryModel?: string;
  /**
   * Hash of the source publication/grant ids this summary was built from.
   * Re-summarising is skipped while this is unchanged — the single biggest
   * OpenAI cost saver, since the same professor resurfaces every weekly run.
   */
  contentHash?: string;
  topics: string[];
  recentPublications: LeadPublication[];
  recentGrants: LeadGrant[];
  /** Empty for most leads — the UI omits the section entirely when so. */
  instruments: LeadInstrument[];
  /** When the profile/lab/paper web enrichment last ran for this lead. */
  webEnrichedAt?: Date;
}

/** The four qualification signals named in the proposal, each scored 0-100. */
export interface QualificationSignals {
  productRelevance?: number;
  institutionalStrength?: number;
  recency?: number;
  engagementPotential?: number;
}

export interface LeadAiScoring {
  /** Overall 0-100 relevance to Class One's product line. */
  relevanceScore?: number;
  relevanceReasoning?: string;
  qualificationSignals?: QualificationSignals;
  /** References `Product.productId` (a slug string, not a foreign key — Firestore has no joins). */
  recommendedProductIds: string[];
  recommendedProductNotes?: string;
  scoredAt?: Date;
  scoringModel?: string;
}

export interface LeadReview {
  reviewedBy?: string;
  reviewedAt?: Date;
  decision?: 'approved' | 'rejected';
  rejectionReason?: string;
}

export interface Lead {
  id: string;
  status: LeadStatus;
  source: LeadSource;
  person: LeadPerson;
  institution: LeadInstitution;
  research: LeadResearch;
  aiScoring: LeadAiScoring;
  review: LeadReview;
  followUpStatusSummary: FollowUpStatusSummary;
  activeThreadId?: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** Everything needed to create a lead; the rest is defaulted by the repository. */
export type LeadCreateInput = Omit<Lead, 'id' | 'createdAt' | 'updatedAt'>;

// ---------------------------------------------------------------------------
// Email threads (thread history + follow-up tracking in one document)
// ---------------------------------------------------------------------------

export type ThreadStatus = 'open' | 'replied' | 'closed';

export type ThreadClosedReason =
  | 'replied'
  | 'max_attempts_reached'
  | 'manual'
  | 'bounced';

export type MessageType =
  | 'initial_outreach'
  | 'follow_up_1'
  | 'follow_up_2'
  | 'reply';

export interface ThreadMessage {
  messageId: string;
  direction: 'outbound' | 'inbound';
  type: MessageType;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  sentAt: Date;
  draftedBy?: 'ai' | 'human';
  approvedBy?: string;
  aiDraftModel?: string;
}

export interface ThreadFollowUp {
  attemptsSent: number;
  maxAttempts: number;
  lastOutboundAt?: Date;
  /** When the scheduler should next examine this thread. Indexed — drives the whole job. */
  nextCheckAt?: Date;
  replyDetected: boolean;
  replyDetectionMethod?: 'ai_summary' | 'manual';
  replyDetectedAt?: Date;
  lastAiThreadSummary?: string;
  lastAiCheckAt?: Date;
}

export interface EmailThread {
  id: string;
  leadId: string;
  /** Snapshot of the address used, so history stays truthful if the lead's email is later edited. */
  leadEmailSnapshot: string;
  subjectLine: string;
  status: ThreadStatus;
  closedReason?: ThreadClosedReason;
  provider: 'ethereal' | 'gmail';
  providerThreadId?: string;
  /** Bounded by the follow-up policy (initial + 2 follow-ups + replies), so embedding is safe. */
  messages: ThreadMessage[];
  followUp: ThreadFollowUp;
  createdAt: Date;
  updatedAt: Date;
}

export type EmailThreadCreateInput = Omit<EmailThread, 'id' | 'createdAt' | 'updatedAt'>;

// ---------------------------------------------------------------------------
// Activity log (append-only; backs the dashboard feed and alert count)
// ---------------------------------------------------------------------------

export type ActivityType =
  | 'lead_discovered'
  | 'lead_approved'
  | 'lead_rejected'
  | 'lead_created_manually'
  | 'email_sent'
  | 'follow_up_sent'
  | 'reply_detected'
  | 'thread_closed'
  | 'discovery_run_completed'
  | 'outreach_batch_completed'
  | 'system_error';

export type ActivitySeverity = 'info' | 'warning' | 'critical';

export interface ActivityLogEntry {
  id: string;
  type: ActivityType;
  severity: ActivitySeverity;
  /**
   * Pre-rendered display string, e.g. "New lead discovered — Dr. L. Chen, MIT".
   * Denormalised at write time so the dashboard feed renders with zero lookups.
   */
  message: string;
  relatedLeadId?: string;
  relatedThreadId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export type ActivityLogCreateInput = Omit<ActivityLogEntry, 'id' | 'createdAt'>;

// ---------------------------------------------------------------------------
// Product catalog (grounds the AI's relevance scoring and product mapping)
// ---------------------------------------------------------------------------

export type ProductCategory =
  | 'potentiostat_portable'
  | 'potentiostat_benchtop'
  | 'multi_channel_workstation'
  | 'single_channel_workstation'
  | 'biosensor_kit'
  | 'spectroelectrochemistry'
  | 'application_kit'
  | 'oem_module'
  | 'battery_equipment'
  | 'thin_film_deposition'
  | 'electrode'
  | 'software_sdk'
  | 'accessory';

export interface Product {
  id: string;
  /** Stable slug — the key referenced from `Lead.aiScoring.recommendedProductIds`. */
  productId: string;
  name: string;
  category: ProductCategory;
  tags: string[];
  description?: string;
  /** Research areas this product serves, e.g. batteries, corrosion, catalysis. */
  applicationAreas: string[];
  /** e.g. python, matlab, labview, methodscript. */
  sdkSupport: string[];
  isActive: boolean;
  sourceUrl?: string;
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ProductCreateInput = Omit<Product, 'id' | 'createdAt' | 'updatedAt'>;
