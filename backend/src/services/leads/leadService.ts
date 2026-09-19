/**
 * Lead business logic — dedupe, normalisation, and review transitions.
 *
 * Controllers stay thin; this is where the rules live, so the Phase 2 discovery
 * pipeline can reuse exactly the same create-with-dedupe path that the manual
 * "add a lead" form uses.
 */
import { repositories, where, type Filter } from '../../repositories/index.js';
import { ApiError } from '../../middleware/errorHandler.js';
import { normalizeInstitutionKey, normalizeNameKey } from '../../utils/normalize.js';
import { describeLead, logActivity } from '../activity/activityService.js';
import type { Lead, LeadCreateInput, LeadSourceType } from '../../types/domain.js';

export interface CreateLeadInput {
  name: string;
  email?: string;
  title?: string;
  orcid?: string;
  profileUrl?: string;
  institutionName?: string;
  department?: string;
  country?: string;
  institutionWebsite?: string;
  researchSummary?: string;
  topics?: string[];
  tags?: string[];
  sourceType?: LeadSourceType;
  sourceUrl?: string;
  sourceRecordId?: string;
}

export interface CreateLeadResult {
  lead: Lead;
  /** True when an existing record matched, so callers can report "already known". */
  wasDuplicate: boolean;
}

/**
 * Creates a lead unless one already exists for the same person.
 *
 * Dedupe runs on every path — manual entry and automated discovery alike — because
 * the same professor legitimately surfaces from several sources in one run.
 */
export async function createLead(
  input: CreateLeadInput,
  options: { logAs?: 'manual' | 'discovery' } = {},
): Promise<CreateLeadResult> {
  const normalizedNameKey = normalizeNameKey(input.name);
  if (!normalizedNameKey) {
    throw ApiError.badRequest('Lead name must contain at least one letter or number');
  }

  const institutionKey = normalizeInstitutionKey(input.institutionName);

  const existing = await repositories.leads.findDuplicate({
    email: input.email,
    normalizedNameKey,
    institutionKey,
  });
  if (existing) {
    return { lead: existing, wasDuplicate: true };
  }

  const now = new Date();
  const toCreate: LeadCreateInput = {
    status: 'pending_review',
    source: {
      type: input.sourceType ?? 'manual',
      sourceUrl: input.sourceUrl,
      sourceRecordId: input.sourceRecordId,
      discoveredAt: now,
    },
    person: {
      name: input.name.trim(),
      normalizedNameKey,
      email: input.email?.trim().toLowerCase(),
      title: input.title,
      orcid: input.orcid,
      profileUrl: input.profileUrl,
    },
    institution: {
      name: input.institutionName?.trim(),
      normalizedNameKey: institutionKey,
      discoveredName: input.institutionName?.trim(),
      department: input.department,
      country: input.country,
      websiteUrl: input.institutionWebsite,
    },
    research: {
      summary: input.researchSummary,
      topics: input.topics ?? [],
      recentPublications: [],
      recentGrants: [],
      instruments: [],
    },
    aiScoring: {
      recommendedProductIds: [],
    },
    review: {},
    followUpStatusSummary: 'not_started',
    tags: input.tags ?? [],
  };

  const lead = await repositories.leads.create(toCreate);

  if (options.logAs === 'manual') {
    await logActivity({
      type: 'lead_created_manually',
      message: `Lead added manually — ${describeLead(lead)}`,
      relatedLeadId: lead.id,
    });
  }

  return { lead, wasDuplicate: false };
}

/**
 * Records a human review decision.
 *
 * This is the gate the proposal calls for: nothing reaches outreach until a
 * person has approved it, which is what keeps AI false positives from ever
 * reaching a real researcher's inbox.
 */
export interface BulkReviewResult {
  decision: 'approved' | 'rejected';
  /** How many leads matched and were changed. */
  updated: number;
  /** Ids that were requested but were not pending (or did not exist) — left untouched. */
  skipped: number;
}

/**
 * Approves or rejects every PENDING lead matching the given ids or filter.
 *
 * The bulk path exists for the "approve all" button on the review queue. It
 * still only ever moves `pending_review` leads: a bulk action must not
 * re-approve something a human has already rejected, or vice versa. One
 * rollup activity entry is written rather than one per lead, so a 100-lead
 * approval does not bury the dashboard feed.
 */
export async function bulkReviewLeads(
  decision: 'approved' | 'rejected',
  params: {
    ids?: string[];
    minScore?: number;
    brands?: string[];
    reviewedBy?: string;
    rejectionReason?: string;
  } = {},
): Promise<BulkReviewResult> {
  const filter: Filter = [where.eq('status', 'pending_review')];
  if (params.ids && params.ids.length > 0) {
    filter.push(where.in('_id', params.ids));
  } else {
    if (params.minScore !== undefined) {
      filter.push(where.gte('aiScoring.relevanceScore', params.minScore));
    }
    if (params.brands && params.brands.length > 0) {
      filter.push(where.in('research.instruments.brandKey', params.brands));
    }
  }

  // Paged rather than capped: a discovery run is no longer bounded, so a queue
  // of several thousand is normal and "approve all" must mean all of them.
  // Each page is re-fetched from the front, because approving a lead removes it
  // from the pending filter — so the next page is always at skip 0.
  const PAGE = 500;
  const reviewedAt = new Date();
  let updated = 0;
  let seen = 0;

  for (;;) {
    const page = await repositories.leads.find({ filter, options: { limit: PAGE } });
    if (page.length === 0) break;
    seen += page.length;

    let changedThisPage = 0;
    for (const lead of page) {
      const result = await repositories.leads.updateById(lead.id, {
        status: decision,
        review: {
          decision,
          reviewedBy: params.reviewedBy ?? 'unknown',
          reviewedAt,
          rejectionReason: decision === 'rejected' ? params.rejectionReason : undefined,
        },
      });
      if (result) {
        updated += 1;
        changedThisPage += 1;
      }
    }

    // Nothing moved out of the filter, so re-fetching would return the same
    // page forever. Stop rather than spin.
    if (changedThisPage === 0) break;
  }

  const requested = params.ids?.length ?? seen;

  if (updated > 0) {
    await logActivity({
      type: decision === 'approved' ? 'lead_approved' : 'lead_rejected',
      message: `${updated} lead${updated === 1 ? '' : 's'} ${decision} in bulk${
        params.reviewedBy ? ` by ${params.reviewedBy}` : ''
      }`,
      metadata: {
        bulk: true,
        count: updated,
        ...(params.minScore !== undefined ? { minScore: params.minScore } : {}),
        ...(params.brands?.length ? { brands: params.brands } : {}),
      },
    });
  }

  return { decision, updated, skipped: Math.max(0, requested - updated) };
}

export async function reviewLead(
  id: string,
  decision: 'approved' | 'rejected',
  params: { reviewedBy?: string; rejectionReason?: string } = {},
): Promise<Lead> {
  const lead = await repositories.leads.findById(id);
  if (!lead) throw ApiError.notFound('Lead');

  const updated = await repositories.leads.updateById(id, {
    status: decision,
    review: {
      decision,
      reviewedBy: params.reviewedBy ?? 'unknown',
      reviewedAt: new Date(),
      rejectionReason: decision === 'rejected' ? params.rejectionReason : undefined,
    },
  });
  if (!updated) throw ApiError.notFound('Lead');

  await logActivity({
    type: decision === 'approved' ? 'lead_approved' : 'lead_rejected',
    message: `Lead ${decision} — ${describeLead(updated)}`,
    relatedLeadId: updated.id,
  });

  return updated;
}
