/**
 * Is this researcher still at the institute we found them at?
 *
 * Discovery attributes a person to an institute because a paper said so — and
 * a paper published in 2025 says nothing about January 2026. Showing someone
 * as "IIT Bombay" after they have moved is worse than showing nothing: a
 * salesperson plans a visit, or emails an address that no longer exists.
 *
 * The check uses OpenAlex's author record, which carries the institutions the
 * author's most recent works name (`last_known_institutions`) and, per
 * institution, the years they published from it. A single-record lookup, so
 * it costs no credits and can run on every new lead in a discovery run.
 *
 * The rule, in words:
 *   - the institute is among the author's last-known institutions → CURRENT
 *   - a different institute is last-known, and it is at least as recent as
 *     anything from ours → MOVED; show the new institute (OpenAlex knows it)
 *   - nothing recent anywhere → UNKNOWN; show no institute rather than a stale one
 *
 * Honest limits: OpenAlex learns about a move from the next paper, so someone
 * who moved last month and has not published since will still read as
 * current. The web-enrichment pass adds a second, real-time signal — whether
 * the institute's own directory still lists them — and records it here too.
 */
import { INDIAN_INSTITUTIONS } from '../../data/indianInstitutions.js';
import { getAuthorAffiliations, type AuthorAffiliations } from '../../integrations/openAlexClient.js';
import { getOrcidEmployments, type OrcidRecord } from '../../integrations/orcidClient.js';
import {
  checkAffiliationViaScraper,
  isScraperAvailable,
  type AffiliationResponse,
} from '../../integrations/scraperServiceClient.js';
import { getSettings, type AppSettings } from '../settings/settingsService.js';
import type { AffiliationEvidence } from '../../types/domain.js';
import { repositories, where, type Filter } from '../../repositories/index.js';
import { ApiError } from '../../middleware/errorHandler.js';
import type { Lead, LeadAffiliation } from '../../types/domain.js';
import { expandInstitutionAbbreviations, normalizeInstitutionKey } from '../../utils/normalize.js';

import { logActivity } from '../activity/activityService.js';

/** Comparison key with short forms expanded first. */
const instKey = (name?: string) =>
  name ? normalizeInstitutionKey(expandInstitutionAbbreviations(name)) : undefined;

/** How long a verification stays fresh before a run re-checks a known lead. */
export const AFFILIATION_TTL_DAYS = 30;

export interface AffiliationAssessment {
  status: LeadAffiliation['status'];
  /** What the institution fields should now say. `undefined` name = blank. */
  institution: { name?: string; openAlexId?: string; country?: string };
  affiliation: LeadAffiliation;
}

