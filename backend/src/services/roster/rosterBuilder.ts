/**
 * Builds the faculty roster for a set of institutes.
 *
 * Three sources, merged per institute:
 *
 *   OpenAlex   — every author whose last known institution is the institute
 *                (filter-only calls, ~1 credit per 200 authors). Gives topics,
 *                output and an ORCID for many; says nothing about rank.
 *   ORCID      — everyone whose record names the institute, then each one's
 *                employment section (free). A CURRENT employment at the
 *                institute with a faculty title is the strongest evidence
 *                there is of who someone is; alumni and students fall away
 *                here.
 *   Faculty pages — the institute's own department listings, located from its
 *                homepage by the scraper. Catch people in neither database,
 *                and supply titles, emails and profile links.
 *
 * Who is kept: a faculty title from ORCID or a page (see `roles.ts`), or —
 * for people with no title anywhere — a publication record that reads as an
 * established researcher (`inferred`, tagged). Students, postdocs and
 * adjuncts are counted and dropped, never stored. Then the department gate
 * (`domains.ts`): chemistry, the biosciences, chemical/biochemical/materials/
 * energy engineering outright; civil and mechanical only with corrosion work.
 *
 * Everything external is injectable, so the merge logic is tested offline.
 */
import { INDIAN_INSTITUTIONS } from '../../data/indianInstitutions.js';
import {
  getInstitutionProfile,
  listInstitutionAuthors,
  type InstitutionAuthor,
  type InstitutionProfile,
} from '../../integrations/openAlexClient.js';
import { OpenAlexBudgetError } from '../../integrations/openAlexBudget.js';
import {
  getOrcidEmployments,
  getOrcidPerson,
  searchOrcidByInstitution,
  type OrcidEmployment,
} from '../../integrations/orcidClient.js';
import {
  findFacultyPages,
  isScraperAvailable,
  scrapeFacultyPages,
} from '../../integrations/scraperServiceClient.js';
import { repositories } from '../../repositories/index.js';
import type {
  FacultyDomain,
  FacultyMember,
  FacultyMemberCreateInput,
  FacultySource,
  LeadAffiliation,
} from '../../types/domain.js';
import { normalizeInstitutionKey, normalizeNameKey } from '../../utils/normalize.js';
import type { JobContext } from '../jobs/jobRunner.js';
import { instKey } from '../leads/affiliationService.js';
import { getSettings } from '../settings/settingsService.js';
import { decideDomain, DOMAIN_LABELS, type DomainDecision } from './domains.js';
import { NameIndex } from './names.js';
import { classifyRole, inferSeniority, isFacultyRole, strongerRole, type RoleDecision } from './roles.js';

export type RosterSource = 'orcid' | 'openalex' | 'faculty_pages';

export interface RosterBuildOptions {
  /** OpenAlex ids from `data/indianInstitutions.ts`. */
  institutionIds: string[];
  sources?: RosterSource[];
  /** Keep people with no title whose publication record reads as senior. Default true. */
  includeInferredRoles?: boolean;
  /** Works floor for the OpenAlex author listing. Default 5. */
  minWorks?: number;
  /** Cap per source per institute — tests and dry runs. */
  limitPerSource?: number;
  maxProbesPerInstitution?: number;
}

export interface RosterBuildDeps {
  institutionProfile?: typeof getInstitutionProfile;
  searchOrcid?: typeof searchOrcidByInstitution;
  orcidEmployments?: typeof getOrcidEmployments;
  orcidPerson?: typeof getOrcidPerson;
  listAuthors?: typeof listInstitutionAuthors;
  findPages?: typeof findFacultyPages;
  scrapePages?: typeof scrapeFacultyPages;
  scraperUp?: typeof isScraperAvailable;
}

export interface InstitutionBuildResult {
  id: string;
  name: string;
  orcidRecords: number;
  orcidCurrentHere: number;
  openAlexAuthors: number;
  pagesFound: number;
  pagePeople: number;
  created: number;
  updated: number;
  excludedRole: number;
  excludedDomain: number;
  droppedUnconfirmed: number;
  errors: string[];
}

export interface RosterBuildSummary {
  institutions: InstitutionBuildResult[];
  totals: Omit<InstitutionBuildResult, 'id' | 'name' | 'errors'> & { errors: number };
  durationMs: number;
}

