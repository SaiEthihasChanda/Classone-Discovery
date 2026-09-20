/**
 * Step 4 — relevance, then promotion into the CRM.
 *
 * Scoring uses the same scorer discovery uses (`enrichCandidate`: the
 * rule-based provider by default, OpenAI when a key is set) over the same
 * kind of evidence: recent titles, abstracts and topics. The evidence comes
 * from ONE filter-only OpenAlex call per person (1 credit) — thousands of
 * people have to be scored, so the 10-credit full-text searches are reserved
 * for step two: identifying the instruments of those who clear the bar.
 *
 * Promotion creates a CRM lead from a member whose score clears the
 * threshold. Members below it stay on the roster, scored, for a later look.
 */
import { OpenAlexBudgetError } from '../../integrations/openAlexBudget.js';
import { getAuthorRecentWorks } from '../../integrations/openAlexClient.js';
import { getOrcidWorkTitles } from '../../integrations/orcidClient.js';
import { repositories, where, type Filter } from '../../repositories/index.js';
import type { FacultyMember, Lead, LeadCreateInput, Product } from '../../types/domain.js';
import { normalizeInstitutionKey, normalizeNameKey } from '../../utils/normalize.js';
import { BudgetTracker, enrichCandidate, getAiProvider } from '../ai/enrichmentService.js';
import type { AiProvider } from '../ai/types.js';
import { attachDetectedInstruments, mergeInstruments } from '../discovery/instrumentDetector.js';
import { scanLeadInstruments } from '../discovery/instrumentScan.js';
import type { DiscoveredCandidate } from '../discovery/types.js';
import type { JobContext } from '../jobs/jobRunner.js';
import { getSettings } from '../settings/settingsService.js';
import { logActivity } from '../activity/activityService.js';

export const DEFAULT_PROMOTE_THRESHOLD = 40;

export interface RosterScoreOptions {
  ids?: string[];
  /** Re-score members that already have a score. Default false. */
  rescore?: boolean;
  /** Years of output to read. Default 5. */
  sinceYears?: number;
  limit?: number;
}

export interface RosterScoreDeps {
  recentWorks?: typeof getAuthorRecentWorks;
  orcidWorks?: typeof getOrcidWorkTitles;
  provider?: AiProvider;
}

export interface RosterScoreSummary {
  scored: number;
  skipped: number;
  noEvidence: number;
  aboveThreshold: number;
  openAlexExhausted: boolean;
  estimatedCostUsd: number;
}

/** What one scoring pass would cost, for the confirmation dialog. */
export async function estimateScoreCost(options: { rescore?: boolean }): Promise<{ members: number; withOpenAlex: number; credits: number }> {
  const filter: Filter = [where.eq('status', 'eligible')];
  const members = await repositories.faculty.find({ filter });
  const todo = members.filter((m) => options.rescore || m.relevance.score === undefined);
  const withOpenAlex = todo.filter((m) => m.person.openAlexAuthorId).length;
  return { members: todo.length, withOpenAlex, credits: withOpenAlex };
}

function candidateFor(member: FacultyMember, evidence: { publications: FacultyMember['research']['recentPublications']; topics: string[]; evidenceText: string }): DiscoveredCandidate {
  return {
    sourceType: 'faculty_roster',
    sourceRecordId: member.person.openAlexAuthorId ?? member.person.orcid ?? member.id,
    sourceUrl: member.person.openAlexAuthorId ? `https://openalex.org/${member.person.openAlexAuthorId}` : undefined,
    name: member.person.name,
    email: member.person.email,
    title: member.person.title,
    orcid: member.person.orcid,
    profileUrl: member.person.profileUrl,
    institutionName: member.institution.name,
    institutionOpenAlexId: member.institution.openAlexId,
    department: member.department.name,
    country: member.institution.country,
    publications: evidence.publications,
    grants: [],
    topics: evidence.topics.length ? evidence.topics : member.research.topics,
    evidenceText: [evidence.evidenceText, member.research.evidenceText ?? ''].filter(Boolean).join(' ').slice(0, 4000),
    instruments: member.research.instruments,
  };
}

