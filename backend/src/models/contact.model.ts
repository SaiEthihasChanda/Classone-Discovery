/**
 * Everyone the sales mailbox has exchanged mail with — one document per email
 * address. CRM leads are linked by `leadId`; anyone else (a stranger who wrote,
 * someone the team mailed directly) still appears in Conversations through
 * their contact. Unread / needs-reply counts are not stored here: they are
 * worked out from the threads (routes/conversations.routes.ts), so they can
 * never drift.
 */
import { Schema, model } from 'mongoose';

const contactSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: String,
    title: String,
    institution: String,
    department: String,
    phone: String,
    leadId: { type: String, index: true },
    /** Asked not to be emailed (an unsubscribe reply, or set by hand). Mirrors lead.doNotContact for leads. */
    doNotContact: Boolean,
    /** Send AI holding replies when their message has waited too long (services/email/replyWatch.ts). */
    autoReply: Boolean,
    /** Override of the global follow-up mode for this person (unset = follow the global switch). */
    followUpMode: { type: String, enum: ['auto', 'manual'] },
    lastMessageAt: Date,
  },
  { collection: 'contacts', timestamps: true, versionKey: false },
);

export const ContactModel = model('Contact', contactSchema);

export interface ContactPatch {
  name?: string;
  title?: string;
  institution?: string;
  department?: string;
  phone?: string;
  leadId?: string;
  doNotContact?: boolean;
  autoReply?: boolean;
  lastMessageAt?: Date;
}

/**
 * Creates or updates a contact. Details only fill gaps (a name read from one
 * signature is not overwritten by a blank one later); leadId, doNotContact and
 * lastMessageAt always win.
 */
export async function touchContact(email: string, patch: ContactPatch = {}): Promise<void> {
  const key = email.trim().toLowerCase();
  if (!key.includes('@')) return;
  const existing = (await ContactModel.findOne({ email: key }).lean()) as ContactPatch | null;
  const set: Record<string, unknown> = {};
  for (const f of ['name', 'title', 'institution', 'department', 'phone'] as const) {
    if (patch[f] && !existing?.[f]) set[f] = patch[f];
  }
  if (patch.leadId) set.leadId = patch.leadId;
  if (patch.doNotContact !== undefined) set.doNotContact = patch.doNotContact;
  if (patch.autoReply !== undefined) set.autoReply = patch.autoReply;
  if (patch.lastMessageAt && (!existing?.lastMessageAt || patch.lastMessageAt > existing.lastMessageAt)) set.lastMessageAt = patch.lastMessageAt;
  await ContactModel.updateOne({ email: key }, { $set: set, $setOnInsert: { email: key } }, { upsert: true });
}
