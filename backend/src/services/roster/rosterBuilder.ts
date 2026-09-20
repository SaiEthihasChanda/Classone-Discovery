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
import { randomUUID } from 'node:crypto';
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
import { getSettings, updateSettings } from '../settings/settingsService.js';
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

/**
 * Listings the finder returns that are not current faculty: office staff,
 * retired/former/visiting/adjunct faculty, students. A visiting-faculty page
 * has "faculty" in its URL, which is why the URL is judged before the
 * "listed on a faculty page" rule can call anyone on it a professor.
 */
const NON_FACULTY_PAGE = /(visiting|adjunct|retired|former|emerit|alumni|student|scholar|phd|postdoc|off-staff|staff-directory|technical-staff|non-teaching|office|\/staff\/?$)/i;

/** Headings and labels the page parser sometimes returns as a person's name. */
const NOT_A_NAME = /\b(professor|emerit|faculty|staff|department|chemistry|physics|engineering|science|sciences|biology|centre|center|laboratory|school|read more|view profile)\b/i;

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
  stats: { worksCount?: number; hIndex?: number; firstPublicationYear?: number; lastPublicationYear?: number; yearsAtInstitute?: number[] };
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
            yearsAtInstitute: a.yearsHere,
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
        ctx.log(`ORCID search failed: ${error instanceof Error ? error.message : String(error)}`, 'warn');
      }

      // Employment lookups for the search hits, plus for OpenAlex authors
      // whose ORCID the search did not return (it indexes what the user typed).
      const toCheck = new Map<string, { name: string; emails: string[] }>();
      for (const h of hits) toCheck.set(h.orcid, { name: h.name, emails: h.emails });
      for (const d of drafts) if (d.orcid && !toCheck.has(d.orcid)) toCheck.set(d.orcid, { name: d.name, emails: [] });

      // Lookups are latency-bound (~300 ms each), so several run at once;
      // the client's rate limiter still caps the overall request rate. The
      // drafts are mutated in order below, one at a time, after each fetch.
      const entries = [...toCheck.entries()];
      let done = 0;
      let next = 0;
      const results = new Array<{ orcid: string; hit: { name: string; emails: string[] }; here: OrcidEmployment } | null>(entries.length).fill(null);
      const worker = async () => {
        while (next < entries.length) {
          if (ctx.cancelled()) return;
          const i = next;
          next += 1;
          const [orcid, hit] = entries[i]!;
          let record: Awaited<ReturnType<typeof getOrcidEmployments>> = null;
          try {
            record = await fetchers.orcidEmployments(orcid);
          } catch {
            record = null;
          }
          done += 1;
          ctx.count('orcidLookups');
          if (done % 25 === 0) {
            ctx.setStage(`${institution.name}: ORCID employments ${done}/${entries.length}`, base + span * (0.3 + 0.4 * (done / entries.length)));
          }
          if (!record) continue;
          const here = currentEmploymentHere(record.employments, instituteMatch);
          if (here) results[i] = { orcid, hit, here };
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
      ctx.checkpoint();

      for (const found of results) {
        if (!found) continue;
        const { orcid, hit, here } = found;
        r.orcidCurrentHere += 1;

        let d = byOrcid.get(orcid) ?? index_.find(hit.name);
        if (d && d.orcid && d.orcid !== orcid) d = undefined; // a namesake with a different ORCID
        if (!d) d = register(newDraft(hit.name));
        if (!d.orcid) attachOrcid(d, orcid);
        d.orcidCurrentHere = here;
        d.roles.push({ ...classifyRole(here.role), source: 'orcid' });
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
      const targets = new Map<string, { url: string; department?: string; label?: string }>();

      // Pages already configured in Settings for this institute.
      const k = normalizeInstitutionKey(institution.name);
      for (const t of settings.facultyTargets) {
        if (!t.enabled) continue;
        const tk = normalizeInstitutionKey(t.universityName);
        if (tk && k && (tk === k || tk.includes(k) || k.includes(tk))) {
          targets.set(t.url, { url: t.url, department: t.department, label: /\(([^)]+)\)\s*$/.exec(t.note ?? '')?.[1] });
        }
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
              ctx.log(`Faculty pages: ${res.error}${res.detail ? ` (${res.detail})` : ''}`, 'warn');
              continue;
            }
            for (const p of res.pages) {
              if (NON_FACULTY_PAGE.test(new URL(p.url).pathname)) {
                ctx.log(`Skipping non-faculty listing ${p.url}`);
                continue;
              }
              const dept = DEPARTMENT_HINTS.find((h) => h.hint === p.department)?.department;
              if (!targets.has(p.url)) targets.set(p.url, { url: p.url, department: dept, label: p.label ?? undefined });
            }
          }
        } catch (error) {
          r.errors.push(`faculty pages: ${error instanceof Error ? error.message : String(error)}`);
          ctx.log(`Faculty page discovery failed: ${error instanceof Error ? error.message : String(error)}`, 'warn');
        }
      } else {
        r.errors.push('faculty pages: no homepage known for the institute');
        ctx.log('Faculty pages: no homepage known for the institute', 'warn');
      }
      // Remember what discovery found, as ordinary faculty targets in
      // Settings: the next build reuses them even if the site is slow that
      // day, and they show up on the Settings page like hand-added ones.
      const known = new Set(settings.facultyTargets.map((t) => t.url));
      const discovered = [...targets.values()].filter((t) => !known.has(t.url));
      if (discovered.length > 0) {
        try {
          const latest = await getSettings();
          await updateSettings({
            facultyTargets: [
              ...latest.facultyTargets,
              ...discovered
                .filter((t) => !latest.facultyTargets.some((x) => x.url === t.url))
                .map((t) => ({
                  targetId: randomUUID(),
                  universityName: institution.name,
                  department: t.department,
                  url: t.url,
                  enabled: true,
                  note: `auto-discovered ${new Date().toISOString().slice(0, 10)}${t.label ? ` (${t.label})` : ''}`,
                })),
            ],
          });
          ctx.log(`Saved ${discovered.length} discovered listing${discovered.length === 1 ? '' : 's'} to Settings → faculty targets`);
        } catch (error) {
          ctx.log(`Could not save discovered listings: ${error instanceof Error ? error.message : String(error)}`, 'warn');
        }
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
          for (const e of response.errors) {
            r.errors.push(`${e.target}: ${e.reason}${e.detail ? ` (${e.detail})` : ''}`);
            ctx.log(`${e.target}: ${e.reason}${e.detail ? ` (${e.detail})` : ''}`, 'warn');
          }
          for (const page of response.results) {
            const target = targets.get(page.source_url);
            // "Listed on a faculty page" needs the page to say so — in its
            // URL or in the link text that led to it ("/people" labelled
            // "Faculty") — and to be none of the non-faculty listings.
            const isFacultyUrl =
              /faculty|professor/i.test(`${page.source_url} ${target?.label ?? ''}`) &&
              !NON_FACULTY_PAGE.test(`${new URL(page.source_url).pathname} ${target?.label ?? ''}`);
            for (const person of page.extracted) {
              if (NOT_A_NAME.test(person.name)) continue;
              r.pagePeople += 1;
              let d = index_.find(person.name);
              if (!d) d = register(newDraft(person.name));
              const role: RoleDecision = person.title
                ? { ...classifyRole(person.title), source: 'faculty_page' }
                : isFacultyUrl
                  ? { category: 'professor', matched: 'listed on a faculty page', source: 'faculty_page' }
                  : { category: 'unknown', source: 'faculty_page' };
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
          ctx.log(`Faculty scrape failed: ${error instanceof Error ? error.message : String(error)}`, 'warn');
        }
      }
    }

    // --- 4. Decide and store ------------------------------------------------
    ctx.setStage(`${institution.name}: deciding ${drafts.length} people`, base + span * 0.9);
    let personErrors = 0;
    for (const d of drafts) {
      ctx.checkpoint();
      // A name in a script the key cannot represent (or no letters at all)
      // cannot be matched or stored; it is counted, not fatal.
      if (!normalizeNameKey(d.name)) {
        r.droppedUnconfirmed += 1;
        continue;
      }
      try {
        const outcome = await decideAndStore(d, institution, { includeInferred, orcidPerson: fetchers.orcidPerson });
        r[outcome] += 1;
      } catch (error) {
        personErrors += 1;
        if (personErrors <= 5) ctx.log(`${d.name}: ${error instanceof Error ? error.message : String(error)}`, 'warn');
      }
    }
    if (personErrors > 0) r.errors.push(`${personErrors} people could not be stored (see log)`);

    ctx.count('created', r.created);
    ctx.count('updated', r.updated);
    ctx.count('excludedRole', r.excludedRole);
    ctx.count('excludedDomain', r.excludedDomain);
    ctx.count('droppedUnconfirmed', r.droppedUnconfirmed);
    ctx.log(
      `${institution.name}: ${r.created} added, ${r.updated} updated; dropped ${r.excludedRole} by role, ${r.excludedDomain} by department, ${r.droppedUnconfirmed} unconfirmed`,
    );
    if (r.errors.length > 0) ctx.log(`${institution.name}: ${r.errors.length} problem${r.errors.length === 1 ? '' : 's'} noted above`, 'warn');
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
    const inferred = inferSeniority({ ...d.stats, name: d.name });
    basis = inferred.basis;
    if (inferred.senior && opts.includeInferred) role = { category: 'inferred', matched: 'publication record' };
  } else if (
    role.category === 'excluded' &&
    role.source === 'orcid' &&
    /student|scholar|ph\.?\s?d|doctoral|m\.?\s?tech|m\.?\s?sc|candidate|graduate/i.test(role.matched ?? '')
  ) {
    // An ORCID employment still reading "PhD student" on someone with a
    // twelve-year, h ≥ 8 publication record is an entry nobody closed, not a
    // student. Kept as inferred, with the reason on the record.
    const inferred = inferSeniority({ ...d.stats, name: d.name });
    const year = new Date().getFullYear();
    if (inferred.senior && opts.includeInferred && d.stats.firstPublicationYear && year - d.stats.firstPublicationYear >= 12) {
      basis = `${inferred.basis}; ORCID title "${d.title ?? role.matched}" looks stale and was ignored`;
      role = { category: 'inferred', matched: 'publication record (stale ORCID title)' };
    }
  }

  if (role.category === 'excluded') {
    await markExcludedIfKnown(d, institution.openAlexId, `role: ${d.title ?? role.matched}`, 'role');
    return 'excludedRole';
  }
  if (!isFacultyRole(role.category)) return 'droppedUnconfirmed';

  // Domain: department name first, topics second; corrosion gate for
  // civil/mechanical reads keywords, bio and topic names — and, when
  // those are thin and there is an ORCID, its keywords (free).
  let text = [...d.keywords, d.bio ?? '', ...d.topics.map((t) => t.name)].join(' ');
  let domain: DomainDecision = decideDomain({ department: d.department, topics: d.topics, text });
  // The gated paths (civil/mechanical corrosion, out-of-list electrochemistry)
  // read the person's own keywords; fetch ORCID's when the text is thin.
  if (!domain.kept && d.orcid && (domain.domain === 'civil' || domain.domain === 'mechanical' || domain.domain === 'other')) {
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
    await markExcludedIfKnown(d, institution.openAlexId, domain.reason ?? `domain: ${DOMAIN_LABELS[domain.domain]}`, 'domain', Boolean(d.department));
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
  phone?: string;
  websiteUrl?: string;
  /** Free text about the person (a profile's visible text) — read by the department gates. */
  profileText?: string;
  /** The source's own id for the record (a Vidwan id), for a stable source reference. */
  sourceId?: string;
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
    d.phone = row.phone?.trim() || undefined;
    d.websiteUrl = /^https?:\/\//i.test(row.websiteUrl?.trim() ?? '') ? row.websiteUrl!.trim() : undefined;
    if (row.keywords) d.keywords.push(...row.keywords.split(/[;,]/).map((k) => k.trim()).filter(Boolean));
    // A profile's full text is the best evidence the corrosion and
    // electrochemistry gates get for an imported person; kept as the bio.
    if (row.profileText?.trim()) d.bio = row.profileText.trim().slice(0, 4000);
    // A named list of faculty is itself evidence of rank when no title is given.
    d.roles.push(d.title ? { ...classifyRole(d.title), source: 'import' } : { category: 'professor', matched: `listed in ${sourceType.replace('_', ' ')}`, source: 'import' });
    addSource(d, {
      type: sourceType,
      recordId: row.sourceId?.trim() || d.profileUrl || `${sourceType}:${normalizeNameKey(name)}`,
      url: d.profileUrl,
      title: d.title,
      department: d.department,
      seenAt: new Date(),
    });
    const outcome = await decideAndStore(d, institution, { includeInferred: false, orcidPerson: getOrcidPerson });
    summary[outcome] += 1;
  }
  return summary;
}

