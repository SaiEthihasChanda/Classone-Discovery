/**
 * Mongoose schema for `email_threads`.
 *
 * Thread history AND follow-up tracking live in one document: a thread has
 * exactly one follow-up lifecycle, and the scheduler's core query
 * ("open threads due for a check") then needs no join to also reach the message
 * history the AI reply-check reads.
 *
 * `messages` is bounded by the follow-up policy (initial + 2 follow-ups + any
 * replies), so embedding stays comfortably under Firestore's 1 MiB document
 * limit after migration.
 */
import { Schema, model, type InferSchemaType } from 'mongoose';

const messageSchema = new Schema(
  {
    messageId: { type: String, required: true },
    direction: { type: String, enum: ['outbound', 'inbound'], required: true },
    type: {
      type: String,
      enum: ['initial_outreach', 'follow_up_1', 'follow_up_2', 'reply'],
      required: true,
    },
    subject: { type: String, required: true },
    bodyText: { type: String, required: true },
    bodyHtml: String,
    sentAt: { type: Date, required: true },
    draftedBy: { type: String, enum: ['ai', 'human'] },
    approvedBy: String,
    aiDraftModel: String,
  },
  { _id: false },
);

const emailThreadSchema = new Schema(
  {
    leadId: { type: String, required: true, index: true },
    // Snapshot so history stays truthful if the lead's email is edited later.
    leadEmailSnapshot: { type: String, required: true },

    subjectLine: { type: String, required: true },
    status: {
      type: String,
      enum: ['open', 'replied', 'closed'],
      default: 'open',
      required: true,
    },
    closedReason: {
      type: String,
      enum: ['replied', 'max_attempts_reached', 'manual', 'bounced'],
    },

    provider: { type: String, enum: ['ethereal', 'gmail'], required: true },
    providerThreadId: String,

    messages: { type: [messageSchema], default: [] },

    followUp: {
      attemptsSent: { type: Number, default: 0 },
      maxAttempts: { type: Number, default: 2 },
      lastOutboundAt: Date,
      nextCheckAt: Date,
      replyDetected: { type: Boolean, default: false },
      replyDetectionMethod: { type: String, enum: ['ai_summary', 'manual'] },
      replyDetectedAt: Date,
      lastAiThreadSummary: String,
      lastAiCheckAt: Date,
    },
  },
  {
    timestamps: true,
    collection: 'email_threads',
    minimize: false,
  },
);

// THE scheduler query: `status = "open" AND followUp.nextCheckAt <= now`.
// This is one of the two compound indexes to declare in Firestore at migration.
emailThreadSchema.index({ status: 1, 'followUp.nextCheckAt': 1 });
// Dashboard "open threads" tile and per-lead thread lookup.
emailThreadSchema.index({ leadId: 1, status: 1 });

export type EmailThreadDocument = InferSchemaType<typeof emailThreadSchema>;
export const EmailThreadModel = model('EmailThread', emailThreadSchema);
