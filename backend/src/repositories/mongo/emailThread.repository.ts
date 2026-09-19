import { EmailThreadModel } from '../../models/emailThread.model.js';
import type { EmailThread, EmailThreadCreateInput } from '../../types/domain.js';
import { MongoRepository } from './mongo.repository.js';
import { where } from '../base.repository.js';

export class MongoEmailThreadRepository extends MongoRepository<
  EmailThread,
  EmailThreadCreateInput
> {
  constructor() {
    super(EmailThreadModel);
  }

  /**
   * The follow-up scheduler's core query: open threads whose check time has passed.
   *
   * Backed by the compound index `{ status, followUp.nextCheckAt }` — one flat
   * query, no join, and it is one of the two composite indexes to declare in
   * Firestore at migration time.
   */
  async findDueForFollowUp(now: Date = new Date(), limit = 100): Promise<EmailThread[]> {
    return this.find({
      filter: [where.eq('status', 'open'), where.lte('followUp.nextCheckAt', now)],
      options: { limit, sort: { 'followUp.nextCheckAt': 1 } },
    });
  }

  /** A lead's currently-open thread, if any. */
  async findOpenThreadForLead(leadId: string): Promise<EmailThread | null> {
    return this.findOne([where.eq('leadId', leadId), where.eq('status', 'open')]);
  }

  async findAllForLead(leadId: string): Promise<EmailThread[]> {
    return this.find({
      filter: [where.eq('leadId', leadId)],
      options: { sort: { createdAt: -1 } },
    });
  }

  /**
   * Appends a message to a thread.
   *
   * `$push` rather than read-modify-write, so two concurrent appends cannot
   * clobber each other. Firestore's `arrayUnion` is the direct equivalent.
   */
  async appendMessage(
    threadId: string,
    message: EmailThread['messages'][number],
  ): Promise<EmailThread | null> {
    const doc = await EmailThreadModel.findByIdAndUpdate(
      threadId,
      { $push: { messages: message } },
      { new: true },
    )
      .lean()
      .exec();
    return this.toDomain(doc as Record<string, any> | null);
  }
}
