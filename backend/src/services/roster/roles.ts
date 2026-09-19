/**
 * Who counts as faculty — decided from a title string.
 *
 * The roster keeps professors (every rank, emeritus, heads and deans),
 * scientists, research/scientific officers and lab in-charges. It drops
 * students, scholars, postdocs and project staff, and adjunct/visiting/guest
 * appointments — a visiting professor buys nothing here. Titles come from
 * ORCID employment records and faculty pages, both free text, so this is
 * pattern matching with the exclusions checked FIRST: "Post-doctoral Research
 * Scientist" is a postdoc, whatever else the title says.
 */
import type { FacultyRoleCategory } from '../../types/domain.js';

export interface RoleDecision {
  category: FacultyRoleCategory;
  /** The pattern that decided it, for the exclusion reason and the audit trail. */
  matched?: string;
  /** Where the title came from; a faculty page is authoritative about today. */
  source?: 'faculty_page' | 'orcid' | 'import' | 'inferred';
}

/** Student, postdoc and project-staff titles. Checked before anything else. */
const STUDENT_PATTERNS: RegExp[] = [
  /\bph\.?\s?d\b/i,
  /\bdoctoral\b/i,
  /\bstudent\b/i,
  /\bscholar\b/i,
  /\bpost[\s-]?doc(toral)?\b/i,
  /\bresearch associate\b/i,
  /\bresearch assistant\b/i,
  /\bteaching assistant\b/i,
  // "Project Research Scientist", "Project Technical Assistant": fixed-term
  // project staff, whatever sits between the two words.
  /\bproject\s+(\w+\s+){0,2}(fellow|associate|assistant|staff|scientist|engineer|intern|manager|officer)\b/i,
  /\b(junior|senior)\s+research\s+fellow\b/i,
  /\b[js]rf\b/i,
  /\bintern(ship)?\b/i,
  /\btrainee\b/i,
  /\b(m\.?\s?tech|m\.?\s?sc|m\.?\s?s|b\.?\s?tech|b\.?\s?sc|m\.?\s?phil)\b/i,
  /\bcandidate\b/i,
  /\bgraduate\b/i,
  /\bundergraduate\b/i,
];

/** Appointments that are not the person's home institute. */
const ADJUNCT_PATTERNS: RegExp[] = [
  /\badjunct\b/i,
  /\bvisiting\b/i,
  /\bguest\b/i,
  /\bhonorary\b/i,
  /\baffiliate(d)?\s+(faculty|professor)\b/i,
];

/**
 * Fellowship schemes that are faculty-track positions in India, not stipends.
 * Listed before the generic "fellow" exclusion would otherwise catch them.
 */
const FACULTY_FELLOWSHIPS: RegExp[] = [
  /\binspire\s+faculty\b/i,
  /\bramanujan\s+fellow/i,
  /\bramalingaswami\b/i,
  /\bdst[\s-]+fellow/i,
  /\bswarnajayanti\b/i,
  /\bj\.?\s?c\.?\s?bose\b/i,
  /\bnational\s+post[\s-]?doctoral\s+fellow\b/i, // N-PDF is a postdoc; handled by STUDENT_PATTERNS first
];

const PROFESSOR_PATTERNS: RegExp[] = [
  /\bprofessor\b/i,
  /\bprof\.?\b/i,
  /\bemerit(us|a)\b/i,
  /\breader\b/i,
  /\blecturer\b/i,
  /\bfaculty\b/i,
  /\bdean\b/i,
  /\bhead\b/i,
  /\bhod\b/i,
  /\bchair(person|man|woman)?\b/i,
  /\bdirector\b/i,
  /\bprincipal investigator\b/i,
];

const SCIENTIST_PATTERNS: RegExp[] = [
  /\bscientist\b/i,
  /\bresearcher\b/i,
  /\bresearch\s+(engineer|lead|leader|manager)\b/i,
  /\binvestigator\b/i,
];

const OFFICER_PATTERNS: RegExp[] = [
  /\bscientific\s+officer\b/i,
  /\bresearch\s+officer\b/i,
  /\btechnical\s+officer\b/i,
  /\blab(oratory)?\s*(in[\s-]?charge|manager|head|superintendent)\b/i,
  /\bin[\s-]?charge\b/i,
  /\bengineer\b/i,
];

function firstMatch(title: string, patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const m = re.exec(title);
    if (m) return m[0];
  }
  return undefined;
}

