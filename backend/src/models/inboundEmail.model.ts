/**
 * Every mail read from the sales inbox (services/email/inboxPoller.ts) — one
 * document per Gmail message. It is both the "already processed" record (the
 * unique gmailId keeps a mail from being handled twice) and what the Outreach
 * page's Inbox tab lists: who wrote, which lead it went to, what the AI read in
 * it, and what was done about it.
 */
import { Schema, model } from 'mongoose';

const inboundEmailSchema = new Schema(
  {
    gmailId: { type: String, required: true, unique: true },
    /** inbound: mail to us. outbound: mail sent from the mailbox outside the app (Gmail itself). */
    direction: { type: String, enum: ['inbound', 'outbound'], default: 'inbound' },
    gmailThreadId: { type: String, index: true },
    rfcMessageId: String,
    from: { type: String, required: true },
    fromName: String,
    subject: { type: String, default: '' },
    /** The new text only — quoted history below "On … wrote:" is stripped. */
    bodyText: { type: String, default: '' },
    receivedAt: { type: Date, required: true, index: true },

    leadId: { type: String, index: true },
    threadId: String,
    /** How the lead was found: their reply on our Gmail thread, their address, or a lead made for a new sender. */
    matchedBy: { type: String, enum: ['thread', 'email', 'new_lead', 'contact', 'sent'] },

    intent: String,
    summary: String,
    urgency: { type: String, enum: ['low', 'normal', 'high'] },
    /** What the app did: drafted a reply, nothing needed, marked do-not-contact, rescheduled the follow-up… */
    action: String,

    /** processed | failed (AI or matching error — retried on later polls) | ignored (our own / automated mail) */
    status: { type: String, enum: ['processed', 'failed', 'ignored'], required: true, index: true },
    error: String,
    attempts: { type: Number, default: 0 },
  },
  { collection: 'inbound_emails', timestamps: true, versionKey: false },
);

export const InboundEmailModel = model('InboundEmail', inboundEmailSchema);
