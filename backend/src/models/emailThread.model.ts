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
      enum: ['initial_outreach', 'follow_up_1', 'follow_up_2', 'reply', 'response', 'manual', 'campaign'],
      required: true,
    },
    subject: { type: String, required: true },
    bodyText: { type: String, required: true },
    bodyHtml: String,
    sentAt: { type: Date, required: true },
    draftedBy: { type: String, enum: ['ai', 'human'] },
    approvedBy: String,
    aiDraftModel: String,
    rfcMessageId: String,
    fromAddress: String,
    readAt: Date,
    sentBy: String,
    attachments: [{ _id: false, filename: String, mimeType: String, size: Number }],
    intent: String,
    summary: String,
  },
  { _id: false },
);

const emailThreadSchema = new Schema(
  {
    leadId: { type: String, index: true },
    contactEmail: { type: String, index: true },
    contactName: String,
    // Snapshot so history stays truthful if the lead's email is edited later.
    leadEmailSnapshot: { type: String, required: true },

    subjectLine: { type: String, required: true },
    status: {
      type: String,
      enum: ['draft', 'open', 'replied', 'closed'],
      default: 'draft',
      required: true,
    },
    closedReason: {
      type: String,
      enum: ['replied', 'max_attempts_reached', 'manual', 'bounced'],
    },

    /**
     * A pending, unsent message: the AI drafts it here first; nothing is
     * pushed into `messages[]` (and status never leaves 'draft') until a human
     * approves it via `approveAndSendOutreach`. One draft at a time per thread.
     */
    draftType: {
      type: String,
      enum: ['initial_outreach', 'follow_up_1', 'follow_up_2', 'response'],
    },
    draftSubject: String,
    draftBody: String,
    draftModel: String,
    draftCreatedAt: Date,
    draftIntent: String,
    awaitingReplySince: { type: Date, index: true },
    autoReplyDueAt: Date,
    autoReplySentAt: Date,

    provider: { type: String, enum: ['ethereal', 'gmail'], required: true },
    providerThreadId: String,

    messages: { type: [messageSchema], default: [] },

    followUp: {
      attemptsSent: { type: Number, default: 0 },
      maxAttempts: { type: Number, default: 2 },
      lastOutboundAt: Date,
      nextCheckAt: Date,
      replyDetected: { type: Boolean, default: false },
      replyDetectionMethod: { type: String, enum: ['ai_summary', 'manual', 'gmail'] },
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
// Matching an incoming reply to the conversation it belongs to (services/email/inboxPoller.ts).
emailThreadSchema.index({ providerThreadId: 1 }, { sparse: true });

export type EmailThreadDocument = InferSchemaType<typeof emailThreadSchema>;
export const EmailThreadModel = model('EmailThread', emailThreadSchema);
