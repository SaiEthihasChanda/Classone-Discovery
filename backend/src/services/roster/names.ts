/**
 * Matching the same person across sources that spell them differently.
 *
 * ORCID has "Siddharth Tallur", a faculty page "Prof. S. Tallur", OpenAlex
 * "Tallur, S." — all one person. The full normalised key catches the first
 * two only when the given name is spelled out, so a second, weaker key of
 * first-initial + surname is kept, and used only when it is unique within an
 * institute. Indian names also appear surname-first, so the reversed form is
 * indexed too.
 */
import { normalizeNameKey } from '../../utils/normalize.js';

const PREFIX = /^(dr|prof|professor|mr|mrs|ms|shri|smt)\.?\s+/i;

function tokens(name: string): string[] {
  return normalizeNameKeyOrdered(name).split(' ').filter(Boolean);
}

/** Like `normalizeNameKey` but keeps the original token order. */
export function normalizeNameKeyOrdered(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(PREFIX, '')
    .replace(/,/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface NameKeys {
  full: string;
  /** "s tallur" and "t siddharth": initial of one end + the other end whole. */
  short: string[];
}

export function nameKeys(name: string): NameKeys {
  const full = normalizeNameKey(name);
  const t = tokens(name).filter((x) => x.length > 0);
  const short: string[] = [];
  if (t.length >= 2) {
    const first = t[0]!;
    const last = t[t.length - 1]!;
    // Only pair an initial with a real surname (3+ letters) — "s k" matches everyone.
    if (last.length >= 3) short.push(`${first[0]} ${last}`);
    if (first.length >= 3) short.push(`${last[0]} ${first}`);
  }
  return { full, short: [...new Set(short)] };
}

/**
 * An in-memory index over one institute's people. `find` returns the unique
 * match or nothing — never a guess between two candidates.
 */
export class NameIndex<T> {
  private readonly byFull = new Map<string, T[]>();
  private readonly byShort = new Map<string, T[]>();

  add(name: string, item: T): void {
    const keys = nameKeys(name);
    if (keys.full) this.push(this.byFull, keys.full, item);
    for (const s of keys.short) this.push(this.byShort, s, item);
  }

  find(name: string): T | undefined {
    const keys = nameKeys(name);
    const exact = keys.full ? this.byFull.get(keys.full) : undefined;
    if (exact && exact.length >= 1) return exact[0];
    const hits = new Set<T>();
    for (const s of keys.short) for (const item of this.byShort.get(s) ?? []) hits.add(item);
    return hits.size === 1 ? [...hits][0] : undefined;
  }

  private push(map: Map<string, T[]>, key: string, item: T): void {
    const list = map.get(key);
    if (list) {
      if (!list.includes(item)) list.push(item);
    } else {
      map.set(key, [item]);
    }
  }
}
