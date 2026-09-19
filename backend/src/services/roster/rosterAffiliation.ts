/**
 * Step 3 — is each roster member still at the institute they were found at?
 *
 * The same precedence rule as the CRM's check (`affiliationService`): ORCID's
 * open employment beats OpenAlex's latest paper. The reference point is the
 * DISCOVERED institute, never wherever a previous check moved them to. A
 * mover to somewhere outside the IIT/NIT/IIIT list is kept and tagged
 * `outside-target`; one nobody can place has the institute blanked.
 *
 * Members already in the CRM are verified through the lead, so both records
 * agree.
 */
import { INDIAN_INSTITUTIONS } from '../../data/indianInstitutions.js';
import { getAuthorAffiliations } from '../../integrations/openAlexClient.js';
import { getOrcidEmployments } from '../../integrations/orcidClient.js';
import { repositories, where, type Filter } from '../../repositories/index.js';
import type { FacultyMember, Lead } from '../../types/domain.js';
import type { JobContext } from '../jobs/jobRunner.js';
import {
  affiliationPatch,
  combineAffiliationEvidence,
  knownInstitutionId,
  verifyLeadAffiliation,
} from '../leads/affiliationService.js';

export interface RosterVerifyOptions {
  ids?: string[];
  /** Skip members verified within this many days. Default 30; 0 = re-check all. */
  freshDays?: number;
  limit?: number;
}

export interface RosterVerifyDeps {
  fetchAffiliations?: typeof getAuthorAffiliations;
  fetchOrcid?: typeof getOrcidEmployments;
}

export interface RosterVerifySummary {
  checked: number;
  current: number;
  moved: number;
  outsideTarget: number;
  unknown: number;
  unverified: number;
  skipped: number;
}

const TARGET_IDS = new Set(INDIAN_INSTITUTIONS.map((i) => i.openAlexId));

function isTarget(inst: { name?: string; openAlexId?: string }): boolean {
  if (inst.openAlexId && TARGET_IDS.has(inst.openAlexId)) return true;
  const known = knownInstitutionId(inst.name);
  return Boolean(known && TARGET_IDS.has(known));
}

/** Verifies one member; returns the resulting status. */
export async function verifyMember(
  member: FacultyMember,
  deps: RosterVerifyDeps = {},
): Promise<{ member: FacultyMember; status: string }> {
  const fetchAffiliations = deps.fetchAffiliations ?? getAuthorAffiliations;
  const fetchOrcid = deps.fetchOrcid ?? getOrcidEmployments;

  // In the CRM already: verify the lead, mirror the result.
  if (member.leadId) {
    const lead = await repositories.leads.findById(member.leadId);
    if (lead) {
      const { lead: verified } = await verifyLeadAffiliation(lead.id, { fetchAffiliations, fetchOrcid });
      const outside = verified.institution.affiliation?.status === 'moved' && !isTarget(verified.institution);
      const tags = new Set(member.tags);
      if (outside) tags.add('outside-target');
      else tags.delete('outside-target');
      const updated = await repositories.faculty.updateById(member.id, {
        institution: {
          name: verified.institution.name,
          normalizedNameKey: verified.institution.normalizedNameKey,
          openAlexId: verified.institution.openAlexId,
          country: verified.institution.country,
          affiliation: verified.institution.affiliation,
          outsideTarget: outside,
        },
        tags: [...tags],
      }, { unset: verified.institution.name ? [] : ['institution.name', 'institution.normalizedNameKey', 'institution.openAlexId'] });
      return { member: updated ?? member, status: verified.institution.affiliation?.status ?? 'unverified' };
    }
  }

  const [openalex, orcid] = await Promise.all([
    member.person.openAlexAuthorId ? fetchAffiliations(member.person.openAlexAuthorId).catch(() => null) : Promise.resolve(null),
    member.person.orcid ? fetchOrcid(member.person.orcid).catch(() => null) : Promise.resolve(null),
  ]);

  const reference = {
    institutionName: member.institution.discoveredName ?? member.institution.name,
    institutionOpenAlexId: member.institution.discoveredOpenAlexId ?? member.institution.openAlexId,
  };
  const assessment = combineAffiliationEvidence(reference, { openalex, orcid });
  const { set, unset } = affiliationPatch({ institution: member.institution } as Lead, assessment);
  const outside = assessment.status === 'moved' && !isTarget(assessment.institution);
  const tags = new Set(member.tags);
  if (outside) tags.add('outside-target');
  else tags.delete('outside-target');

  const updated = await repositories.faculty.updateById(
    member.id,
    {
      institution: { ...(set.institution as Record<string, unknown>), outsideTarget: outside },
      tags: [...tags],
    } as Partial<FacultyMember>,
    { unset },
  );
  return { member: updated ?? member, status: assessment.status };
}

export async function verifyRoster(
  options: RosterVerifyOptions,
  ctx: JobContext,
  deps: RosterVerifyDeps = {},
): Promise<RosterVerifySummary> {
  const freshDays = options.freshDays ?? 30;
  const filter: Filter = [where.in('status', ['eligible', 'promoted'])];
  if (options.ids?.length) filter.push(where.in('_id', options.ids));
  const members = await repositories.faculty.find({ filter, options: { limit: options.limit ?? 100_000, sort: { createdAt: 1 } } });

  const summary: RosterVerifySummary = { checked: 0, current: 0, moved: 0, outsideTarget: 0, unknown: 0, unverified: 0, skipped: 0 };
  const cutoff = Date.now() - freshDays * 24 * 3600 * 1000;

  for (const [i, member] of members.entries()) {
    ctx.checkpoint();
    if (i % 20 === 0) ctx.setStage(`verifying ${i + 1}/${members.length}`, i / Math.max(1, members.length));
    const verifiedAt = member.institution.affiliation?.verifiedAt;
    if (
      freshDays > 0 &&
      verifiedAt &&
      new Date(verifiedAt).getTime() > cutoff &&
      member.institution.affiliation?.status !== 'unverified'
    ) {
      summary.skipped += 1;
      continue;
    }
    if (!member.person.openAlexAuthorId && !member.person.orcid) {
      summary.skipped += 1;
      continue;
    }
    try {
      const { member: after, status } = await verifyMember(member, deps);
      summary.checked += 1;
      if (status === 'current') summary.current += 1;
      else if (status === 'moved') {
        summary.moved += 1;
        if (after.institution.outsideTarget) summary.outsideTarget += 1;
        ctx.log(`${member.person.name}: moved ${member.institution.discoveredName} → ${after.institution.name ?? '?'}${after.institution.outsideTarget ? ' (outside target list)' : ''}`);
      } else if (status === 'unknown') {
        summary.unknown += 1;
        ctx.log(`${member.person.name}: no current institute could be established — blanked`, 'warn');
      } else summary.unverified += 1;
    } catch (error) {
      ctx.log(`${member.person.name}: ${error instanceof Error ? error.message : String(error)}`, 'warn');
    }
    ctx.set('checked', summary.checked);
    ctx.set('moved', summary.moved);
    ctx.set('unknown', summary.unknown);
  }
  return summary;
}