/**
 * Department name fragments the scraper follows, in match order — "biochem"
 * before "chemical" or a Biochemical Engineering page would read as Chemical
 * Engineering. Each maps back to a department label for the domain gate.
 */
export const DEPARTMENT_HINTS: Array<{ hint: string; department: string }> = [
  { hint: 'biochem', department: 'Biochemical Engineering' },
  { hint: 'biotech', department: 'Biotechnology' },
  { hint: 'bioengineering', department: 'Bioengineering' },
  { hint: 'biomedical', department: 'Biomedical Engineering' },
  { hint: 'bioscience', department: 'Biosciences' },
  { hint: 'biolog', department: 'Biology' },
  { hint: 'life science', department: 'Life Sciences' },
  { hint: 'chemistry', department: 'Chemistry' },
  { hint: 'chemical', department: 'Chemical Engineering' },
  { hint: 'metallurg', department: 'Metallurgical Engineering' },
  { hint: 'material', department: 'Materials Science' },
  { hint: 'energy', department: 'Energy Science and Engineering' },
  { hint: 'civil', department: 'Civil Engineering' },
  { hint: 'mechanical', department: 'Mechanical Engineering' },
];

/** "Indian Institute of Technology Bombay" → ["IIT Bombay"]. The form ORCID users actually type. */
export function shortInstitutionNames(name: string): string[] {
  const out: string[] = [];
  const m = /^(Indian Institute of Technology|National Institute of Technology|Indian Institute of Information Technology|International Institute of Information Technology)\s+(.+)$/i.exec(
    name,
  );
  if (m) {
    const abbr = /information/i.test(m[1]!) ? 'IIIT' : /national/i.test(m[1]!) ? 'NIT' : 'IIT';
    out.push(`${abbr} ${m[2]}`);
  }
  return out;
}

/** One person as assembled from every source, before the keep/drop decision. */
interface Draft {
  name: string;
  orcid?: string;
  openAlexAuthorId?: string;
  email?: string;
  title?: string;
  phone?: string;
  websiteUrl?: string;
  profileUrl?: string;
  roles: RoleDecision[];
  department?: string;
  topics: InstitutionAuthor['topics'];
  stats: { worksCount?: number; hIndex?: number; firstPublicationYear?: number; lastPublicationYear?: number };
  keywords: string[];
  bio?: string;
  sources: FacultySource[];
  /** ORCID says they are employed here now — affiliation is settled at build time. */
  orcidCurrentHere?: OrcidEmployment;
}

function newDraft(name: string): Draft {
  return { name, roles: [], topics: [], stats: {}, keywords: [], sources: [] };
}

function addSource(draft: Draft, source: FacultySource): void {
  if (!draft.sources.some((s) => s.type === source.type && s.recordId === source.recordId)) draft.sources.push(source);
}

/** Employment at this institute with no end date, preferring one with a title. */
function currentEmploymentHere(
  employments: OrcidEmployment[],
  institute: { ror?: string; keys: Set<string> },
): OrcidEmployment | undefined {
  const here = employments.filter((e) => {
    if (!e.current) return false;
    if (institute.ror && e.orgId && e.orgId.toLowerCase() === institute.ror.toLowerCase()) return true;
    const k = instKey(e.organization);
    if (!k) return false;
    for (const key of institute.keys) {
      if (k === key || k.includes(key)) return true;
      // The employment name may be a shorter form of ours — but a bare
      // "Indian Institute of Technology" (no campus) must not match every IIT.
      if (key.includes(k) && k.split(' ').length >= 3) return true;
    }
    return false;
  });
  here.sort((a, b) => Number(Boolean(b.role)) - Number(Boolean(a.role)) || (b.startYear ?? 0) - (a.startYear ?? 0));
  return here[0];
}

