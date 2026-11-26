/**
 * Mongoose schema for the `faculty` collection — the roster leads are promoted from.
 *
 * Mirrors `FacultyMember` in `types/domain.ts`. The institution subdocument is
 * the same shape as a lead's, so the affiliation check writes to both alike.
 */
import { Schema, model } from 'mongoose';

const publicationSchema = new Schema(
  { title: { type: String, required: true }, year: Number, url: String, sourceId: String },
  { _id: false },
);

const fundingSchema = new Schema(
  {
    agency: { type: String, enum: ['serb', 'anrf', 'dst', 'dbt', 'icmr', 'csir', 'birac', 'other'], required: true },
    funder: { type: String, required: true },
    funderId: String,
    awardId: String,
    scheme: String,
    year: Number,
    papers: { type: Number, default: 1 },
    workTitle: String,
    workYear: Number,
    workUrl: String,
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
    needsReview: Boolean,
  },
  { _id: false },
);

const evidenceSchema = new Schema(
  { source: { type: String, required: true }, institution: String, current: Boolean, url: String, detail: String },
  { _id: false },
);

const sourceSchema = new Schema(
  {
    type: { type: String, enum: ['orcid', 'openalex', 'faculty_page', 'vidwan', 'vidwan_import', 'manual'], required: true },
    recordId: { type: String, required: true },
    url: String,
    title: String,
    department: String,
    seenAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const facultyMemberSchema = new Schema(
  {
    status: { type: String, enum: ['eligible', 'excluded', 'promoted'], default: 'eligible', required: true },
    exclusionReason: String,

    person: {
      name: { type: String, required: true },
      normalizedNameKey: { type: String, required: true, index: true },
      email: String,
      title: String,
      phone: String,
      websiteUrl: String,
      profileUrl: String,
      orcid: { type: String, index: true, sparse: true },
      openAlexAuthorId: { type: String, index: true, sparse: true },
    },

    role: {
      category: {
        type: String,
        enum: ['professor', 'scientist', 'officer', 'fellow', 'inferred', 'unknown', 'excluded'],
        required: true,
      },
      rawTitle: String,
      basis: String,
    },

    department: {
      name: String,
      domain: {
        type: String,
        enum: [
          'chemistry',
          'biology',
          'biotechnology',
          'chemical_engineering',
          'biochemical_engineering',
          'materials',
          'energy',
          'electrical',
          'civil',
          'mechanical',
          'other',
        ],
        required: true,
        index: true,
      },
      gateTerms: [String],
    },

    institution: {
      name: String,
      normalizedNameKey: { type: String, index: true },
      openAlexId: String,
      discoveredName: String,
      discoveredOpenAlexId: { type: String, index: true },
      department: String,
      country: String,
      websiteUrl: String,
      outsideTarget: Boolean,
      affiliation: {
        status: { type: String, enum: ['current', 'moved', 'unknown', 'unverified', 'conflict'] },
        verifiedAt: Date,
        source: String,
        evidence: [evidenceSchema],
        lastSeenYear: Number,
        previousInstitution: String,
        previousInstitutionOpenAlexId: String,
        directoryListed: Boolean,
        note: String,
      },
    },

    sources: { type: [sourceSchema], default: [] },

    research: {
      topics: { type: [String], default: [] },
      worksCount: Number,
      hIndex: Number,
      firstPublicationYear: Number,
      lastPublicationYear: Number,
      recentPublications: { type: [publicationSchema], default: [] },
      evidenceText: String,
      instruments: { type: [instrumentSchema], default: [] },
      funding: { type: [fundingSchema], default: undefined },
      fundingCheckedAt: Date,
      applicationAreas: { type: [String], default: undefined },
    },

    relevance: {
      score: Number,
      reasoning: String,
      recommendedProductIds: [String],
      recommendedProductNotes: String,
      /** The four sub-scores the AI gives with the overall score — carried onto the lead's aiScoring. */
      signals: {
        productRelevance: Number,
        institutionalStrength: Number,
        recency: Number,
        engagementPotential: Number,
      },
      scoredAt: Date,
      scoringModel: String,
    },

    leadId: String,
    promotedAt: Date,
    tags: { type: [String], default: [] },

    /**
     * Where this person is on the Prospects conveyor (see services/pipeline/flowEngine.ts).
     * idle = waiting (Auto picks it up; Manual waits for a person) · queued = a person asked
     * for this step · processing · review = needs a human · failed = gave up after retries.
     */
    flow: {
      // No defaults on purpose: a member created outside a conveyor run (import,
      // the batch endpoints) has no flow yet, and flowEngine.migrateFlow places
      // them from what is already known (a promoted import belongs in Leads, not Found).
      stage: { type: String, enum: ['verify', 'score', 'promote', 'fill', 'done'] },
      state: { type: String, enum: ['idle', 'queued', 'processing', 'review', 'failed'] },
      /** Set by "Run next step" — e.g. promote even below the threshold. */
      forced: Boolean,
      attempts: Number,
      nextAttemptAt: Date,
      lastError: String,
      note: String,
      startedAt: Date,
      updatedAt: Date,
      runId: String,
    },
  },
  { timestamps: true, collection: 'faculty', minimize: false },
);

facultyMemberSchema.index({ 'person.normalizedNameKey': 1, 'institution.discoveredOpenAlexId': 1 });
facultyMemberSchema.index({ status: 1, 'relevance.score': -1 });
facultyMemberSchema.index({ 'flow.stage': 1, 'flow.state': 1, 'flow.nextAttemptAt': 1 });
facultyMemberSchema.index({ 'flow.runId': 1 });

export const FacultyMemberModel = model('FacultyMember', facultyMemberSchema);
