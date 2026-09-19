/**
 * Normalisation helpers for dedupe keys.
 *
 * The same researcher arrives spelled differently from each source — "Dr. Lily
 * Chen", "Chen, L.", "L. Chen" — so names and institutions are reduced to a
 * canonical key that dedupe matching compares.
 */

/**
 * Strips accents so "Müller" and "Muller" produce the same key.
 * Uses a Unicode property escape rather than a literal character range, so the
 * behaviour does not depend on how this file happens to be encoded.
 */
function stripDiacritics(input: string): string {
  return input.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

const TITLE_PREFIXES = /^(dr|prof|professor|mr|mrs|ms|miss|sir|dame|assoc|asst)\.?\s+/gi;

/**
 * Builds a comparison key from a person's name.
 * "Prof. Lily  Chen" and "lily chen" both yield "chen lily" — tokens are sorted
 * so "Chen, Lily" and "Lily Chen" collapse together too.
 */
export function normalizeNameKey(name: string): string {
  if (!name) return '';
  const cleaned = stripDiacritics(name)
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(TITLE_PREFIXES, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.split(' ').filter(Boolean).sort().join(' ');
}

const INSTITUTION_NOISE =
  /\b(the|of|at|university|univ|college|institute|inst|school|dept|department|laboratory|lab|center|centre)\b/g;

/**
 * Builds a comparison key from an institution name.
 * Generic words carry no distinguishing information, so "Massachusetts Institute
 * of Technology" reduces to "massachusetts technology" — which still matches
 * against itself while tolerating "MIT Dept. of Chemistry" style variation.
 */
export function normalizeInstitutionKey(name?: string): string | undefined {
  if (!name) return undefined;
  const cleaned = stripDiacritics(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(INSTITUTION_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || undefined;
}

/** Turns a product name into a stable slug for `Product.productId`. */
export function slugify(input: string): string {
  return stripDiacritics(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
