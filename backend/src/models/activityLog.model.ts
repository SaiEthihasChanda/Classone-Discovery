/**
 * Mongoose schema for `activity_log` — append-only, backs the dashboard feed
 * and the critical-alerts count.
 *
 * `message` is pre-rendered at write time (e.g. "New lead discovered —
 * Dr. L. Chen, MIT") so rendering the feed needs zero lookups back into `leads`.
 */
import { Schema, model, type InferSchemaType } from 'mongoose';

const activityLogSchema = new Schema(
  {
    type: {
      type: String,
      enum: [
        'lead_discovered',
        'lead_approved',
        'lead_rejected',
        'lead_created_manually',
        'email_sent',
        'follow_up_sent',
        'reply_detected',
        'thread_closed',
        'discovery_run_completed',
        'outreach_batch_completed',
        'system_error',
        'draft_created',
        'user_action',
        'visit_assigned',
        'visit_updated',
        'visit_checked_in',
        'visit_checked_out',
        'booking_created',
      ],
      required: true,
    },
    severity: {
      type: String,
      enum: ['info', 'warning', 'critical'],
      default: 'info',
      required: true,
    },
    message: { type: String, required: true },
    relatedLeadId: String,
    relatedThreadId: String,
    /** Who did it: the signed-in user's email, or absent for the system (services/activity). */
    actor: { type: String, index: true },
    actorName: String,
    metadata: { type: Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now },
  },
  {
    // Only createdAt — entries are never updated, so updatedAt would be dead weight.
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'activity_log',
    minimize: false,
  },
);

// The feed: newest first.
activityLogSchema.index({ createdAt: -1 });
// The critical-alerts tile.
activityLogSchema.index({ severity: 1, createdAt: -1 });

export type ActivityLogDocument = InferSchemaType<typeof activityLogSchema>;
export const ActivityLogModel = model('ActivityLog', activityLogSchema);
