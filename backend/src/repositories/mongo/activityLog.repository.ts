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

  /**
   * The team activity log: newest first, filtered by who, kind and text, paged by `before` (a createdAt).
   * kind: 'people' = actions by signed-in people, 'system' = the app's own work.
   */
  async search(q: { text?: string; actor?: string; kind?: 'people' | 'system'; from?: Date; to?: Date; before?: Date; limit?: number }): Promise<ActivityLogEntry[]> {
    const filter: Record<string, unknown> = {};
    if (q.actor) filter.actor = q.actor;
    else if (q.kind === 'people') filter.actor = { $exists: true };
    else if (q.kind === 'system') filter.actor = { $exists: false };
    const created: Record<string, Date> = {};
    if (q.from) created.$gte = q.from;
    if (q.to) created.$lt = q.to;
    if (q.before) created.$lt = q.to && q.to < q.before ? q.to : q.before;
    if (Object.keys(created).length) filter.createdAt = created;
    if (q.text?.trim()) filter.message = { $regex: q.text.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const docs = await ActivityLogModel.find(filter).sort({ createdAt: -1 }).limit(Math.min(200, q.limit ?? 50)).lean();
    return docs.map((d) => this.toDomain(d as Record<string, any>)!);
  }

  /** Everyone who has done something, for the log's person filter. */
  async actors(): Promise<Array<{ actor: string; actorName?: string }>> {
    return (await ActivityLogModel.aggregate([{ $match: { actor: { $exists: true } } }, { $group: { _id: '$actor', actorName: { $last: '$actorName' } } }, { $sort: { _id: 1 } }])).map((a: { _id: string; actorName?: string }) => ({ actor: a._id, actorName: a.actorName }));
  }

  /** Backs the "Critical Alerts" tile. */
  async countCritical(since?: Date): Promise<number> {
    const filter = [where.eq('severity', 'critical')];
    if (since) filter.push(where.gte('createdAt', since));
    return this.count(filter);
  }
}
