/**
 * The storage abstraction.
 *
 * WHY THIS FILE MATTERS: the plan is MongoDB now, Firebase Firestore later.
 * That migration is only cheap if nothing above this layer knows which database
 * is underneath. So the query surface here is deliberately restricted to the
 * INTERSECTION of what Mongo and Firestore can both do:
 *
 *   - no `$lookup` / joins           (Firestore has none — we denormalise instead)
 *   - no multi-document transactions (each write stands alone)
 *   - no raw driver filter objects   (a constrained operator set, translated per backend)
 *   - no aggregation pipelines       (counts and simple filters only)
 *
 * Callers never build a Mongo query object. They build `FilterCondition[]`, and
 * each repository implementation translates that into its own dialect.
 */

/**
 * Operators supported on both backends.
 *
 * `contains` means "this array field contains this value" — Mongo matches an
 * array element directly, Firestore calls it `array-contains`.
 *
 * Deliberately absent: `$regex`, `$expr`, `$where`, `$or`. Firestore cannot do
 * substring matching at all, so allowing it here would build in a migration
 * blocker. Text search is exposed separately (see `TextSearch`) precisely so the
 * one place that needs special handling at migration time is explicit.
 */
export type FilterOperator =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'in'
  | 'nin'
  | 'contains';

export interface FilterCondition {
  field: string;
  op: FilterOperator;
  value: unknown;
}

/** Conditions are ANDed together. Firestore composite queries work the same way. */
export type Filter = FilterCondition[];

/**
 * Free-text search across a named set of fields.
 *
 * MIGRATION NOTE: Mongo implements this with a case-insensitive regex. Firestore
 * CANNOT. When migrating, this must become either (a) prefix-range queries, which
 * only match from the start of a field, or (b) an external search index such as
 * Algolia or Typesense. It is isolated here — and used in exactly one place, the
 * lead list UI — so the migration cost is known and contained rather than
 * scattered across the codebase.
 */
export interface TextSearch {
  term: string;
  fields: string[];
}

export interface QueryOptions {
  limit?: number;
  skip?: number;
  /** Field -> direction. Firestore needs a composite index per sort+filter combination. */
  sort?: Record<string, 1 | -1>;
}

export interface Query {
  filter?: Filter;
  search?: TextSearch;
  options?: QueryOptions;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  skip: number;
}

/**
 * A deep-partial patch. Nested objects are merged field by field, so updating
 * `person.email` leaves the rest of `person` untouched.
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<U>
    : T[K] extends Date
      ? Date
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K];
};

/**
 * Storage operations available for every collection.
 *
 * `TDoc` is the domain type (with `id`), `TCreate` the shape accepted on insert.
 */
export interface Repository<TDoc extends { id: string }, TCreate> {
  findById(id: string): Promise<TDoc | null>;
  findOne(filter: Filter): Promise<TDoc | null>;
  find(query?: Query): Promise<TDoc[]>;
  /** Returns items plus a total count for the same filter — what list UIs need. */
  findPaginated(query?: Query): Promise<Paginated<TDoc>>;
  count(filter?: Filter): Promise<number>;
  create(data: TCreate): Promise<TDoc>;
  createMany(data: TCreate[]): Promise<TDoc[]>;
  updateById(id: string, patch: DeepPartial<TDoc>): Promise<TDoc | null>;
  deleteById(id: string): Promise<boolean>;
}

/** Convenience builders so call sites read cleanly. */
export const where = {
  eq: (field: string, value: unknown): FilterCondition => ({ field, op: 'eq', value }),
  ne: (field: string, value: unknown): FilterCondition => ({ field, op: 'ne', value }),
  lt: (field: string, value: unknown): FilterCondition => ({ field, op: 'lt', value }),
  lte: (field: string, value: unknown): FilterCondition => ({ field, op: 'lte', value }),
  gt: (field: string, value: unknown): FilterCondition => ({ field, op: 'gt', value }),
  gte: (field: string, value: unknown): FilterCondition => ({ field, op: 'gte', value }),
  in: (field: string, value: unknown[]): FilterCondition => ({ field, op: 'in', value }),
  nin: (field: string, value: unknown[]): FilterCondition => ({ field, op: 'nin', value }),
  contains: (field: string, value: unknown): FilterCondition => ({ field, op: 'contains', value }),
};
