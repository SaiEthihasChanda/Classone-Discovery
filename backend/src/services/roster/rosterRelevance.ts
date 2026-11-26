/**
 * Step 4 — relevance, then promotion into the CRM.
 *
 * Scoring uses the same scorer discovery uses (`enrichCandidates`: the
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
import { env } from '../../config/env.js';
import { BudgetTracker, enrichCandidates, getAiProvider } from '../ai/enrichmentService.js';
import type { AiProvider } from '../ai/types.js';
import { attachDetectedInstruments, confirmedInstruments, mergeInstruments } from '../discovery/instrumentDetector.js';
import { evidenceOf, outsideFocus, resolveFocus, tagApplicationAreas, type AreaDefinition, type KeywordOverride } from './applicationAreas.js';
import { scanLeadInstruments } from '../discovery/instrumentScan.js';
import type { DiscoveredCandidate } from '../discovery/types.js';
import type { JobContext } from '../jobs/jobRunner.js';
import { getSettings } from '../settings/settingsService.js';
import { logActivity } from '../activity/activityService.js';

export const DEFAULT_PROMOTE_THRESHOLD = 40;

export interface RosterScoreOptions {
  ids?: string[];
  /** Restrict to members discovered at these institutes — bounds the pass when the pipeline runs one institute at a time. */
  institutionIds?: string[];
  /** Re-score members that already have a score. Default false. */
  rescore?: boolean;
  /** Years of output to read. Default 5. */
  sinceYears?: number;
  limit?: number;
  /**
   * The pipeline's keyword / application-area override. With one set, members already scored are
   * re-scored from what is stored on them (no OpenAlex call), so the override applies to everyone.
   */
  focus?: KeywordOverride;
  /** Researchers per AI call when the provider can batch. Default AI_SCORE_BATCH_SIZE. */
  batchSize?: number;
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
  /** Left unscored: their topics fall in none of an "only these areas" run's areas (no credit spent). */
  outsideAreas: number;
  openAlexExhausted: boolean;
  estimatedCostUsd: number;
  /** Member id → why the AI call failed for them (left unscored). */
  failures: Record<string, string>;
}

