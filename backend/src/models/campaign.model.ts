/**
 * Campaigns — a designed email (blocks) sent to leads picked by filters, one by
 * one through the sales Gmail at a set pace (services/campaigns/campaignService.ts).
 *
 *   campaigns            the design, the audience filter, schedule and pace
 *   campaign_recipients  one row per person it goes to — the send queue and its outcome
 *   campaign_assets      uploaded images, embedded in each email as inline (cid:) images
 */
import { Schema, model } from 'mongoose';

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
  /** An explicit list (a product launch's AI-picked recipients); the other filters still apply on top. */
  leadIds?: string[];
}

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'paused' | 'done' | 'cancelled';

const campaignSchema = new Schema(
  {
    name: { type: String, required: true },
    /** manual: built by a person. product_launch: made by services/campaigns/productLaunch.ts for a new website product. */
    kind: { type: String, enum: ['manual', 'product_launch'], default: 'manual' },
    productId: String,
    /** Auto launches: the end of the review window — it sends then unless paused. */
    reviewUntil: Date,
    subject: { type: String, default: '' },
    /** The grey line many mail apps show after the subject. */
    preheader: String,
    blocks: { type: [Schema.Types.Mixed], default: [] },
    audience: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['draft', 'scheduled', 'sending', 'paused', 'done', 'cancelled'], default: 'draft', index: true },
    sendAt: Date,
    /** Seconds between two emails of this campaign. */
    paceSeconds: { type: Number, default: 30 },
    startedAt: Date,
    finishedAt: Date,
    lastSentAt: Date,
    createdBy: String,
  },
  { collection: 'campaigns', timestamps: true, versionKey: false, minimize: false },
);

const recipientSchema = new Schema(
  {
    campaignId: { type: String, required: true, index: true },
    leadId: String,
    email: { type: String, required: true },
    name: String,
    status: { type: String, enum: ['queued', 'sent', 'failed', 'skipped'], default: 'queued', index: true },
    sentAt: { type: Date, index: true },
    threadId: String,
    error: String,
  },
  { collection: 'campaign_recipients', timestamps: true, versionKey: false },
);
recipientSchema.index({ campaignId: 1, email: 1 }, { unique: true });

const assetSchema = new Schema(
  {
    filename: { type: String, required: true },
    contentType: { type: String, required: true },
    data: { type: Buffer, required: true },
    size: Number,
    width: Number,
    height: Number,
    createdBy: String,
  },
  { collection: 'campaign_assets', timestamps: true, versionKey: false },
);

export const CampaignModel = model('Campaign', campaignSchema);
export const CampaignRecipientModel = model('CampaignRecipient', recipientSchema);
export const CampaignAssetModel = model('CampaignAsset', assetSchema);
