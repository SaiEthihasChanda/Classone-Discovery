/**
 * Mongoose schema for `app_settings` — a single document holding all editable
 * discovery configuration.
 *
 * WHY A SINGLETON DOCUMENT: this is per-deployment configuration, not per-user
 * data. One document means reads need no query planning, writes are atomic
 * without a transaction (which Firestore could not provide anyway), and there is
 * never a question of which row is authoritative.
 *
 * The YAML and TypeScript files remain the SEED defaults. On first run they are
 * copied in here; from then on this collection is the source of truth and the
 * Settings page edits it.
 */
import { Schema, model, type InferSchemaType } from 'mongoose';

const scrapeTargetSchema = new Schema(
  {
    targetId: { type: String, required: true },
    universityName: { type: String, required: true, trim: true },
    department: String,
    url: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: true },
    // Why a target is off — usually the reason it failed when probed.
    note: String,
    // Outcome of the last run against this target, so the UI can show what is
    // actually producing leads rather than what someone hoped would.
    lastPeopleFound: Number,
    lastFetchTier: String,
    lastCheckedAt: Date,
  },
  { _id: false },
);

const instrumentBrandSchema = new Schema(
  {
    key: { type: String, required: true },
    brand: { type: String, required: true, trim: true },
    vendor: { type: String, enum: ['classone', 'competitor'], required: true },
    // Derived from the catalog for our brands; a competitor is searched by
    // company name. Only the awkward cases (BioLogic) store anything here.
    searchAliases: { type: [String], default: undefined },
    enabled: { type: Boolean, default: true },
    // Whether to spend an OpenAlex query on this brand each run. Text
    // detection is free and happens whenever `enabled` is true.
    searchEnabled: { type: Boolean, default: false },
  },
  { _id: false },
);

const settingsSchema = new Schema(
  {
    // Fixed key so there can only ever be one settings document.
    singleton: { type: String, default: 'app', unique: true, immutable: true },

    discovery: {
      // Additional keywords only; the main set is derived from the catalog.
      queries: { type: [String], default: [] },
      region: {
        type: String,
        enum: ['indian_institutes', 'india', 'global'],
        default: 'indian_institutes',
      },
      institutionKinds: { type: [String], default: ['IIT', 'NIT', 'IIIT'] },
      // Opt-out list rather than opt-in: new institutions added to the seed data
      // are then included automatically instead of silently ignored.
      disabledInstitutionIds: { type: [String], default: [] },
      sinceYear: Number,
      enrichFacultyFromOpenAlex: { type: Boolean, default: true },
      instrumentSearchEnabled: { type: Boolean, default: true },
      identifyModels: { type: Boolean, default: true },
      instrumentLookbackYears: { type: Number, default: 7, min: 1, max: 30 },
      // Seeded from data/instrumentBrands.ts on first run; the UI edits it after.
      instrumentBrands: { type: [instrumentBrandSchema], default: [] },
      // Opt-out list of derived keyword groups, so a group added in code applies
      // automatically instead of being silently ignored.
      disabledKeywordGroups: { type: [String], default: [] },
    },

    scraping: {
      allowBrowser: { type: Boolean, default: true },
      allowProxy: { type: Boolean, default: true },
      followProfiles: { type: Boolean, default: true },
      maxProfileFetches: { type: Number, default: 20, min: 0, max: 100 },
      enrichFromLabSites: { type: Boolean, default: true },
      maxEnrichmentPagesPerLead: { type: Number, default: 8, min: 1, max: 30 },
      readOpenAccessPapers: { type: Boolean, default: true },
      maxPapersPerLead: { type: Number, default: 4, min: 0, max: 10 },
    },

    facultyTargets: { type: [scrapeTargetSchema], default: [] },
    newsTargets: { type: [scrapeTargetSchema], default: [] },
  },
  {
    timestamps: true,
    collection: 'app_settings',
    minimize: false,
  },
);

export type SettingsDocument = InferSchemaType<typeof settingsSchema>;
export const SettingsModel = model('Settings', settingsSchema);