export async function buildRoster(
  options: RosterBuildOptions,
  ctx: JobContext,
  deps: RosterBuildDeps = {},
): Promise<RosterBuildSummary> {
  const startedAt = Date.now();
  const sources = new Set<RosterSource>(options.sources ?? ['openalex', 'orcid', 'faculty_pages']);
  const includeInferred = options.includeInferredRoles ?? true;
  const fetchers = {
    institutionProfile: deps.institutionProfile ?? getInstitutionProfile,
    searchOrcid: deps.searchOrcid ?? searchOrcidByInstitution,
    orcidEmployments: deps.orcidEmployments ?? getOrcidEmployments,
    orcidPerson: deps.orcidPerson ?? getOrcidPerson,
    listAuthors: deps.listAuthors ?? listInstitutionAuthors,
    findPages: deps.findPages ?? findFacultyPages,
    scrapePages: deps.scrapePages ?? scrapeFacultyPages,
    scraperUp: deps.scraperUp ?? isScraperAvailable,
  };

  const institutions = options.institutionIds
    .map((id) => INDIAN_INSTITUTIONS.find((i) => i.openAlexId === id))
    .filter((i): i is NonNullable<typeof i> => Boolean(i));
  if (institutions.length === 0) throw new Error('No known institutes selected');

  const settings = await getSettings();
  const scraperUp = sources.has('faculty_pages') ? await fetchers.scraperUp() : false;
  if (sources.has('faculty_pages') && !scraperUp) {
    ctx.log('Scraper service is not running — faculty pages skipped for every institute', 'warn');
  }

  const results: InstitutionBuildResult[] = [];

  for (const [index, institution] of institutions.entries()) {
    ctx.checkpoint();
    const r: InstitutionBuildResult = {
      id: institution.openAlexId,
      name: institution.name,
      orcidRecords: 0,
      orcidCurrentHere: 0,
      openAlexAuthors: 0,
      pagesFound: 0,
      pagePeople: 0,
      created: 0,
      updated: 0,
      excludedRole: 0,
      excludedDomain: 0,
      droppedUnconfirmed: 0,
      errors: [],
    };
    results.push(r);
    const base = index / institutions.length;
    const span = 1 / institutions.length;
    ctx.setStage(`${institution.name}: resolving profile`, base);
    ctx.log(`— ${institution.name} —`);

    // --- Profile: ROR id, homepage, alternative names (free) ---------------
    let profile: InstitutionProfile | null = null;
    try {
      profile = await fetchers.institutionProfile(institution.openAlexId);
    } catch (error) {
      r.errors.push(`profile: ${String(error)}`);
    }
    const names = new Set<string>([institution.name, ...shortInstitutionNames(institution.name)]);
    if (profile) {
      for (const a of profile.acronyms) if (a.length >= 3) names.add(a);
      for (const alt of profile.alternatives) if (/institute|technology|IIT|NIT/i.test(alt)) names.add(alt);
    }
    const keys = new Set<string>();
    for (const n of names) {
      const k = instKey(n);
      if (k) keys.add(k);
    }
    const instituteMatch = { ror: profile?.ror, keys };

    const drafts: Draft[] = [];
    const byOrcid = new Map<string, Draft>();
    const byAuthor = new Map<string, Draft>();
    const index_ = new NameIndex<Draft>();
    const register = (d: Draft): Draft => {
      drafts.push(d);
      if (d.orcid) byOrcid.set(d.orcid, d);
      if (d.openAlexAuthorId) byAuthor.set(d.openAlexAuthorId, d);
      index_.add(d.name, d);
      return d;
    };
    const attachOrcid = (d: Draft, orcid: string) => {
      d.orcid = orcid;
      byOrcid.set(orcid, d);
    };

    // --- 1. OpenAlex authors -----------------------------------------------
    if (sources.has('openalex')) {
      ctx.setStage(`${institution.name}: listing OpenAlex authors`, base + span * 0.05);
      try {
        const { authors, total } = await fetchers.listAuthors({
          institutionId: institution.openAlexId,
          minWorks: options.minWorks ?? 5,
          limit: options.limitPerSource,
          onPage: (fetched, all) => ctx.setStage(`${institution.name}: OpenAlex authors ${fetched}/${all}`, base + span * 0.1),
        });
        r.openAlexAuthors = authors.length;
        ctx.count('openAlexAuthors', authors.length);
        ctx.log(`OpenAlex: ${authors.length} authors with ≥${options.minWorks ?? 5} works (of ${total})`);
        for (const a of authors) {
          const d = register(newDraft(a.name));
          d.openAlexAuthorId = a.id;
          if (a.orcid) attachOrcid(d, a.orcid);
          d.topics = a.topics;
          d.stats = {
            worksCount: a.worksCount,
            hIndex: a.hIndex,
            firstPublicationYear: a.firstPublicationYear,
            lastPublicationYear: a.lastPublicationYear,
          };
          addSource(d, { type: 'openalex', recordId: a.id, url: `https://openalex.org/${a.id}`, seenAt: new Date() });
        }
      } catch (error) {
        if (error instanceof OpenAlexBudgetError) {
          r.errors.push('OpenAlex allowance exhausted — author listing incomplete');
          ctx.log('OpenAlex allowance exhausted; author listing incomplete', 'error');
        } else {
          r.errors.push(`openalex: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    // --- 2. ORCID: everyone naming the institute, then their employments ---
    if (sources.has('orcid')) {
      ctx.setStage(`${institution.name}: searching ORCID`, base + span * 0.2);
      let hits: Awaited<ReturnType<typeof searchOrcidByInstitution>>['hits'] = [];
      try {
        const found = await fetchers.searchOrcid({
          ror: profile?.ror,
          names: [...names],
          limit: options.limitPerSource,
          onPage: (fetched, total) => ctx.setStage(`${institution.name}: ORCID search ${fetched}/${total}`, base + span * 0.25),
        });
        hits = found.hits;
        r.orcidRecords = hits.length;
        ctx.count('orcidRecords', hits.length);
        ctx.log(`ORCID: ${hits.length} records name the institute${found.truncated ? ' (search capped at 11,000)' : ''}`);
      } catch (error) {
        r.errors.push(`orcid search: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Employment lookups for the search hits, plus for OpenAlex authors
      // whose ORCID the search did not return (it indexes what the user typed).
      const toCheck = new Map<string, { name: string; emails: string[] }>();
      for (const h of hits) toCheck.set(h.orcid, { name: h.name, emails: h.emails });
      for (const d of drafts) if (d.orcid && !toCheck.has(d.orcid)) toCheck.set(d.orcid, { name: d.name, emails: [] });

      let done = 0;
      for (const [orcid, hit] of toCheck) {
        ctx.checkpoint();
        done += 1;
        if (done % 25 === 0) {
          ctx.setStage(`${institution.name}: ORCID employments ${done}/${toCheck.size}`, base + span * (0.3 + 0.4 * (done / toCheck.size)));
        }
        let record: Awaited<ReturnType<typeof getOrcidEmployments>> = null;
        try {
          record = await fetchers.orcidEmployments(orcid);
        } catch {
          record = null;
        }
        ctx.count('orcidLookups');
        if (!record) continue;
        const here = currentEmploymentHere(record.employments, instituteMatch);
        if (!here) continue;
        r.orcidCurrentHere += 1;

        let d = byOrcid.get(orcid) ?? index_.find(hit.name);
        if (d && d.orcid && d.orcid !== orcid) d = undefined; // a namesake with a different ORCID
        if (!d) d = register(newDraft(hit.name));
        if (!d.orcid) attachOrcid(d, orcid);
        d.orcidCurrentHere = here;
        d.roles.push(classifyRole(here.role));
        if (here.role && !d.title) d.title = here.role;
        if (here.department && !d.department) d.department = here.department;
        if (!d.email && hit.emails[0]) d.email = hit.emails[0];
        addSource(d, {
          type: 'orcid',
          recordId: orcid,
          url: `https://orcid.org/${orcid}`,
          title: here.role,
          department: here.department,
          seenAt: new Date(),
        });
      }
      ctx.log(`ORCID: ${r.orcidCurrentHere} with a current employment at the institute`);
    }

    // --- 3. Faculty pages ---------------------------------------------------
    if (sources.has('faculty_pages') && scraperUp) {
      ctx.setStage(`${institution.name}: locating faculty pages`, base + span * 0.72);
      const targets = new Map<string, { url: string; department?: string }>();

      // Pages already configured in Settings for this institute.
      const k = normalizeInstitutionKey(institution.name);
      for (const t of settings.facultyTargets) {
        if (!t.enabled) continue;
        const tk = normalizeInstitutionKey(t.universityName);
        if (tk && k && (tk === k || tk.includes(k) || k.includes(tk))) targets.set(t.url, { url: t.url, department: t.department });
      }

      if (profile?.homepageUrl) {
        try {
          const found = await fetchers.findPages({
            institutions: [{ name: institution.name, homepageUrl: profile.homepageUrl }],
            departmentHints: DEPARTMENT_HINTS.map((h) => h.hint),
            maxProbes: options.maxProbesPerInstitution ?? 30,
          });
          for (const res of found.results) {
            if (res.error) {
              r.errors.push(`faculty pages: ${res.error}${res.detail ? ` (${res.detail})` : ''}`);
              continue;
            }
            for (const p of res.pages) {
              const dept = DEPARTMENT_HINTS.find((h) => h.hint === p.department)?.department;
              if (!targets.has(p.url)) targets.set(p.url, { url: p.url, department: dept });
            }
          }
        } catch (error) {
          r.errors.push(`faculty pages: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        r.errors.push('faculty pages: no homepage known for the institute');
      }
      r.pagesFound = targets.size;
      ctx.count('pagesFound', targets.size);
      ctx.log(`Faculty pages: ${targets.size} listing${targets.size === 1 ? '' : 's'}${targets.size ? ` — ${[...targets.keys()].slice(0, 5).join(', ')}${targets.size > 5 ? ', …' : ''}` : ''}`);

      if (targets.size > 0) {
        ctx.setStage(`${institution.name}: reading ${targets.size} faculty pages`, base + span * 0.8);
        try {
          const response = await fetchers.scrapePages(
            [...targets.values()].map((t) => ({ university_name: institution.name, faculty_page_url: t.url })),
            {
              followProfiles: settings.scraping.followProfiles,
              maxProfileFetches: Math.max(settings.scraping.maxProfileFetches, 40),
              allowBrowser: settings.scraping.allowBrowser,
              timeoutMs: 900_000,
            },
          );
          for (const e of response.errors) r.errors.push(`${e.target}: ${e.reason}${e.detail ? ` (${e.detail})` : ''}`);
          for (const page of response.results) {
            const target = targets.get(page.source_url);
            const isFacultyUrl = /faculty|professor/i.test(page.source_url);
            for (const person of page.extracted) {
              r.pagePeople += 1;
              let d = index_.find(person.name);
              if (!d) d = register(newDraft(person.name));
              const role = person.title
                ? classifyRole(person.title)
                : isFacultyUrl
                  ? ({ category: 'professor', matched: 'listed on a faculty page' } as RoleDecision)
                  : ({ category: 'unknown' } as RoleDecision);
              d.roles.push(role);
              if (person.title && !d.title) d.title = person.title;
              const dept = person.department ?? target?.department;
              if (dept && !d.department) d.department = dept;
              if (person.email && !d.email) d.email = person.email.toLowerCase();
              if (person.profile_url && !d.profileUrl) d.profileUrl = person.profile_url;
              if (person.bio && !d.bio) d.bio = person.bio;
              addSource(d, {
                type: 'faculty_page',
                recordId: person.profile_url ?? `${page.source_url}#${normalizeNameKey(person.name)}`,
                url: person.profile_url ?? page.source_url,
                title: person.title ?? undefined,
                department: dept,
                seenAt: new Date(),
              });
            }
          }
          ctx.count('pagePeople', r.pagePeople);
          ctx.log(`Faculty pages: ${r.pagePeople} people listed`);
        } catch (error) {
          r.errors.push(`faculty scrape: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    // --- 4. Decide and store ------------------------------------------------
    ctx.setStage(`${institution.name}: deciding ${drafts.length} people`, base + span * 0.9);
    for (const d of drafts) {
      ctx.checkpoint();
      const outcome = await decideAndStore(d, institution, { includeInferred, orcidPerson: fetchers.orcidPerson });
      r[outcome] += 1;
    }

    ctx.count('created', r.created);
    ctx.count('updated', r.updated);
    ctx.count('excludedRole', r.excludedRole);
    ctx.count('excludedDomain', r.excludedDomain);
    ctx.count('droppedUnconfirmed', r.droppedUnconfirmed);
    ctx.log(
      `${institution.name}: ${r.created} added, ${r.updated} updated; dropped ${r.excludedRole} by role, ${r.excludedDomain} by department, ${r.droppedUnconfirmed} unconfirmed`,
    );
    for (const e of r.errors) ctx.log(`${institution.name}: ${e}`, 'warn');
  }

  const totals = results.reduce(
    (acc, r) => ({
      orcidRecords: acc.orcidRecords + r.orcidRecords,
      orcidCurrentHere: acc.orcidCurrentHere + r.orcidCurrentHere,
      openAlexAuthors: acc.openAlexAuthors + r.openAlexAuthors,
      pagesFound: acc.pagesFound + r.pagesFound,
      pagePeople: acc.pagePeople + r.pagePeople,
      created: acc.created + r.created,
      updated: acc.updated + r.updated,
      excludedRole: acc.excludedRole + r.excludedRole,
      excludedDomain: acc.excludedDomain + r.excludedDomain,
      droppedUnconfirmed: acc.droppedUnconfirmed + r.droppedUnconfirmed,
      errors: acc.errors + r.errors.length,
    }),
    { orcidRecords: 0, orcidCurrentHere: 0, openAlexAuthors: 0, pagesFound: 0, pagePeople: 0, created: 0, updated: 0, excludedRole: 0, excludedDomain: 0, droppedUnconfirmed: 0, errors: 0 },
  );
  return { institutions: results, totals, durationMs: Date.now() - startedAt };
}

export type DraftOutcome = 'created' | 'updated' | 'excludedRole' | 'excludedDomain' | 'droppedUnconfirmed';

/** The keep/drop decision for one assembled person, and the write that follows. */
async function decideAndStore(
  d: Draft,
  institution: { openAlexId: string; name: string },
  opts: { includeInferred: boolean; orcidPerson: typeof getOrcidPerson },
): Promise<DraftOutcome> {
  // Role: the strongest stated title wins; no title anywhere → infer from output.
  let role: RoleDecision = { category: 'unknown' };
  for (const candidate of d.roles) role = strongerRole(role, candidate);
  let basis: string | undefined;
  if (role.category === 'unknown') {
    const inferred = inferSeniority(d.stats);
    basis = inferred.basis;
    if (inferred.senior && opts.includeInferred) role = { category: 'inferred', matched: 'publication record' };
  }

  if (role.category === 'excluded') {
    await markExcludedIfKnown(d, institution.openAlexId, `role: ${d.title ?? role.matched}`);
    return 'excludedRole';
  }
  if (!isFacultyRole(role.category)) return 'droppedUnconfirmed';

  // Domain: department name first, topics second; corrosion gate for
  // civil/mechanical reads keywords, bio and topic names — and, when
  // those are thin and there is an ORCID, its keywords (free).
  let text = [...d.keywords, d.bio ?? '', ...d.topics.map((t) => t.name)].join(' ');
  let domain: DomainDecision = decideDomain({ department: d.department, topics: d.topics, text });
  if (!domain.kept && (domain.domain === 'civil' || domain.domain === 'mechanical') && d.orcid) {
    try {
      const person = await opts.orcidPerson(d.orcid);
      if (person) {
        d.keywords.push(...person.keywords);
        if (!d.email && person.emails[0]) d.email = person.emails[0];
        if (!d.websiteUrl && person.urls[0]) d.websiteUrl = person.urls[0].url;
        text = `${text} ${person.keywords.join(' ')}`;
        domain = decideDomain({ department: d.department, topics: d.topics, text });
      }
    } catch {
      // Best effort.
    }
  }
  if (!domain.kept) {
    await markExcludedIfKnown(d, institution.openAlexId, domain.reason ?? `domain: ${DOMAIN_LABELS[domain.domain]}`);
    return 'excludedDomain';
  }

  return upsertMember(d, institution, role, domain, basis);
}

/** A row from an imported list (a Vidwan/IRINS export, a hand-made CSV). */
export interface ImportRow {
  name: string;
  institutionName: string;
  department?: string;
  title?: string;
  email?: string;
  orcid?: string;
  profileUrl?: string;
  keywords?: string;
}

export interface ImportSummary {
  rows: number;
  unknownInstitution: number;
  created: number;
  updated: number;
  excludedRole: number;
  excludedDomain: number;
  droppedUnconfirmed: number;
}

/**
 * Imports people from a list the user supplies, under the same role and
 * department rules as the live sources. Rows whose institute is not one of
 * the 72 are counted and skipped.
 */
export async function importRoster(rows: ImportRow[], sourceType: 'vidwan_import' | 'manual' = 'vidwan_import'): Promise<ImportSummary> {
  const summary: ImportSummary = { rows: rows.length, unknownInstitution: 0, created: 0, updated: 0, excludedRole: 0, excludedDomain: 0, droppedUnconfirmed: 0 };
  for (const row of rows) {
    const name = row.name?.trim();
    if (!name) continue;
    const key = instKey(row.institutionName);
    const institution = INDIAN_INSTITUTIONS.find((i) => {
      const k = instKey(i.name);
      return Boolean(key && k && (k === key || k.includes(key) || key.includes(k)));
    });
    if (!institution) {
      summary.unknownInstitution += 1;
      continue;
    }
    const d = newDraft(name);
    d.title = row.title?.trim() || undefined;
    d.department = row.department?.trim() || undefined;
    d.email = row.email?.trim().toLowerCase() || undefined;
    d.orcid = row.orcid?.match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/)?.[0];
    d.profileUrl = row.profileUrl?.trim() || undefined;
    if (row.keywords) d.keywords.push(...row.keywords.split(/[;,]/).map((k) => k.trim()).filter(Boolean));
    // A named list of faculty is itself evidence of rank when no title is given.
    d.roles.push(d.title ? classifyRole(d.title) : { category: 'professor', matched: `listed in ${sourceType.replace('_', ' ')}` });
    addSource(d, { type: sourceType, recordId: d.profileUrl ?? `${sourceType}:${normalizeNameKey(name)}`, url: d.profileUrl, title: d.title, department: d.department, seenAt: new Date() });
    const outcome = await decideAndStore(d, institution, { includeInferred: false, orcidPerson: getOrcidPerson });
    summary[outcome] += 1;
  }
  return summary;
}

/** A person already on the roster who now turns out to be a student or out of domain. */
async function markExcludedIfKnown(d: Draft, institutionId: string, reason: string): Promise<void> {
  const existing = await repositories.faculty.findSamePerson({
    orcid: d.orcid,
    openAlexAuthorId: d.openAlexAuthorId,
    normalizedNameKey: normalizeNameKey(d.name),
    institutionOpenAlexId: institutionId,
    email: d.email,
  });
  if (!existing || existing.status === 'excluded') return;
  if (existing.status === 'promoted') {
    // Already in the CRM — flag rather than silently downgrade.
    if (!existing.tags.includes('review-role')) {
      await repositories.faculty.updateById(existing.id, { tags: [...existing.tags, 'review-role'], exclusionReason: reason });
    }
    return;
  }
  await repositories.faculty.updateById(existing.id, { status: 'excluded', exclusionReason: reason });
}

async function upsertMember(
  d: Draft,
  institution: { openAlexId: string; name: string },
  role: RoleDecision,
  domain: DomainDecision,
  basis: string | undefined,
): Promise<'created' | 'updated'> {
  const now = new Date();
  const nameKey = normalizeNameKey(d.name);
  const existing = await repositories.faculty.findSamePerson({
    orcid: d.orcid,
    openAlexAuthorId: d.openAlexAuthorId,
    normalizedNameKey: nameKey,
    institutionOpenAlexId: institution.openAlexId,
    email: d.email,
  });

  const affiliation: LeadAffiliation | undefined = d.orcidCurrentHere
    ? {
        status: 'current',
        verifiedAt: now,
        source: 'orcid',
        evidence: [
          {
            source: 'orcid',
            institution: institution.name,
            current: true,
            url: d.orcid ? `https://orcid.org/${d.orcid}` : undefined,
            detail: `ORCID employment${d.orcidCurrentHere.role ? ` as ${d.orcidCurrentHere.role}` : ''}${d.orcidCurrentHere.startYear ? ` since ${d.orcidCurrentHere.startYear}` : ''}, no end date`,
          },
        ],
      }
    : undefined;

  const topics = d.topics.map((t) => t.name);
  const evidenceText = [
    topics.length ? `Research topics: ${topics.join(', ')}.` : '',
    d.keywords.length ? `Keywords: ${d.keywords.join(', ')}.` : '',
    d.bio ?? '',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 2000);

  if (!existing) {
    const toCreate: FacultyMemberCreateInput = {
      status: 'eligible',
      person: {
        name: d.name,
        normalizedNameKey: nameKey,
        email: d.email,
        title: d.title,
        phone: d.phone,
        websiteUrl: d.websiteUrl,
        profileUrl: d.profileUrl,
        orcid: d.orcid,
        openAlexAuthorId: d.openAlexAuthorId,
      },
      role: { category: role.category, rawTitle: d.title ?? role.matched, basis },
      department: { name: d.department, domain: domain.domain, gateTerms: domain.gateTerms },
      institution: {
        name: institution.name,
        normalizedNameKey: normalizeInstitutionKey(institution.name),
        openAlexId: institution.openAlexId,
        discoveredName: institution.name,
        discoveredOpenAlexId: institution.openAlexId,
        department: d.department,
        country: 'IN',
        affiliation,
      },
      sources: d.sources,
      research: {
        topics,
        worksCount: d.stats.worksCount,
        hIndex: d.stats.hIndex,
        firstPublicationYear: d.stats.firstPublicationYear,
        lastPublicationYear: d.stats.lastPublicationYear,
        recentPublications: [],
        evidenceText,
        instruments: [],
      },
      relevance: {},
      tags: role.category === 'inferred' ? ['role-inferred'] : [],
    };
    await repositories.faculty.create(toCreate);
    return 'created';
  }

  // Merge: fill blanks, union sources, take the stronger role, never touch a
  // promoted member's status.
  const mergedRole = strongerRole({ category: existing.role.category }, role);
  const sources = [...existing.sources];
  for (const s of d.sources) if (!sources.some((x) => x.type === s.type && x.recordId === s.recordId)) sources.push(s);
  const mergedDomain: FacultyDomain = existing.department.domain === 'other' ? domain.domain : existing.department.domain;
  const tags = new Set(existing.tags);
  if (mergedRole.category === 'inferred') tags.add('role-inferred');
  else tags.delete('role-inferred');

  await repositories.faculty.updateById(existing.id, {
    ...(existing.status === 'excluded' ? { status: 'eligible' as const } : {}),
    person: {
      ...(existing.person.email ? {} : { email: d.email }),
      ...(existing.person.title ? {} : { title: d.title }),
      ...(existing.person.phone ? {} : { phone: d.phone }),
      ...(existing.person.websiteUrl ? {} : { websiteUrl: d.websiteUrl }),
      ...(existing.person.profileUrl ? {} : { profileUrl: d.profileUrl }),
      ...(existing.person.orcid ? {} : { orcid: d.orcid }),
      ...(existing.person.openAlexAuthorId ? {} : { openAlexAuthorId: d.openAlexAuthorId }),
    },
    role: {
      category: mergedRole.category,
      ...(existing.role.rawTitle ? {} : { rawTitle: d.title ?? role.matched }),
      ...(basis ? { basis } : {}),
    },
    department: {
      ...(existing.department.name ? {} : { name: d.department }),
      domain: mergedDomain,
      ...(domain.gateTerms ? { gateTerms: domain.gateTerms } : {}),
    },
    institution: {
      ...(existing.institution.department ? {} : { department: d.department }),
      ...(affiliation && existing.institution.affiliation?.status !== 'current' ? { affiliation } : {}),
    },
    sources,
    research: {
      topics: [...new Set([...existing.research.topics, ...topics])].slice(0, 20),
      ...(d.stats.worksCount ? { worksCount: Math.max(existing.research.worksCount ?? 0, d.stats.worksCount) } : {}),
      ...(d.stats.hIndex ? { hIndex: Math.max(existing.research.hIndex ?? 0, d.stats.hIndex) } : {}),
      ...(d.stats.firstPublicationYear ? { firstPublicationYear: d.stats.firstPublicationYear } : {}),
      ...(d.stats.lastPublicationYear ? { lastPublicationYear: d.stats.lastPublicationYear } : {}),
      ...(existing.research.evidenceText ? {} : { evidenceText }),
    },
    tags: [...tags],
  }, { unset: existing.status === 'excluded' ? ['exclusionReason'] : [] });
  return 'updated';
}
