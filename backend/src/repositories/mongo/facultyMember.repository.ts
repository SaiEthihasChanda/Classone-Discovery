import { FacultyMemberModel } from '../../models/facultyMember.model.js';
import type { FacultyMember, FacultyMemberCreateInput } from '../../types/domain.js';
import { MongoRepository } from './mongo.repository.js';
import { where } from '../base.repository.js';

export class MongoFacultyMemberRepository extends MongoRepository<FacultyMember, FacultyMemberCreateInput> {
  constructor() {
    super(FacultyMemberModel);
  }

  /**
   * The same human, by the strongest identifier available: ORCID, then the
   * OpenAlex author id, then name within the discovered institute. Sources
   * overlap heavily — most ORCID holders are in OpenAlex too — so this runs
   * before every roster insert.
   */
  async findSamePerson(params: {
    orcid?: string;
    openAlexAuthorId?: string;
    normalizedNameKey: string;
    institutionOpenAlexId?: string;
    email?: string;
  }): Promise<FacultyMember | null> {
    if (params.orcid) {
      const hit = await this.findOne([where.eq('person.orcid', params.orcid)]);
      if (hit) return hit;
    }
    if (params.openAlexAuthorId) {
      const hit = await this.findOne([where.eq('person.openAlexAuthorId', params.openAlexAuthorId)]);
      if (hit) return hit;
    }
    if (params.email) {
      const hit = await this.findOne([where.eq('person.email', params.email.toLowerCase())]);
      if (hit) return hit;
    }
    if (params.institutionOpenAlexId) {
      return this.findOne([
        where.eq('person.normalizedNameKey', params.normalizedNameKey),
        where.eq('institution.discoveredOpenAlexId', params.institutionOpenAlexId),
      ]);
    }
    return null;
  }

  /** Every member discovered at one institute — the pool a name-only source is matched against. */
  async findByInstitution(institutionOpenAlexId: string): Promise<FacultyMember[]> {
    return this.find({ filter: [where.eq('institution.discoveredOpenAlexId', institutionOpenAlexId)] });
  }

  async deleteAll(): Promise<number> {
    const r = await this.model.deleteMany({}).exec();
    return r.deletedCount ?? 0;
  }

  /** Counts by status, role and domain for the roster page header. */
  async summary(): Promise<{
    total: number;
    byStatus: Record<string, number>;
    byRole: Record<string, number>;
    byDomain: Record<string, number>;
    byInstitution: Array<{ name: string; eligible: number; promoted: number; excluded: number }>;
  }> {
    const group = async (field: string): Promise<Record<string, number>> => {
      const rows = (await this.model.aggregate([{ $group: { _id: `$${field}`, n: { $sum: 1 } } }]).exec()) as Array<{
        _id: string | null;
        n: number;
      }>;
      return Object.fromEntries(rows.map((r) => [r._id ?? '(none)', r.n]));
    };
    const [total, byStatus, byRole, byDomain, inst] = await Promise.all([
      this.model.countDocuments({}).exec(),
      group('status'),
      group('role.category'),
      group('department.domain'),
      this.model
        .aggregate([
          {
            $group: {
              _id: '$institution.discoveredName',
              eligible: { $sum: { $cond: [{ $eq: ['$status', 'eligible'] }, 1, 0] } },
              promoted: { $sum: { $cond: [{ $eq: ['$status', 'promoted'] }, 1, 0] } },
              excluded: { $sum: { $cond: [{ $eq: ['$status', 'excluded'] }, 1, 0] } },
            },
          },
          { $sort: { eligible: -1 } },
        ])
        .exec() as Promise<Array<{ _id: string | null; eligible: number; promoted: number; excluded: number }>>,
    ]);
    return {
      total,
      byStatus,
      byRole,
      byDomain,
      byInstitution: inst.map((r) => ({ name: r._id ?? '(none)', eligible: r.eligible, promoted: r.promoted, excluded: r.excluded })),
    };
  }
}