/** Classifies one title. An empty or missing title is `unknown`, never a guess. */
export function classifyRole(title?: string | null): RoleDecision {
  const t = (title ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return { category: 'unknown' };

  // A faculty-track fellowship is decided before the student patterns, or
  // "INSPIRE Faculty Fellow" would be dropped by the generic "fellow" rule —
  // except N-PDF, which really is a postdoc.
  if (!/post[\s-]?doctoral/i.test(t)) {
    const fellowship = firstMatch(t, FACULTY_FELLOWSHIPS);
    if (fellowship) return { category: 'fellow', matched: fellowship };
  }

  const student = firstMatch(t, STUDENT_PATTERNS);
  if (student) return { category: 'excluded', matched: student };

  const adjunct = firstMatch(t, ADJUNCT_PATTERNS);
  if (adjunct) return { category: 'excluded', matched: adjunct };

  const professor = firstMatch(t, PROFESSOR_PATTERNS);
  if (professor) return { category: 'professor', matched: professor };

  const scientist = firstMatch(t, SCIENTIST_PATTERNS);
  if (scientist) return { category: 'scientist', matched: scientist };

  const officer = firstMatch(t, OFFICER_PATTERNS);
  if (officer) return { category: 'officer', matched: officer };

  // A bare "Fellow" with no scheme named is ambiguous in India (it is usually
  // a stipend); it stays unknown rather than being counted as faculty.
  return { category: 'unknown' };
}

/** Categories the roster treats as faculty. */
export const FACULTY_CATEGORIES: ReadonlySet<FacultyRoleCategory> = new Set([
  'professor',
  'scientist',
  'officer',
  'fellow',
  'inferred',
]);

export function isFacultyRole(category: FacultyRoleCategory): boolean {
  return FACULTY_CATEGORIES.has(category);
}

/**
 * Whether a publication record, on its own, reads as an established
 * researcher rather than a student. Used only for people with no title from
 * any source. Every threshold is conservative: a productive PhD student can
 * have 15 papers and an h-index of 8, but not across an 8-year span while
 * still publishing.
 */
export function inferSeniority(stats: {
  worksCount?: number;
  hIndex?: number;
  firstPublicationYear?: number;
  lastPublicationYear?: number;
  /** Distinct years the author published from the institute in question. */
  yearsAtInstitute?: number[];
  name?: string;
}, now: Date = new Date()): { senior: boolean; basis: string } {
  const year = now.getFullYear();
  const works = stats.worksCount ?? 0;
  const h = stats.hIndex ?? 0;
  const span = stats.firstPublicationYear ? year - stats.firstPublicationYear : 0;
  const active = (stats.lastPublicationYear ?? 0) >= year - 2;
  // Established AT THIS INSTITUTE: several publishing years here, one of
  // them recent. A merged OpenAlex profile (two people sharing a name)
  // looks senior overall but rarely shows a steady run of years at one place.
  const here = [...new Set(stats.yearsAtInstitute ?? [])];
  const hereSpan = here.length;
  const hereRecent = here.some((y) => y >= year - 2);
  // Initial-only names ("A. Sharma") are the profiles most often conflated.
  const firstToken = (stats.name ?? '').trim().split(/\s+/)[0]?.replace(/\./g, '') ?? '';
  const spelledOut = firstToken.length >= 3;
  const basis =
    `${works} works, h-index ${h}, publishing since ${stats.firstPublicationYear ?? '?'}` +
    `${active ? '' : ', not recently active'}; ${hereSpan} year${hereSpan === 1 ? '' : 's'} publishing from the institute` +
    `${hereRecent ? '' : ', none recent'}${spelledOut ? '' : '; initial-only name'}`;
  return { senior: works >= 15 && h >= 8 && span >= 8 && active && hereSpan >= 4 && hereRecent && spelledOut, basis };
}

/**
 * Picks the stronger of two role decisions when sources disagree. A stated
 * title beats an inference; among stated titles an exclusion wins, because a
 * faculty page that lists "Research Scholars" under the department is
 * describing them precisely.
 */
export function strongerRole(a: RoleDecision, b: RoleDecision): RoleDecision {
  // The institute's own page describes the person today; an ORCID employment
  // entry can be years stale ("PhD student", never closed). So a faculty
  // title from a page beats an exclusion from ORCID, while an exclusion from
  // the page itself ("Research Scholars" section) beats everything.
  const isPage = (r: RoleDecision) => r.source === 'faculty_page';
  const isFacultyTitle = (r: RoleDecision) => ['professor', 'scientist', 'officer', 'fellow'].includes(r.category);
  if (isPage(a) && isFacultyTitle(a) && b.category === 'excluded' && !isPage(b)) return a;
  if (isPage(b) && isFacultyTitle(b) && a.category === 'excluded' && !isPage(a)) return b;
  const rank = (c: FacultyRoleCategory): number =>
    ({ excluded: 6, professor: 5, scientist: 4, officer: 3, fellow: 3, inferred: 1, unknown: 0 })[c];
  return rank(b.category) > rank(a.category) ? b : a;
}