/** True if the OpenAlex institution is the one on the lead, by id or by name. */
function sameInstitution(
  lead: { name?: string; openAlexId?: string },
  inst: { id?: string; name?: string },
): boolean {
  if (lead.openAlexId && inst.id) return lead.openAlexId === inst.id;
  const a = instKey(lead.name);
  const b = instKey(inst.name);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** The OpenAlex id for an institute name we already know (our IIT/NIT/IIIT list). */
export function knownInstitutionId(name?: string): string | undefined {
  const key = instKey(name);
  if (!key) return undefined;
  return INDIAN_INSTITUTIONS.find((i) => normalizeInstitutionKey(i.name) === key)?.openAlexId;
}

/**
 * Pure decision: given what the lead says and what OpenAlex says, what should
 * the lead say now? Kept free of I/O so it can be tested exhaustively.
 */
export function assessAffiliation(
  lead: { institutionName?: string; institutionOpenAlexId?: string },
  record: AuthorAffiliations,
  now: Date = new Date(),
): AffiliationAssessment {
  const year = now.getFullYear();
  const leadInst = { name: lead.institutionName, openAlexId: lead.institutionOpenAlexId };

  const ours = record.affiliations.find((a) => sameInstitution(leadInst, a));
  const lastYearHere = ours ? Math.max(...ours.years, 0) : 0;
  const lastKnownHere = record.lastKnown.some((i) => sameInstitution(leadInst, i));

  const base = { verifiedAt: now, source: 'openalex' as const, lastSeenYear: lastYearHere || undefined };

  // 1. Still named on their latest work — current.
  if (lastKnownHere) {
    return {
      status: 'current',
      institution: {
        name: lead.institutionName,
        openAlexId: lead.institutionOpenAlexId ?? record.lastKnown.find((i) => sameInstitution(leadInst, i))?.id,
      },
      affiliation: { ...base, status: 'current' },
    };
  }

  // 2. Their latest work names somewhere else.
  const elsewhere = record.lastKnown[0];
  if (elsewhere) {
    const newest = record.affiliations.find((a) => a.id === elsewhere.id);
    const lastYearThere = newest ? Math.max(...newest.years, 0) : year;
    // Concurrent appointments (a joint centre, an adjunct post) show as two
    // institutions with the same latest year; that is not a move.
    if (lastYearHere > 0 && lastYearHere >= lastYearThere) {
      return {
        status: 'current',
        institution: { name: lead.institutionName, openAlexId: lead.institutionOpenAlexId },
        affiliation: { ...base, status: 'current', note: `Also affiliated with ${elsewhere.name}` },
      };
    }
    return {
      status: 'moved',
      institution: { name: elsewhere.name, openAlexId: elsewhere.id, country: elsewhere.country },
      affiliation: {
        ...base,
        status: 'moved',
        previousInstitution: lead.institutionName,
        previousInstitutionOpenAlexId: lead.institutionOpenAlexId,
        note: `Latest work (${lastYearThere}) is from ${elsewhere.name}; last seen at ${lead.institutionName ?? 'the previous institute'} in ${lastYearHere || 'an earlier year'}.`,
      },
    };
  }

  // 3. No last-known institution at all. Recent output from ours is enough.
  if (lastYearHere >= year - 2) {
    return {
      status: 'current',
      institution: { name: lead.institutionName, openAlexId: lead.institutionOpenAlexId },
      affiliation: { ...base, status: 'current' },
    };
  }

  // 4. Nothing recent anywhere — we do not know where they are. Say so.
  return {
    status: 'unknown',
    institution: { name: undefined, openAlexId: undefined },
    affiliation: {
      ...base,
      status: 'unknown',
      previousInstitution: lead.institutionName,
      previousInstitutionOpenAlexId: lead.institutionOpenAlexId,
      note: lastYearHere
        ? `Last seen at ${lead.institutionName} in ${lastYearHere}; no current affiliation on record.`
        : 'No affiliation history on record.',
    },
  };
}

/** The author id a lead carries, if discovery gave it one. */
export function openAlexAuthorIdOf(lead: Lead): string | null {
  for (const v of [lead.person.profileUrl, lead.source.sourceRecordId]) {
    const m = v?.match(/A\d{6,}/);
    if (m) return m[0];
  }
  return null;
}

/**
 * The write that applies an assessment: fields to set, and fields to CLEAR.
 *
 * Clearing is explicit because the repository treats `undefined` as "leave
 * alone" — and a blank institution here is the whole point, not an accident.
 */
export function affiliationPatch(
  lead: Lead,
  a: AffiliationAssessment,
): { set: Partial<Lead>; unset: string[] } {
  const unset: string[] = [];
  const institution: Record<string, unknown> = { affiliation: a.affiliation };

  if (a.institution.name) {
    institution.name = a.institution.name;
    institution.normalizedNameKey = normalizeInstitutionKey(a.institution.name);
  } else {
    unset.push('institution.name', 'institution.normalizedNameKey');
  }
  if (a.institution.openAlexId) institution.openAlexId = a.institution.openAlexId;
  else unset.push('institution.openAlexId');
  if (a.institution.country) institution.country = a.institution.country;

  // A department belongs to the institute; it does not follow a move.
  if (a.status !== 'current') {
    unset.push('institution.department');
    if (a.status === 'unknown') unset.push('institution.country');
  }

  return { set: { institution } as Partial<Lead>, unset };
}

export interface VerifyDeps {
  fetchAffiliations?: typeof getAuthorAffiliations;
  fetchOrcid?: typeof getOrcidEmployments;
  /** Directory + registries via the scraper; only used when `deep` is requested. */
  fetchRegistries?: typeof checkAffiliationViaScraper;
  scraperUp?: typeof isScraperAvailable;
}

/**
 * Combines every source under one precedence rule.
 *
 * Order, most current first: the institute directory and IRINS (an institute
 * listing its own people today), Vidwan (self-maintained national profile),
 * ORCID (self-maintained employment with no end date), then OpenAlex (the
 * affiliation on the latest paper). The first source with a positive answer
 * decides; OpenAlex's own logic is the fallback when nothing else knows.
 *
 * Pure: takes what each source returned, returns the assessment plus the
 * evidence trail. Testable without any network.
 */
export function combineAffiliationEvidence(
  lead: { institutionName?: string; institutionOpenAlexId?: string },
  sources: {
    openalex?: AuthorAffiliations | null;
    orcid?: OrcidRecord | null;
    registry?: AffiliationResponse | null;
  },
  now: Date = new Date(),
): AffiliationAssessment {
  const leadInst = { name: lead.institutionName, openAlexId: lead.institutionOpenAlexId };
  const evidence: AffiliationEvidence[] = [];
  const decide = (
    status: LeadAffiliation['status'],
    source: string,
    institution: { name?: string; openAlexId?: string; country?: string },
    extra: Partial<LeadAffiliation> = {},
  ): AffiliationAssessment => ({
    status,
    institution,
    affiliation: { status, verifiedAt: now, source, evidence, ...extra },
  });

  // --- 1. Directory / IRINS: the institute lists them today ---------------
  const reg = sources.registry;
  if (reg?.directory_checked) {
    evidence.push({
      source: 'directory',
      institution: reg.directory_listed ? lead.institutionName : undefined,
      current: reg.directory_listed ?? undefined,
      url: reg.directory_url ?? undefined,
      detail: reg.directory_listed ? 'Listed in the institute faculty directory' : 'Not found in the institute faculty directory',
    });
  }
  for (const hit of reg?.hits ?? []) {
    if (hit.source === 'directory') continue;
    evidence.push({
      source: hit.source,
      institution: hit.institution ?? undefined,
      current: hit.institution ? true : undefined,
      url: hit.profile_url,
      detail: [hit.designation, hit.department].filter(Boolean).join(', ') || undefined,
    });
  }

  if (reg?.directory_listed) {
    return decide('current', 'directory', { name: lead.institutionName, openAlexId: lead.institutionOpenAlexId }, {
      directoryListed: true,
      note: 'Listed in the institute faculty directory.',
    });
  }

  const registryHits = (reg?.hits ?? []).filter((h) => h.source !== 'directory' && h.institution);
  // IRINS is institute-maintained; Vidwan self-maintained. Either naming an institute is a positive answer.
  const ordered = [...registryHits].sort((a, b) => Number(b.source === 'irins') - Number(a.source === 'irins'));
  const named = ordered[0];
  if (named?.institution) {
    const here = sameInstitution(leadInst, { name: named.institution });
    if (here) {
      return decide('current', named.source, { name: lead.institutionName, openAlexId: lead.institutionOpenAlexId }, {
        directoryListed: reg?.directory_checked ? Boolean(reg.directory_listed) : undefined,
        note: `${named.source === 'irins' ? 'IRINS' : 'Vidwan'} profile names ${named.institution}.`,
      });
    }
    return decide('moved', named.source, { name: named.institution, openAlexId: knownInstitutionId(named.institution) }, {
      previousInstitution: lead.institutionName,
      previousInstitutionOpenAlexId: lead.institutionOpenAlexId,
      directoryListed: reg?.directory_checked ? Boolean(reg.directory_listed) : undefined,
      note: `${named.source === 'irins' ? 'IRINS' : 'Vidwan'} profile names ${named.institution}; was ${lead.institutionName ?? 'the previous institute'}.`,
    });
  }

  // --- 2. ORCID: an employment the researcher has left open ---------------
  const current = (sources.orcid?.employments ?? []).filter((e) => e.current);
  for (const e of current) {
    evidence.push({
      source: 'orcid',
      institution: e.organization,
      current: true,
      detail: [e.role, e.department, e.startYear ? `since ${e.startYear}` : undefined].filter(Boolean).join(', ') || undefined,
    });
  }
  if (current.length > 0) {
    const here = current.find((e) => sameInstitution(leadInst, { name: e.organization }));
    if (here) {
      return decide('current', 'orcid', { name: lead.institutionName, openAlexId: lead.institutionOpenAlexId }, {
        directoryListed: reg?.directory_checked ? Boolean(reg.directory_listed) : undefined,
        note: `ORCID employment at ${here.organization}${here.startYear ? ` since ${here.startYear}` : ''} with no end date.`,
      });
    }
    // Every open employment is elsewhere. If OpenAlex still places them here
    // on a paper newer than the ORCID start year, ORCID is the stale one; else move.
    const newest = current[0]!;
    const oa = sources.openalex;
    const ours = oa?.affiliations.find((a) => sameInstitution(leadInst, a));
    const lastHere = ours ? Math.max(...ours.years, 0) : 0;
    const orcidSaysStaleHere = newest.startYear !== undefined && lastHere > newest.startYear;
    if (!orcidSaysStaleHere) {
      return decide('moved', 'orcid', { name: newest.organization, openAlexId: knownInstitutionId(newest.organization) }, {
        previousInstitution: lead.institutionName,
        previousInstitutionOpenAlexId: lead.institutionOpenAlexId,
        lastSeenYear: lastHere || undefined,
        directoryListed: reg?.directory_checked ? Boolean(reg.directory_listed) : undefined,
        note: `ORCID lists a current employment at ${newest.organization}${newest.startYear ? ` since ${newest.startYear}` : ''}; was ${lead.institutionName ?? 'the previous institute'}.`,
      });
    }
  }

  // --- 3. OpenAlex: the affiliation on the latest paper ---------------------
  if (sources.openalex) {
    const oa = assessAffiliation(lead, sources.openalex, now);
    for (const i of sources.openalex.lastKnown) {
      evidence.push({ source: 'openalex', institution: i.name, current: true, detail: 'Named on the latest indexed work' });
    }
    const directoryListed = reg?.directory_checked ? Boolean(reg.directory_listed) : undefined;
    return {
      ...oa,
      affiliation: {
        ...oa.affiliation,
        evidence,
        directoryListed,
        note: [oa.affiliation.note, directoryListed === false ? 'Not found in the institute faculty directory.' : undefined]
          .filter(Boolean)
          .join(' ') || undefined,
      },
    };
  }

  // --- 4. Nothing answered -------------------------------------------------
  return decide('unverified', 'openalex', { name: lead.institutionName, openAlexId: lead.institutionOpenAlexId }, {
    note: 'No source had an affiliation record for this person.',
  });
}

/** Faculty directory pages configured for the lead's institute. */
function directoryUrlsFor(institutionName: string | undefined, settings: AppSettings): string[] {
  const key = instKey(institutionName);
  if (!key) return [];
  return settings.facultyTargets
    .filter((t) => t.enabled)
    .filter((t) => {
      const tk = instKey(t.universityName);
      return Boolean(tk && (tk === key || tk.includes(key) || key.includes(tk)));
    })
    .map((t) => t.url);
}

/**
 * Verifies one lead and writes the result.
 *
 * Always consults OpenAlex and ORCID (free APIs). With `deep`, also asks the
 * scraper for the institute directory and the registries — the most current
 * sources, but page fetches, so reserved for on-demand checks rather than
 * every lead of a run. Returns a null assessment only when no source at all
 * could be consulted.
 */
export async function verifyLeadAffiliation(
  leadId: string,
  deps: VerifyDeps & { deep?: boolean } = {},
): Promise<{ lead: Lead; assessment: AffiliationAssessment | null }> {
  const fetchAffiliations = deps.fetchAffiliations ?? getAuthorAffiliations;
  const fetchOrcid = deps.fetchOrcid ?? getOrcidEmployments;
  const fetchRegistries = deps.fetchRegistries ?? checkAffiliationViaScraper;
  const scraperUp = deps.scraperUp ?? isScraperAvailable;

  const lead = await repositories.leads.findById(leadId);
  if (!lead) throw ApiError.notFound('Lead');

  const settings = await getSettings();
  const authorId = openAlexAuthorIdOf(lead);
  const orcid = lead.person.orcid;
  const referenceName = lead.institution.name ?? lead.institution.affiliation?.previousInstitution;

  if (!authorId && !orcid && !(deps.deep && referenceName)) {
    throw ApiError.badRequest(
      'Nothing to check this lead against: no OpenAlex author record, no ORCID, and no institute to look up.',
    );
  }

  const [openalex, orcidRecord] = await Promise.all([
    authorId ? fetchAffiliations(authorId) : Promise.resolve(null),
    orcid && settings.discovery.useOrcidForAffiliation ? fetchOrcid(orcid) : Promise.resolve(null),
  ]);

  let registry: AffiliationResponse | null = null;
  if (deps.deep && referenceName && (await scraperUp())) {
    try {
      registry = await fetchRegistries({
        name: lead.person.name,
        institutionName: referenceName,
        knownInstitutions: INDIAN_INSTITUTIONS.map((i) => i.name),
        directoryUrls: directoryUrlsFor(referenceName, settings),
        registries: settings.discovery.affiliationRegistries.filter((r) => r.enabled),
        allowBrowser: settings.scraping.allowBrowser,
      });
    } catch {
      registry = null; // The free sources still decide.
    }
  }

  if (!openalex && !orcidRecord && !registry) return { lead, assessment: null };

  // Check the institute the lead currently shows. When that is blank (an
  // earlier check could not place them), fall back to the last one known, so a
  // researcher who resurfaces there is picked up again.
  const reference = lead.institution.name
    ? { name: lead.institution.name, id: lead.institution.openAlexId ?? knownInstitutionId(lead.institution.name) }
    : {
        name: lead.institution.affiliation?.previousInstitution,
        id: lead.institution.affiliation?.previousInstitutionOpenAlexId,
      };
  const assessment = combineAffiliationEvidence(
    { institutionName: reference.name, institutionOpenAlexId: reference.id },
    { openalex, orcid: orcidRecord, registry },
  );

  const changed = assessment.institution.name !== lead.institution.name;
  const { set, unset } = affiliationPatch(lead, assessment);
  const updated = (await repositories.leads.updateById(lead.id, set, { unset })) ?? lead;

  if (changed) {
    await logActivity({
      type: 'lead_discovered',
      severity: 'warning',
      message:
        assessment.status === 'moved'
          ? `Affiliation changed — ${lead.person.name} has moved from ${lead.institution.name ?? '?'} to ${assessment.institution.name}`
          : `Affiliation unknown — ${lead.person.name} no longer shows a current institution (was ${lead.institution.name ?? '?'})`,
      relatedLeadId: lead.id,
      metadata: { affiliation: assessment.status },
    });
  }

  return { lead: updated, assessment };
}

export interface BulkVerifyResult {
  checked: number;
  current: number;
  moved: number;
  unknown: number;
  skipped: number;
}

/**
 * Verifies many leads, oldest check first. Free at OpenAlex, paced by the
 * shared rate limiter, so a few hundred take a couple of minutes.
 */
export async function verifyAffiliations(
  params: { ids?: string[]; status?: Lead['status']; brands?: string[]; limit?: number; deep?: boolean },
  deps: VerifyDeps = {},
): Promise<BulkVerifyResult> {
  const filter: Filter = [];
  if (params.ids && params.ids.length > 0) filter.push(where.in('_id', params.ids));
  if (params.status) filter.push(where.eq('status', params.status));
  if (params.brands && params.brands.length > 0) {
    filter.push(where.in('research.instruments.brandKey', params.brands));
  }

  const leads = await repositories.leads.find({
    filter,
    options: { limit: Math.min(params.limit ?? 500, 2000), sort: { 'institution.affiliation.verifiedAt': 1 } },
  });

  const out: BulkVerifyResult = { checked: 0, current: 0, moved: 0, unknown: 0, skipped: 0 };
  for (const lead of leads) {
    if (!openAlexAuthorIdOf(lead) && !lead.person.orcid && !params.deep) {
      out.skipped += 1;
      continue;
    }
    try {
      const { assessment } = await verifyLeadAffiliation(lead.id, { ...deps, deep: params.deep });
      if (!assessment) {
        out.skipped += 1;
        continue;
      }
      out.checked += 1;
      if (assessment.status === 'current') out.current += 1;
      else if (assessment.status === 'moved') out.moved += 1;
      else out.unknown += 1;
    } catch {
      out.skipped += 1;
    }
  }
  return out;
}

/** True if a lead's last check is missing or older than the TTL. */
export function affiliationIsStale(lead: Lead, now: Date = new Date()): boolean {
  const at = lead.institution.affiliation?.verifiedAt;
  if (!at) return true;
  return (now.getTime() - new Date(at).getTime()) / 86_400_000 > AFFILIATION_TTL_DAYS;
}
