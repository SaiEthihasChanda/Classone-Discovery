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
}

/** Verifies one lead and writes the result. Returns null when there is nothing to check against. */
export async function verifyLeadAffiliation(
  leadId: string,
  deps: VerifyDeps = {},
): Promise<{ lead: Lead; assessment: AffiliationAssessment | null }> {
  const fetchAffiliations = deps.fetchAffiliations ?? getAuthorAffiliations;
  const lead = await repositories.leads.findById(leadId);
  if (!lead) throw ApiError.notFound('Lead');

  const authorId = openAlexAuthorIdOf(lead);
  if (!authorId) {
    throw ApiError.badRequest(
      'This lead has no OpenAlex author record to check against. Leads found by discovery carry one.',
    );
  }

  const record = await fetchAffiliations(authorId);
  if (!record) return { lead, assessment: null };

  // Check the institute the lead currently shows. When that is blank (an
  // earlier check could not place them), fall back to the last one known, so a
  // researcher who resurfaces there is picked up again.
  const reference = lead.institution.name
    ? { name: lead.institution.name, id: lead.institution.openAlexId ?? knownInstitutionId(lead.institution.name) }
    : {
        name: lead.institution.affiliation?.previousInstitution,
        id: lead.institution.affiliation?.previousInstitutionOpenAlexId,
      };
  const assessment = assessAffiliation(
    { institutionName: reference.name, institutionOpenAlexId: reference.id },
    record,
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
  params: { ids?: string[]; status?: Lead['status']; brands?: string[]; limit?: number },
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
    if (!openAlexAuthorIdOf(lead)) {
      out.skipped += 1;
      continue;
    }
    try {
      const { assessment } = await verifyLeadAffiliation(lead.id, deps);
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
