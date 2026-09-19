/**
 * Mongoose schema for the `leads` collection — the CRM record.
 *
 * Mongoose is confined to this directory and `repositories/mongo/`. The rest of
 * the app uses the plain `Lead` type from `types/domain.ts`.
 */
import { Schema, model, type InferSchemaType } from 'mongoose';

const publicationSchema = new Schema(
  {
    title: { type: String, required: true },
    year: Number,
    url: String,
    sourceId: String,
  },
  { _id: false },
);

const grantSchema = new Schema(
  {
    title: { type: String, required: true },
    agency: String,
    amount: Number,
    year: Number,
    sourceId: String,
  },
  { _id: false },
);

const instrumentSchema = new Schema(
  {
    brandKey: { type: String, required: true },
    brand: { type: String, required: true },
    vendor: { type: String, enum: ['classone', 'competitor'], required: true },
    model: String,
    evidence: { type: String, required: true },
    sourceUrl: String,
    matchedVia: { type: String, enum: ['fulltext_search', 'text_match'], required: true },
  },
  { _id: false },
);

const leadSchema = new Schema(
  {
    status: {
      type: String,
      enum: ['pending_review', 'approved', 'rejected', 'customer'],
      default: 'pending_review',
      required: true,
    },

    source: {
      type: {
        type: String,
        enum: [
          'openalex',
          'faculty_page',
          'university_news',
          'grant_portal',
          'manual',
          'manual_discovery_trigger',
        ],
        required: true,
      },
      sourceUrl: String,
      sourceRecordId: String,
      discoveredAt: { type: Date, default: Date.now },
    },

    person: {
      name: { type: String, required: true, trim: true },
      normalizedNameKey: { type: String, required: true, index: true },
      email: { type: String, trim: true, lowercase: true },
      title: String,
      orcid: String,
      profileUrl: String,
      phone: String,
      websiteUrl: String,
    },

    institution: {
      name: { type: String, trim: true },
      normalizedNameKey: String,
      openAlexId: String,
      discoveredName: String,
      discoveredOpenAlexId: String,
      department: String,
      country: String,
      websiteUrl: String,
      affiliation: {
        status: { type: String, enum: ['current', 'moved', 'unknown', 'unverified'] },
        verifiedAt: Date,
        source: String,
        evidence: {
          type: [
            new Schema(
              {
                source: { type: String, required: true },
                institution: String,
                current: Boolean,
                url: String,
                detail: String,
              },
              { _id: false },
            ),
          ],
          default: undefined,
        },
        lastSeenYear: Number,
        previousInstitution: String,
        previousInstitutionOpenAlexId: String,
        directoryListed: Boolean,
        note: String,
      },
    },

    research: {
      summary: String,
      summaryGeneratedAt: Date,
      summaryModel: String,
      contentHash: String,
      topics: { type: [String], default: [] },
      recentPublications: { type: [publicationSchema], default: [] },
      recentGrants: { type: [grantSchema], default: [] },
      instruments: { type: [instrumentSchema], default: [] },
      webEnrichedAt: Date,
    },

    aiScoring: {
      relevanceScore: { type: Number, min: 0, max: 100 },
      relevanceReasoning: String,
      qualificationSignals: {
        productRelevance: Number,
        institutionalStrength: Number,
        recency: Number,
        engagementPotential: Number,
      },
      recommendedProductIds: { type: [String], default: [] },
      recommendedProductNotes: String,
      scoredAt: Date,
      scoringModel: String,
    },

    review: {
      reviewedBy: String,
      reviewedAt: Date,
      decision: { type: String, enum: ['approved', 'rejected'] },
      rejectionReason: String,
    },

    followUpStatusSummary: {
      type: String,
      enum: ['not_started', 'in_progress', 'closed'],
      default: 'not_started',
    },
    activeThreadId: String,

    tags: { type: [String], default: [] },
  },
  {
    timestamps: true,
    collection: 'leads',
    minimize: false,
  },
);

// Sparse: many discovered leads have no email yet, and null != null for uniqueness.
leadSchema.index({ 'person.email': 1 }, { sparse: true });
// Dedupe: the same professor arriving from OpenAlex and their faculty page.
leadSchema.index({ 'person.normalizedNameKey': 1, 'institution.normalizedNameKey': 1 });
// The review queue's primary query.
leadSchema.index({ status: 1, createdAt: -1 });
// Idempotent upsert when a weekly run re-discovers a known record.
leadSchema.index({ 'source.type': 1, 'source.sourceRecordId': 1 }, { sparse: true });
// Review queue sorted by score.
leadSchema.index({ status: 1, 'aiScoring.relevanceScore': -1 });

export type LeadDocument = InferSchemaType<typeof leadSchema>;
export const LeadModel = model('Lead', leadSchema);
