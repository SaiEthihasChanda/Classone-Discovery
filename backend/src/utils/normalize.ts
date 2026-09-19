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

/**
 * Expands the short forms Indian institutes are usually written in, so
 * "IIT Bombay" and "Indian Institute of Technology Bombay" compare equal.
 */
/** Campus short forms that appear in unit names ("IITB-Monash Research Academy"). */
const CAMPUS_CODES: Array<[RegExp, string]> = [
  [/\bIITB\b/g, 'Indian Institute of Technology Bombay'],
  [/\bIITD\b/g, 'Indian Institute of Technology Delhi'],
  [/\bIITM\b/g, 'Indian Institute of Technology Madras'],
  [/\bIITK\b/g, 'Indian Institute of Technology Kanpur'],
  [/\bIIT\s?KGP\b/g, 'Indian Institute of Technology Kharagpur'],
  [/\bIITR\b/g, 'Indian Institute of Technology Roorkee'],
  [/\bIITG\b/g, 'Indian Institute of Technology Guwahati'],
  [/\bIITH\b/g, 'Indian Institute of Technology Hyderabad'],
  [/\bIIT\s?BHU\b/g, 'Indian Institute of Technology BHU'],
  [/\bIITI\b/g, 'Indian Institute of Technology Indore'],
  [/\bIITJ\b/g, 'Indian Institute of Technology Jodhpur'],
  [/\bIITGN\b/g, 'Indian Institute of Technology Gandhinagar'],
  [/\bIITRPR\b/g, 'Indian Institute of Technology Ropar'],
  [/\bIITP\b/g, 'Indian Institute of Technology Patna'],
  [/\bIITBBS\b/g, 'Indian Institute of Technology Bhubaneswar'],
  [/\bIITPKD\b/g, 'Indian Institute of Technology Palakkad'],
  [/\bIITTP\b/g, 'Indian Institute of Technology Tirupati'],
  [/\bIITDH\b/g, 'Indian Institute of Technology Dharwad'],
  [/\bIIT\s?GOA\b/gi, 'Indian Institute of Technology Goa'],
  [/\bNITK\b/g, 'National Institute of Technology Karnataka'],
  [/\bNITT\b/g, 'National Institute of Technology Tiruchirappalli'],
  [/\bNITW\b/g, 'National Institute of Technology Warangal'],
  [/\bNITC\b/g, 'National Institute of Technology Calicut'],
  [/\bNITR\b/g, 'National Institute of Technology Rourkela'],
  [/\bMNIT\b/g, 'Malaviya National Institute of Technology Jaipur'],
  [/\bVNIT\b/g, 'Visvesvaraya National Institute of Technology'],
  [/\bSVNIT\b/g, 'Sardar Vallabhbhai National Institute of Technology Surat'],
  [/\bMANIT\b/g, 'Maulana Azad National Institute of Technology'],
  [/\bMNNIT\b/g, 'Motilal Nehru National Institute of Technology'],
];

export function expandInstitutionAbbreviations(name: string): string {
  for (const [re, full] of CAMPUS_CODES) name = name.replace(re, full);
  return name
    .replace(/\bIIIT\b/gi, 'Indian Institute of Information Technology')
    .replace(/\bIIT\b/gi, 'Indian Institute of Technology')
    .replace(/\bNIT\b/gi, 'National Institute of Technology')
    .replace(/\bIISc\b/g, 'Indian Institute of Science')
    .replace(/\bIISER\b/g, 'Indian Institute of Science Education and Research');
}

/** Turns a product name into a stable slug for `Product.productId`. */
export function slugify(input: string): string {
  return stripDiacritics(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