/** What one scoring pass would cost, for the confirmation dialog. */
export async function estimateScoreCost(options: { rescore?: boolean; institutionIds?: string[]; focus?: KeywordOverride }): Promise<{ members: number; withOpenAlex: number; credits: number; outsideAreas: number }> {
  const filter: Filter = [where.eq('status', 'eligible')];
  if (options.institutionIds?.length) filter.push(where.in('institution.discoveredOpenAlexId', options.institutionIds));
  const members = await repositories.faculty.find({ filter });
  const resolved = resolveFocus(options.focus);
  // An "only these areas" run leaves out members whose known topics fall outside every area.
  const inScope = resolved.requireArea ? members.filter((m) => !outsideFocus(m, resolved.areas)) : members;
  // Only a fresh works call costs a credit; an override re-scores already-scored members from stored data.
  const todo = inScope.filter((m) => options.rescore || m.relevance.score === undefined);
  const withOpenAlex = todo.filter((m) => m.person.openAlexAuthorId).length;
  return { members: todo.length, withOpenAlex, credits: withOpenAlex, outsideAreas: members.length - inScope.length };
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

/**
 * Tags every eligible and promoted member in scope with the application areas their stored topics and
 * titles fall in (and mirrors the tags onto their CRM lead). Local only — no network, no credits.
 */
export async function tagRosterAreas(
  options: { ids?: string[]; institutionIds?: string[]; areas: AreaDefinition[] },
  ctx?: JobContext,
): Promise<{ tagged: number; changed: number }> {
  const filter: Filter = [where.in('status', ['eligible', 'promoted'])];
  if (options.ids?.length) filter.push(where.in('_id', options.ids));
  if (options.institutionIds?.length) filter.push(where.in('institution.discoveredOpenAlexId', options.institutionIds));
  const members = await repositories.faculty.find({ filter, options: { limit: 100_000 } });
  let tagged = 0;
  let changed = 0;
  for (const m of members) {
    const areas = tagApplicationAreas(evidenceOf(m), options.areas);
    if (areas.length) tagged += 1;
    if ((m.research.applicationAreas ?? []).join('|') === areas.join('|')) continue;
    changed += 1;
    await repositories.faculty.updateById(m.id, { research: { applicationAreas: areas } } as never);
    if (m.leadId) await repositories.leads.updateById(m.leadId, { research: { applicationAreas: areas } } as never).catch(() => null);
  }
  ctx?.log(`Application areas: ${tagged} of ${members.length} members fall in at least one area (${changed} updated)`);
  return { tagged, changed };
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
  const resolved = resolveFocus(options.focus);
  const scoringFocus = options.focus ? { keywords: resolved.keywords, keywordsOnly: resolved.keywordsOnly, areas: resolved.areas.map((a) => a.label) } : undefined;
  if (options.focus) ctx.log(`Keyword override: ${resolved.describe}`);
  await tagRosterAreas({ ids: options.ids, institutionIds: options.institutionIds, areas: resolved.areas }, ctx);

  const filter: Filter = [where.eq('status', 'eligible')];
  if (options.ids?.length) filter.push(where.in('_id', options.ids));
  if (options.institutionIds?.length) filter.push(where.in('institution.discoveredOpenAlexId', options.institutionIds));
  const members = await repositories.faculty.find({ filter, options: { limit: options.limit ?? 100_000, sort: { createdAt: 1 } } });

  const summary: RosterScoreSummary = { scored: 0, skipped: 0, noEvidence: 0, aboveThreshold: 0, outsideAreas: 0, openAlexExhausted: false, estimatedCostUsd: 0, failures: {} };
  const batchSize = provider.enrichBatch ? Math.max(1, options.batchSize ?? env.AI_SCORE_BATCH_SIZE) : 1;
  ctx.log(`Scoring with ${provider.name}${batchSize > 1 ? ` (${batchSize} per call)` : ''}; ${members.length} eligible members`);

  // Evidence is gathered per person; the AI call is made per batch of `batchSize`.
  type Prepared = { member: FacultyMember; evidence: { publications: FacultyMember['research']['recentPublications']; topics: string[]; evidenceText: string }; funding: FacultyMember['research']['funding']; candidate: DiscoveredCandidate };
  let pending: Prepared[] = [];
  let stopped = false;

  const flush = async () => {
    const batch = pending;
    pending = [];
    if (batch.length === 0) return;
    const results = await enrichCandidates(
      batch.map((p) => p.candidate),
      { catalog, budget, provider, focus: scoringFocus },
    );
    for (const [k, { member, evidence, funding, candidate }] of batch.entries()) {
      const result = results[k] ?? new Error('No result returned');
      if (result instanceof Error) {
        summary.failures[member.id] = result.message;
        ctx.log(`${member.person.name}: scoring failed — ${result.message}`, 'warn');
        if (/budget/i.test(result.message)) stopped = true;
        continue;
      }
      summary.scored += 1;
      summary.estimatedCostUsd = budget.spentUsd;
      if (result.relevanceScore >= DEFAULT_PROMOTE_THRESHOLD) summary.aboveThreshold += 1;
      ctx.log(`${member.person.name}: scored ${result.relevanceScore} via ${result.model}${provider.billable ? ` ($${result.costUsd.toFixed(5)}, run total $${budget.spentUsd.toFixed(4)})` : ' (free)'} — ${(result.relevanceReasoning ?? '').slice(0, 140)}`);
      await repositories.faculty.updateById(member.id, {
        relevance: {
          score: result.relevanceScore,
          reasoning: result.relevanceReasoning,
          recommendedProductIds: result.recommendedProductIds,
          recommendedProductNotes: result.recommendedProductNotes,
          signals: result.signals,
          scoredAt: new Date(),
          scoringModel: result.model,
        },
        research: {
          topics: [...new Set([...(evidence.topics.length ? evidence.topics : result.topics), ...member.research.topics])].slice(0, 20),
          recentPublications: evidence.publications.slice(0, 10),
          evidenceText: candidate.evidenceText.slice(0, 3000),
          instruments: mergeInstruments(member.research.instruments, candidate.instruments),
          ...(funding ? { funding, fundingCheckedAt: new Date() } : {}),
          applicationAreas: tagApplicationAreas({ topics: evidence.topics.length ? evidence.topics : member.research.topics, titles: evidence.publications.map((p) => p.title) }, resolved.areas),
        },
      });
      ctx.set('scored', summary.scored);
      ctx.set('aboveThreshold', summary.aboveThreshold);
    }
  };

  for (const [i, member] of members.entries()) {
    if (stopped) break;
    ctx.checkpoint();
    if (i % 10 === 0) ctx.setStage(`scoring ${i + 1}/${members.length}`, i / Math.max(1, members.length));
    const storedOnly = member.relevance.score !== undefined && !options.rescore;
    if (storedOnly && !options.focus) {
      summary.skipped += 1;
      continue;
    }
    // An "only these areas" run: someone whose known topics fall outside every area is not worth a credit.
    if (resolved.requireArea && outsideFocus(member, resolved.areas)) {
      summary.outsideAreas += 1;
      ctx.set('outsideAreas', summary.outsideAreas);
      ctx.log(`${member.person.name}: not scored — known topics fall outside this run's application areas (no credit spent)`);
      continue;
    }

    let evidence = { publications: [] as FacultyMember['research']['recentPublications'], topics: [] as string[], evidenceText: '' };
    if (storedOnly) {
      // Already scored, but this run changes what counts: re-score from the stored evidence, free.
      evidence = { publications: member.research.recentPublications ?? [], topics: member.research.topics ?? [], evidenceText: member.research.evidenceText ?? '' };
    }
    // Funding acknowledgements arrive with the OpenAlex works (no extra credit); undefined = not read this time.
    let funding: FacultyMember['research']['funding'];
    if (!storedOnly && member.person.openAlexAuthorId && !summary.openAlexExhausted) {
      try {
        const works = await recentWorks({ authorId: member.person.openAlexAuthorId, sinceYear, maxWorks: 25 });
        evidence = works;
        funding = works.funding;
        ctx.count('openAlexCalls');
        ctx.log(`${member.person.name}: OpenAlex works fetched (1 credit) — ${works.publications.length} publications since ${sinceYear}, topics: ${works.topics.slice(0, 5).join(', ') || 'none'}`);
      } catch (error) {
        if (error instanceof OpenAlexBudgetError) {
          summary.openAlexExhausted = true;
          ctx.log('OpenAlex allowance exhausted — remaining members scored from ORCID titles or skipped', 'error');
        } else {
          ctx.log(`${member.person.name}: OpenAlex ${error instanceof Error ? error.message : String(error)}`, 'warn');
        }
      }
    }
    if (!storedOnly && evidence.publications.length === 0 && member.person.orcid) {
      try {
        const titles = await orcidWorks(member.person.orcid, 25);
        evidence = {
          publications: titles.filter((t) => !t.year || t.year >= sinceYear).map((t) => ({ title: t.title, year: t.year, url: t.url })),
          topics: [],
          evidenceText: titles.length ? `Recent work: ${titles.map((t) => t.title).join('; ')}.` : '',
        };
        ctx.log(`${member.person.name}: no OpenAlex evidence — fell back to ORCID titles (free), ${evidence.publications.length} works since ${sinceYear}`);
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
      ctx.log(`${member.person.name}: no research output found anywhere — scored 0`, 'warn');
      continue;
    }
    // Free text detection: "on a CHI 660E" in an abstract tags them now.
    attachDetectedInstruments(candidate, brands);
    if (candidate.instruments?.length) {
      ctx.log(`${member.person.name}: instrument mentioned in evidence text — ${candidate.instruments.map((i) => (i.model ? `${i.brand} ${i.model}` : i.brand)).join(', ')}`);
    }

    pending.push({ member, evidence, funding, candidate });
    if (pending.length >= batchSize) await flush();
  }
  if (!stopped) await flush();
  return summary;
}

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

export interface RosterPromoteOptions {
  threshold?: number;
  ids?: string[];
  /** Restrict to members discovered at these institutes — bounds the pass when the pipeline runs one institute at a time. */
  institutionIds?: string[];
  /** Run the per-lead instrument scan (10 credits per brand, more per model) on each promoted lead. */
  identifyInstruments?: boolean;
  /** Promote anyone with an instrument sighting whatever their score. Default true. */
  includeInstrumentOwners?: boolean;
  /** Promote only members tagged with at least one application area (an "only these areas" override). */
  requireApplicationArea?: boolean;
  limit?: number;
}

export interface RosterPromoteSummary {
  promoted: number;
  /** Of the promoted, those admitted by an instrument sighting rather than the score. */
  byInstrument: number;
  alreadyInCrm: number;
  belowThreshold: number;
  /** Not promoted because they fall in none of the run's application areas ("only these areas"). */
  outsideAreas: number;
  scanned: number;
  instrumentsFound: number;
  openAlexExhausted: boolean;
}

/** What a promotion pass would do, for the confirmation dialog. */
export async function estimatePromotion(threshold: number, institutionIds?: string[]): Promise<{ candidates: number; byInstrument: number; withOpenAlex: number; scanCreditsPerLead: { min: number; max: number } }> {
  const filter: Filter = [where.eq('status', 'eligible')];
  if (institutionIds?.length) filter.push(where.in('institution.discoveredOpenAlexId', institutionIds));
  const eligible = await repositories.faculty.find({ filter });
  const members = eligible.filter((m) => (m.relevance.score ?? -1) >= threshold || confirmedInstruments(m.research.instruments).length > 0);
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
      funding: member.research.funding,
      fundingCheckedAt: member.research.fundingCheckedAt,
      applicationAreas: member.research.applicationAreas,
    },
    aiScoring: {
      relevanceScore: member.relevance.score,
      relevanceReasoning: member.relevance.reasoning,
      recommendedProductIds: member.relevance.recommendedProductIds ?? [],
      recommendedProductNotes: member.relevance.recommendedProductNotes,
      qualificationSignals: member.relevance.signals,
      scoredAt: member.relevance.scoredAt,
      scoringModel: member.relevance.scoringModel,
    },
    review: {},
    followUpStatusSummary: 'not_started',
    tags,
  };
}

