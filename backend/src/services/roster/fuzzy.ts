/**
 * Fuzzy matching for the roster search box.
 *
 * A roster is a few hundred to a few thousand people, so the search reads the
 * candidates that pass the other filters and scores them in memory — no
 * index, no external service. Each query token must find a match among the
 * member's tokens (name, email, title, department, institute, topics, tags):
 * a prefix or exact token scores highest, then a small edit distance (typos),
 * then trigram overlap (transpositions, spelling variants). "Talur" finds
 * Tallur; "metallurgical" no longer finds him, because tokens are compared as
 * whole words, not substrings. Email and id fields still match by substring,
 * since nobody types a whole address.
 */
import type { FacultyMember } from '../../types/domain.js';

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function tokens(s: string): string[] {
  return fold(s)
    .split(/[^a-z0-9@.]+/)
    .filter((t) => t.length > 0);
}

/** Levenshtein distance with an early exit above `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      rowMin = Math.min(rowMin, cur[j]!);
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const g of ta) if (tb.has(g)) shared += 1;
  return shared / (ta.size + tb.size - shared || 1);
}

/** How well one query token matches one target token, 0..1. */
export function tokenScore(q: string, t: string): number {
  if (q === t) return 1;
  if (t.startsWith(q)) return q.length >= 3 ? 0.95 : 0.7;
  if (q.length >= 4 && q.startsWith(t) && t.length >= 3) return 0.6;
  const maxEdits = q.length >= 8 ? 2 : q.length >= 4 ? 1 : 0;
  if (maxEdits > 0 && editDistance(q, t, maxEdits) <= maxEdits) return 0.85;
  if (q.length >= 4 && t.length >= 4) {
    const sim = trigramSimilarity(q, t);
    if (sim >= 0.45) return 0.5 + sim * 0.4;
  }
  return 0;
}

export interface FuzzyFields {
  name: string;
  email?: string;
  title?: string;
  department?: string;
  institution?: string;
  topics?: string[];
  tags?: string[];
  ids?: string[];
}

export function memberFields(m: FacultyMember): FuzzyFields {
  return {
    name: m.person.name,
    email: m.person.email,
    title: m.person.title,
    department: m.department.name,
    institution: m.institution.name ?? m.institution.discoveredName,
    topics: m.research.topics,
    tags: m.tags,
    ids: [m.person.orcid, m.person.openAlexAuthorId].filter((x): x is string => Boolean(x)),
  };
}

/**
 * 0 = no match, otherwise the mean of the best per-token scores, weighted
 * towards the name. Every query token must match something (≥ 0.5) or the
 * member is out — "sagar mitra" must not return every Sagar.
 */
export function fuzzyScore(query: string, f: FuzzyFields): number {
  const qTokens = tokens(query);
  if (qTokens.length === 0) return 1;
  const whole = fold(query.trim());

  // Substring on the identifier-like fields: emails, ORCID, OpenAlex ids.
  for (const id of [f.email ?? '', ...(f.ids ?? [])]) {
    if (id && whole.length >= 3 && fold(id).includes(whole)) return 1;
  }

  const nameTokens = tokens(f.name);
  const otherTokens = [
    ...tokens(f.title ?? ''),
    ...tokens(f.department ?? ''),
    ...tokens(f.institution ?? ''),
    ...(f.topics ?? []).flatMap(tokens),
    ...(f.tags ?? []).flatMap(tokens),
    ...tokens(f.email ?? ''),
  ];

  let total = 0;
  for (const q of qTokens) {
    let best = 0;
    for (const t of nameTokens) best = Math.max(best, tokenScore(q, t));
    if (best < 1) for (const t of otherTokens) best = Math.max(best, tokenScore(q, t) * 0.9);
    // Initials: "s tallur" — a one-letter query token matches a name token's initial.
    if (best === 0 && q.length === 1 && nameTokens.some((t) => t.startsWith(q))) best = 0.7;
    if (best < 0.5) return 0;
    total += best;
  }
  return total / qTokens.length;
}

/** Members above the bar, best first; ties keep the caller's order. */
export function fuzzyFilter<T>(query: string, items: T[], fields: (item: T) => FuzzyFields, minScore = 0.6): Array<{ item: T; score: number }> {
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const score = fuzzyScore(query, fields(item));
    if (score >= minScore) scored.push({ item, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}