/**
 * A person already on the roster who now turns out to be a student or out of
 * domain — but only when this draft knows at least as much as the stored
 * member. The same professor can arrive twice in one build (a split OpenAlex
 * profile, a namesake match), and the second, thinner draft must not undo
 * the first: a department-less draft says nothing about someone whose
 * department is on record, and a title-less draft cannot outrank a title
 * read off the institute's own page.
 */
async function markExcludedIfKnown(
  d: Draft,
  institutionId: string,
  reason: string,
  kind: 'role' | 'domain',
  draftHasDepartment = false,
): Promise<void> {
  const existing = await repositories.faculty.findSamePerson({
    orcid: d.orcid,
    openAlexAuthorId: d.openAlexAuthorId,
    normalizedNameKey: normalizeNameKey(d.name),
    institutionOpenAlexId: institutionId,
    email: d.email,
  });
  if (!existing || existing.status === 'excluded') return;
  if (kind === 'domain' && existing.department.name && !draftHasDepartment) return;
  if (kind === 'role' && existing.sources.some((s) => s.type === 'faculty_page' && s.title)) return;
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
      tags: [
        ...(role.category === 'inferred' ? ['role-inferred'] : []),
        ...(domain.gate === 'electrochemistry' ? ['electrochem-gate'] : []),
      ],
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
  if (domain.gate === 'electrochemistry') tags.add('electrochem-gate');

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
