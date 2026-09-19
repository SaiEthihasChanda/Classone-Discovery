import { ActivityLogModel } from '../../models/activityLog.model.js';
import type { ActivityLogCreateInput, ActivityLogEntry } from '../../types/domain.js';
import { MongoRepository } from './mongo.repository.js';
import { where } from '../base.repository.js';

export class MongoActivityLogRepository extends MongoRepository<
  ActivityLogEntry,
  ActivityLogCreateInput
> {
  constructor() {
    super(ActivityLogModel);
  }

  /** The dashboard's recent-activity feed. */
  async findRecent(limit = 20): Promise<ActivityLogEntry[]> {
    return this.find({ options: { limit, sort: { createdAt: -1 } } });
  }

  /** Backs the "Critical Alerts" tile. */
  async countCritical(since?: Date): Promise<number> {
    const filter = [where.eq('severity', 'critical')];
    if (since) filter.push(where.gte('createdAt', since));
    return this.count(filter);
  }
}
