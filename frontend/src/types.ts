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
    department?: string;
    country?: string;
    websiteUrl?: string;
  };
  research: {
    summary?: string;
    topics: string[];
    recentPublications: { title: string; year?: number; url?: string }[];
    recentGrants: { title: string; agency?: string; amount?: number; year?: number }[];
    /** Optional: leads created before instrument detection existed lack it. */
    instruments?: LeadInstrument[];
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

export type InstrumentVendor = 'classone' | 'competitor';

/** An instrument the researcher has been seen using, with its evidence. */
export interface LeadInstrument {
  brandKey: string;
  brand: string;
  vendor: InstrumentVendor;
  model?: string;
  evidence: string;
  sourceUrl?: string;
  matchedVia: 'fulltext_search' | 'text_match';
}

export interface EmailThread {
  id: string;
  leadId: string;
  subjectLine: string;
  status: 'open' | 'replied' | 'closed';
  messages: {
    messageId: string;
    direction: 'outbound' | 'inbound';
    type: string;
    subject: string;
    bodyText: string;
    sentAt: string;
  }[];
  followUp: { attemptsSent: number; maxAttempts: number; nextCheckAt?: string };
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
