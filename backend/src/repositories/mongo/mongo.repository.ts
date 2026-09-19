/**
 * Generic MongoDB implementation of `Repository`.
 *
 * Everything Mongo-specific in the data layer lives here: filter translation,
 * document -> domain mapping, and dot-notation patching. Adding a Firestore
 * backend later means writing a sibling of this file, not touching call sites.
 */
import type { FilterQuery, Model, UpdateQuery } from 'mongoose';
import { isValidObjectId } from 'mongoose';
import type {
  DeepPartial,
  Filter,
  FilterCondition,
  Paginated,
  Query,
  Repository,
} from '../base.repository.js';

/** Escapes user input before it is used inside a RegExp. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function translateCondition(condition: FilterCondition): Record<string, unknown> {
  const { field, op, value } = condition;
  switch (op) {
    case 'eq':
      return { [field]: value };
    case 'ne':
      return { [field]: { $ne: value } };
    case 'lt':
      return { [field]: { $lt: value } };
    case 'lte':
      return { [field]: { $lte: value } };
    case 'gt':
      return { [field]: { $gt: value } };
    case 'gte':
      return { [field]: { $gte: value } };
    case 'in':
      return { [field]: { $in: value as unknown[] } };
    case 'nin':
      return { [field]: { $nin: value as unknown[] } };
    case 'contains':
      // Mongo matches an array field against a scalar element directly.
      // Firestore spells the same thing `array-contains`.
      return { [field]: value };
    default: {
      const exhaustive: never = op;
      throw new Error(`Unsupported filter operator: ${String(exhaustive)}`);
    }
  }
}

/**
 * Flattens a nested patch into dot-notation keys.
 *
 * Without this, `$set: { person: { email: 'x' } }` REPLACES the whole `person`
 * subdocument and silently drops name, title and the rest. `person.email: 'x'`
 * merges as intended. Arrays and Dates are treated as leaves — they are always
 * replaced wholesale, which is what callers expect.
 */
function flattenForSet(
  patch: Record<string, unknown>,
  prefix = '',
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const isPlainObject =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date);

    if (isPlainObject) {
      flattenForSet(value as Record<string, unknown>, path, out);
    } else {
      out[path] = value;
    }
  }
  return out;
}

export abstract class MongoRepository<TDoc extends { id: string }, TCreate>
  implements Repository<TDoc, TCreate>
{
  protected constructor(protected readonly model: Model<any>) {}

  /**
   * Maps a raw Mongo document to the domain type: `_id` becomes `id`, and
   * Mongo bookkeeping (`__v`) is dropped so it never leaks into API responses.
   */
  protected toDomain(doc: Record<string, any> | null): TDoc | null {
    if (!doc) return null;
    const { _id, __v, ...rest } = doc;
    return { ...rest, id: String(_id) } as TDoc;
  }

  protected translateFilter(query?: Query): FilterQuery<any> {
    const mongoFilter: FilterQuery<any> = {};
    const conditions: Record<string, unknown>[] = [];

    for (const condition of query?.filter ?? []) {
      conditions.push(translateCondition(condition));
    }

    if (conditions.length > 0) {
      Object.assign(mongoFilter, { $and: conditions });
    }

    // MIGRATION NOTE: regex substring search has no Firestore equivalent.
    // See `TextSearch` in base.repository.ts for the options at migration time.
    if (query?.search?.term && query.search.fields.length > 0) {
      const pattern = new RegExp(escapeRegex(query.search.term), 'i');
      Object.assign(mongoFilter, {
        $or: query.search.fields.map((field) => ({ [field]: pattern })),
      });
    }

    return mongoFilter;
  }

  async findById(id: string): Promise<TDoc | null> {
    // A malformed id is a normal "not found", not a 500.
    if (!isValidObjectId(id)) return null;
    const doc = await this.model.findById(id).lean().exec();
    return this.toDomain(doc as Record<string, any> | null);
  }

  async findOne(filter: Filter): Promise<TDoc | null> {
    const doc = await this.model.findOne(this.translateFilter({ filter })).lean().exec();
    return this.toDomain(doc as Record<string, any> | null);
  }

  async find(query: Query = {}): Promise<TDoc[]> {
    const { limit, skip, sort } = query.options ?? {};
    let cursor = this.model.find(this.translateFilter(query));
    if (sort) cursor = cursor.sort(sort);
    if (skip) cursor = cursor.skip(skip);
    if (limit) cursor = cursor.limit(limit);
    const docs = await cursor.lean().exec();
    return (docs as Record<string, any>[]).map((d) => this.toDomain(d)!);
  }

  async findPaginated(query: Query = {}): Promise<Paginated<TDoc>> {
    const limit = query.options?.limit ?? 50;
    const skip = query.options?.skip ?? 0;
    const mongoFilter = this.translateFilter(query);

    // Two independent reads, not a transaction — Firestore has no equivalent to
    // a multi-document snapshot and none is needed for a list view.
    const [docs, total] = await Promise.all([
      this.model
        .find(mongoFilter)
        .sort(query.options?.sort ?? { createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.model.countDocuments(mongoFilter).exec(),
    ]);

    return {
      items: (docs as Record<string, any>[]).map((d) => this.toDomain(d)!),
      total,
      limit,
      skip,
    };
  }

  async count(filter: Filter = []): Promise<number> {
    return this.model.countDocuments(this.translateFilter({ filter })).exec();
  }

  async create(data: TCreate): Promise<TDoc> {
    const created = await this.model.create(data as Record<string, unknown>);
    return this.toDomain(created.toObject())!;
  }

  async createMany(data: TCreate[]): Promise<TDoc[]> {
    if (data.length === 0) return [];
    const created = await this.model.insertMany(data as Record<string, unknown>[]);
    return created.map((d) => this.toDomain(d.toObject())!);
  }

  async updateById(id: string, patch: DeepPartial<TDoc>): Promise<TDoc | null> {
    if (!isValidObjectId(id)) return null;
    const flattened = flattenForSet(patch as Record<string, unknown>);
    // An empty patch is a no-op read, not an error.
    if (Object.keys(flattened).length === 0) return this.findById(id);

    const update: UpdateQuery<any> = { $set: flattened };
    const doc = await this.model
      .findByIdAndUpdate(id, update, { new: true, runValidators: true })
      .lean()
      .exec();
    return this.toDomain(doc as Record<string, any> | null);
  }

  async deleteById(id: string): Promise<boolean> {
    if (!isValidObjectId(id)) return false;
    const result = await this.model.findByIdAndDelete(id).lean().exec();
    return result !== null;
  }
}