/**
 * Members marked `promoted` whose lead no longer exists (the CRM was wiped or the lead deleted)
 * go back to `eligible`, so promotion recreates their lead instead of skipping them for good.
 */
async function releaseOrphanedPromotions(options: RosterPromoteOptions, ctx: JobContext): Promise<number> {
  const filter: Filter = [where.eq('status', 'promoted')];
  if (options.ids?.length) filter.push(where.in('_id', options.ids));
  if (options.institutionIds?.length) filter.push(where.in('institution.discoveredOpenAlexId', options.institutionIds));
  const promoted = await repositories.faculty.find({ filter, options: { limit: 100_000 } });
  let released = 0;
  for (const m of promoted) {
    if (m.leadId && (await repositories.leads.findById(m.leadId))) continue;
    await repositories.faculty.updateById(m.id, { status: 'eligible' } as Partial<FacultyMember>, { unset: ['leadId'] });
    released += 1;
  }
  if (released > 0) ctx.log(`${released} members were marked promoted but their CRM lead no longer exists (deleted or wiped) — returned to eligible so they are promoted again`, 'warn');
  return released;
}

export async function promoteRoster(options: RosterPromoteOptions, ctx: JobContext): Promise<RosterPromoteSummary> {
  const threshold = options.threshold ?? DEFAULT_PROMOTE_THRESHOLD;
  await releaseOrphanedPromotions(options, ctx);
  const filter: Filter = [where.eq('status', 'eligible')];
  if (options.ids?.length) filter.push(where.in('_id', options.ids));
  if (options.institutionIds?.length) filter.push(where.in('institution.discoveredOpenAlexId', options.institutionIds));
  const members = await repositories.faculty.find({ filter, options: { limit: options.limit ?? 100_000, sort: { 'relevance.score': -1 } } });

  const summary: RosterPromoteSummary = { promoted: 0, byInstrument: 0, alreadyInCrm: 0, belowThreshold: 0, outsideAreas: 0, scanned: 0, instrumentsFound: 0, openAlexExhausted: false };
  const promotedLeads: Lead[] = [];
  const includeOwners = options.includeInstrumentOwners ?? true;

  for (const [i, member] of members.entries()) {
    ctx.checkpoint();
    if (i % 10 === 0) ctx.setStage(`promoting ${i + 1}/${members.length}`, (i / Math.max(1, members.length)) * (options.identifyInstruments ? 0.3 : 1));
    if (options.requireApplicationArea && !(member.research.applicationAreas?.length)) {
      summary.outsideAreas += 1;
      ctx.log(`${member.person.name}: not promoted — outside this run's application areas`);
      continue;
    }
    const belowBar = (member.relevance.score ?? -1) < threshold;
    // Someone who has written a potentiostat into a paper is a lead whatever
    // the keyword score says — the score can only be low because the works
    // call did not run.
    // (only sightings that do not need review: a bare brand in a non-electrochemistry paper proves nothing)
    const ownsInstrument = includeOwners && confirmedInstruments(member.research.instruments).length > 0;
    if (belowBar && !ownsInstrument) {
      summary.belowThreshold += 1;
      ctx.log(`${member.person.name}: not promoted — score ${member.relevance.score ?? 'none'} below ${threshold}, no instrument sighting`);
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
      ctx.log(`${member.person.name}: already a lead — linked to the existing CRM record instead of creating a duplicate`);
      continue;
    }
    const lead = await repositories.leads.create(leadFromMember(member));
    await repositories.faculty.updateById(member.id, { status: 'promoted', leadId: lead.id, promotedAt: new Date() });
    promotedLeads.push(lead);
    ctx.log(`${member.person.name}: promoted${belowBar ? ' (by instrument sighting, below the score bar)' : ` (score ${member.relevance.score})`} — new CRM lead ${lead.id}`);
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
          ctx.log(`${lead.person.name}: scan found ${result.found.map((f) => (f.model ? `${f.brand} ${f.model}` : f.brand)).join(', ')}`);
          const member = members.find((m) => m.leadId === lead.id || normalizeNameKey(m.person.name) === lead.person.normalizedNameKey);
          if (member) await repositories.faculty.updateById(member.id, { research: { instruments: result.lead.research.instruments }, tags: [...new Set([...member.tags, 'instruments-scanned'])] });
        } else {
          ctx.log(`${lead.person.name}: scan found no instrument`);
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