export async function scoreRoster(
  options: RosterScoreOptions,
  ctx: JobContext,
  deps: RosterScoreDeps = {},
): Promise<RosterScoreSummary> {
  const recentWorks = deps.recentWorks ?? getAuthorRecentWorks;
  const orcidWorks = deps.orcidWorks ?? getOrcidWorkTitles;
  const provider = deps.provider ?? getAiProvider();
  const settings = await getSettings();
  const brands = settings.discovery.instrumentBrands.filter((b) => b.enabled);
  const catalog: Product[] = await repositories.products.findActive();
  const budget = new BudgetTracker();
  const sinceYear = new Date().getFullYear() - (options.sinceYears ?? 5);

  const filter: Filter = [where.eq('status', 'eligible')];
  if (options.ids?.length) filter.push(where.in('_id', options.ids));
  const members = await repositories.faculty.find({ filter, options: { limit: options.limit ?? 100_000, sort: { createdAt: 1 } } });

  const summary: RosterScoreSummary = { scored: 0, skipped: 0, noEvidence: 0, aboveThreshold: 0, openAlexExhausted: false, estimatedCostUsd: 0 };
  ctx.log(`Scoring with ${provider.name}; ${members.length} eligible members`);

  for (const [i, member] of members.entries()) {
    ctx.checkpoint();
    if (i % 10 === 0) ctx.setStage(`scoring ${i + 1}/${members.length}`, i / Math.max(1, members.length));
    if (member.relevance.score !== undefined && !options.rescore) {
      summary.skipped += 1;
      continue;
    }

    let evidence = { publications: [] as FacultyMember['research']['recentPublications'], topics: [] as string[], evidenceText: '' };
    if (member.person.openAlexAuthorId && !summary.openAlexExhausted) {
      try {
        const works = await recentWorks({ authorId: member.person.openAlexAuthorId, sinceYear, maxWorks: 25 });
        evidence = works;
        ctx.count('openAlexCalls');
      } catch (error) {
        if (error instanceof OpenAlexBudgetError) {
          summary.openAlexExhausted = true;
          ctx.log('OpenAlex allowance exhausted — remaining members scored from ORCID titles or skipped', 'error');
        } else {
          ctx.log(`${member.person.name}: OpenAlex ${error instanceof Error ? error.message : String(error)}`, 'warn');
        }
      }
    }
    if (evidence.publications.length === 0 && member.person.orcid) {
      try {
        const titles = await orcidWorks(member.person.orcid, 25);
        evidence = {
          publications: titles.filter((t) => !t.year || t.year >= sinceYear).map((t) => ({ title: t.title, year: t.year, url: t.url })),
          topics: [],
          evidenceText: titles.length ? `Recent work: ${titles.map((t) => t.title).join('; ')}.` : '',
        };
      } catch {
        // Best effort.
      }
    }

    const candidate = candidateFor(member, evidence);
    if (!candidate.evidenceText && candidate.publications.length === 0 && candidate.topics.length === 0) {
      summary.noEvidence += 1;
      await repositories.faculty.updateById(member.id, {
        relevance: { score: 0, reasoning: 'No research output could be found to score against.', scoredAt: new Date(), scoringModel: provider.name },
      });
      continue;
    }
    // Free text detection: "on a CHI 660E" in an abstract tags them now.
    attachDetectedInstruments(candidate, brands);

    try {
      const result = await enrichCandidate(candidate, { catalog, budget, provider });
      summary.scored += 1;
      summary.estimatedCostUsd = budget.spentUsd;
      if (result.relevanceScore >= DEFAULT_PROMOTE_THRESHOLD) summary.aboveThreshold += 1;
      await repositories.faculty.updateById(member.id, {
        relevance: {
          score: result.relevanceScore,
          reasoning: result.relevanceReasoning,
          recommendedProductIds: result.recommendedProductIds,
          scoredAt: new Date(),
          scoringModel: result.model,
        },
        research: {
          topics: [...new Set([...(evidence.topics.length ? evidence.topics : result.topics), ...member.research.topics])].slice(0, 20),
          recentPublications: evidence.publications.slice(0, 10),
          evidenceText: candidate.evidenceText.slice(0, 3000),
          instruments: mergeInstruments(member.research.instruments, candidate.instruments),
        },
      });
      ctx.set('scored', summary.scored);
      ctx.set('aboveThreshold', summary.aboveThreshold);
    } catch (error) {
      ctx.log(`${member.person.name}: scoring failed — ${error instanceof Error ? error.message : String(error)}`, 'warn');
      if (error instanceof Error && /budget/i.test(error.message)) break;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

export interface RosterPromoteOptions {
  threshold?: number;
  ids?: string[];
  /** Run the per-lead instrument scan (10 credits per brand, more per model) on each promoted lead. */
  identifyInstruments?: boolean;
  /** Promote anyone with an instrument sighting whatever their score. Default true. */
  includeInstrumentOwners?: boolean;
  limit?: number;
}

export interface RosterPromoteSummary {
  promoted: number;
  /** Of the promoted, those admitted by an instrument sighting rather than the score. */
  byInstrument: number;
  alreadyInCrm: number;
  belowThreshold: number;
  scanned: number;
  instrumentsFound: number;
  openAlexExhausted: boolean;
}

/** What a promotion pass would do, for the confirmation dialog. */
export async function estimatePromotion(threshold: number): Promise<{ candidates: number; byInstrument: number; withOpenAlex: number; scanCreditsPerLead: { min: number; max: number } }> {
  const eligible = await repositories.faculty.find({ filter: [where.eq('status', 'eligible')] });
  const members = eligible.filter((m) => (m.relevance.score ?? -1) >= threshold || m.research.instruments.length > 0);
  const { estimateScanCredits } = await import('../discovery/instrumentScan.js');
  return {
    candidates: members.length,
    byInstrument: members.filter((m) => (m.relevance.score ?? -1) < threshold).length,
    withOpenAlex: members.filter((m) => m.person.openAlexAuthorId).length,
    scanCreditsPerLead: await estimateScanCredits(),
  };
}

function leadFromMember(member: FacultyMember): LeadCreateInput {
  const now = new Date();
  const tags = [...member.tags];
  if (member.role.category === 'inferred' && !tags.includes('role-inferred')) tags.push('role-inferred');
  return {
    status: 'pending_review',
    source: {
      type: 'faculty_roster',
      // The OpenAlex author id here is what the instrument scan and the
      // affiliation check key off (`openAlexAuthorIdOf`).
      sourceRecordId: member.person.openAlexAuthorId ?? member.id,
      sourceUrl: member.person.orcid ? `https://orcid.org/${member.person.orcid}` : member.person.openAlexAuthorId ? `https://openalex.org/${member.person.openAlexAuthorId}` : undefined,
      discoveredAt: now,
    },
    person: {
      name: member.person.name,
      normalizedNameKey: normalizeNameKey(member.person.name),
      email: member.person.email,
      title: member.person.title,
      orcid: member.person.orcid,
      profileUrl: member.person.profileUrl ?? (member.person.openAlexAuthorId ? `https://openalex.org/${member.person.openAlexAuthorId}` : undefined),
      phone: member.person.phone,
      websiteUrl: member.person.websiteUrl,
    },
    institution: {
      name: member.institution.name,
      normalizedNameKey: member.institution.name ? normalizeInstitutionKey(member.institution.name) : undefined,
      openAlexId: member.institution.openAlexId,
      discoveredName: member.institution.discoveredName,
      discoveredOpenAlexId: member.institution.discoveredOpenAlexId,
      department: member.department.name ?? member.institution.department,
      country: member.institution.country,
      affiliation: member.institution.affiliation,
    },
    research: {
      summary: member.relevance.reasoning,
      topics: member.research.topics,
      recentPublications: member.research.recentPublications,
      recentGrants: [],
      instruments: member.research.instruments,
    },
    aiScoring: {
      relevanceScore: member.relevance.score,
      relevanceReasoning: member.relevance.reasoning,
      recommendedProductIds: member.relevance.recommendedProductIds ?? [],
      scoredAt: member.relevance.scoredAt,
      scoringModel: member.relevance.scoringModel,
    },
    review: {},
    followUpStatusSummary: 'not_started',
    tags,
  };
}

export async function promoteRoster(options: RosterPromoteOptions, ctx: JobContext): Promise<RosterPromoteSummary> {
  const threshold = options.threshold ?? DEFAULT_PROMOTE_THRESHOLD;
  const filter: Filter = [where.eq('status', 'eligible')];
  if (options.ids?.length) filter.push(where.in('_id', options.ids));
  const members = await repositories.faculty.find({ filter, options: { limit: options.limit ?? 100_000, sort: { 'relevance.score': -1 } } });

  const summary: RosterPromoteSummary = { promoted: 0, byInstrument: 0, alreadyInCrm: 0, belowThreshold: 0, scanned: 0, instrumentsFound: 0, openAlexExhausted: false };
  const promotedLeads: Lead[] = [];
  const includeOwners = options.includeInstrumentOwners ?? true;

  for (const [i, member] of members.entries()) {
    ctx.checkpoint();
    if (i % 10 === 0) ctx.setStage(`promoting ${i + 1}/${members.length}`, (i / Math.max(1, members.length)) * (options.identifyInstruments ? 0.3 : 1));
    const belowBar = (member.relevance.score ?? -1) < threshold;
    // Someone who has written a potentiostat into a paper is a lead whatever
    // the keyword score says — the score can only be low because the works
    // call did not run.
    const ownsInstrument = includeOwners && member.research.instruments.length > 0;
    if (belowBar && !ownsInstrument) {
      summary.belowThreshold += 1;
      continue;
    }
    if (belowBar) summary.byInstrument += 1;
    const existing = await repositories.leads.findDuplicate({
      email: member.person.email,
      normalizedNameKey: normalizeNameKey(member.person.name),
      institutionKey: normalizeInstitutionKey(member.institution.name ?? member.institution.discoveredName),
    });
    if (existing) {
      summary.alreadyInCrm += 1;
      await repositories.faculty.updateById(member.id, { status: 'promoted', leadId: existing.id, promotedAt: new Date() });
      continue;
    }
    const lead = await repositories.leads.create(leadFromMember(member));
    await repositories.faculty.updateById(member.id, { status: 'promoted', leadId: lead.id, promotedAt: new Date() });
    promotedLeads.push(lead);
    summary.promoted += 1;
    ctx.set('promoted', summary.promoted);
  }
  ctx.log(`${summary.promoted} promoted (${summary.byInstrument} by instrument sighting below the score bar), ${summary.alreadyInCrm} already in the CRM, ${summary.belowThreshold} below ${threshold}`);

  if (options.identifyInstruments) {
    const scannable = promotedLeads.filter((l) => l.source.sourceRecordId && /^A\d{6,}$/.test(l.source.sourceRecordId));
    ctx.log(`Instrument scan for ${scannable.length} promoted leads with an OpenAlex record`);
    for (const [i, lead] of scannable.entries()) {
      ctx.checkpoint();
      ctx.setStage(`identifying instruments ${i + 1}/${scannable.length}`, 0.3 + 0.7 * (i / Math.max(1, scannable.length)));
      try {
        const result = await scanLeadInstruments(lead.id);
        summary.scanned += 1;
        if (result.found.length > 0) {
          summary.instrumentsFound += 1;
          ctx.log(`${lead.person.name}: ${result.found.map((f) => (f.model ? `${f.brand} ${f.model}` : f.brand)).join(', ')}`);
          const member = members.find((m) => m.leadId === lead.id || normalizeNameKey(m.person.name) === lead.person.normalizedNameKey);
          if (member) await repositories.faculty.updateById(member.id, { research: { instruments: result.lead.research.instruments }, tags: [...new Set([...member.tags, 'instruments-scanned'])] });
        }
        if (result.stoppedEarly) {
          summary.openAlexExhausted = true;
          ctx.log('OpenAlex allowance exhausted during instrument scans; the rest can be scanned tomorrow', 'error');
          break;
        }
      } catch (error) {
        if (error instanceof OpenAlexBudgetError) {
          summary.openAlexExhausted = true;
          ctx.log('OpenAlex allowance exhausted during instrument scans; the rest can be scanned tomorrow', 'error');
          break;
        }
        ctx.log(`${lead.person.name}: scan failed — ${error instanceof Error ? error.message : String(error)}`, 'warn');
      }
      ctx.set('scanned', summary.scanned);
      ctx.set('instrumentsFound', summary.instrumentsFound);
    }
  }

  if (summary.promoted > 0) {
    await logActivity({
      type: 'discovery_run_completed',
      message: `Faculty roster: ${summary.promoted} lead${summary.promoted === 1 ? '' : 's'} promoted to the CRM (score ≥ ${threshold})`,
      metadata: { threshold, ...summary },
    });
  }
  return summary;
}
