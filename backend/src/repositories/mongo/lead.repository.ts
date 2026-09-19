import { LeadModel } from '../../models/lead.model.js';
import type { Lead, LeadCreateInput } from '../../types/domain.js';
import { MongoRepository } from './mongo.repository.js';
import { where } from '../base.repository.js';

export class MongoLeadRepository extends MongoRepository<Lead, LeadCreateInput> {
  constructor() {
    super(LeadModel);
  }

  /**
   * Finds an existing lead that looks like the same human.
   *
   * Discovery runs surface the same professor repeatedly — via OpenAlex, their
   * faculty page, and a news article in one pass — so this runs before every
   * insert. Email is the strong signal; name+institution is the fallback for
   * the many discovered leads that have no email yet.
   */
  async findDuplicate(params: {
    email?: string;
    normalizedNameKey: string;
    institutionKey?: string;
  }): Promise<Lead | null> {
    if (params.email) {
      const byEmail = await this.findOne([where.eq('person.email', params.email.toLowerCase())]);
      if (byEmail) return byEmail;
    }

    if (params.institutionKey) {
      return this.findOne([
        where.eq('person.normalizedNameKey', params.normalizedNameKey),
        where.eq('institution.normalizedNameKey', params.institutionKey),
      ]);
    }

    return null;
  }

  /** Looks up a lead by the stable id from its origin system, making re-discovery idempotent. */
  async findBySourceRecord(sourceType: string, sourceRecordId: string): Promise<Lead | null> {
    return this.findOne([
      where.eq('source.type', sourceType),
      where.eq('source.sourceRecordId', sourceRecordId),
    ]);
  }
}
