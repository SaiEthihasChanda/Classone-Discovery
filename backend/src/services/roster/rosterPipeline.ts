/**
 * The whole faculty-roster pipeline, chained and scoped one institute at a
 * time, as a single background job with a stage checklist the caller chooses.
 *
 * Why per-institute rather than "build all, then verify all, then score
 * all…": that shape means a credit shortfall or a stop midway leaves every
 * institute half-done, and holds every institute's unscored members in
 * memory at once. Finishing one institute completely before starting the
 * next means a shortfall leaves a clean boundary — institutes already done
 * are fully done, in the CRM, filled — and the working set in memory is
 * never more than one institute's roster.
 */
import { INDIAN_INSTITUTIONS } from '../../data/indianInstitutions.js';
import { OpenAlexBudgetError } from '../../integrations/openAlexBudget.js';
import type { JobContext } from '../jobs/jobRunner.js';
import { verifyRoster } from './rosterAffiliation.js';
import { buildRoster, type RosterSource } from './rosterBuilder.js';
import { fillRoster } from './rosterFill.js';
import { DEFAULT_PROMOTE_THRESHOLD, estimatePromotion, estimateScoreCost, promoteRoster, scoreRoster } from './rosterRelevance.js';
import { estimateSweepCredits, sweepInstruments } from './rosterSweep.js';
import { resolveFocus, type KeywordOverride } from './applicationAreas.js';

export type PipelineStage = 'build' | 'verify' | 'score' | 'sweep' | 'promote' | 'fill';
export const PIPELINE_STAGES: PipelineStage[] = ['build', 'verify', 'score', 'sweep', 'promote', 'fill'];

export interface PipelineOptions {
  institutionIds: string[];
  stages: PipelineStage[];
  sources?: RosterSource[];
  includeInferredRoles?: boolean;
  /** Works floor for the OpenAlex author listing — raising it drops thin, low-signal candidates before they ever cost a scoring credit. Default 5. */
  minWorks?: number;
  threshold?: number;
  /** Per-lead instrument scan on promotion (10+ credits per lead). Off by default — the sweep finds the same evidence once per institute instead. */
  identifyInstruments?: boolean;
  includeInstrumentOwners?: boolean;
  /** Limit the sweep to these brand keys. Default: every enabled brand. */
  sweepBrands?: string[];
  useScraper?: boolean;
  /** Fill stage: also web-search remaining gaps with Gemini (billed key; opt-in). */
  useGeminiBackfill?: boolean;
  /** Keyword / application-area override for this run (see applicationAreas.ts). */
  focus?: KeywordOverride;
}

export interface PipelineInstituteResult {
  id: string;
  name: string;
  ran: PipelineStage[];
  stoppedReason?: string;
}

export interface PipelineSummary {
  institutions: PipelineInstituteResult[];
  completed: number;
  openAlexExhausted: boolean;
}

/**
 * A rough total before spending anything. Build/verify/fill are free or
 * near-free (a handful of filter-call credits per 200 OpenAlex authors) and
 * are not itemised here; score and sweep are where the daily allowance goes.
 * The score estimate only counts institutes already on the roster — one not
 * yet built contributes nothing here and its real cost only appears once the
 * build stage has run.
 */
export async function estimatePipeline(options: Pick<PipelineOptions, 'institutionIds' | 'stages' | 'threshold' | 'sweepBrands' | 'identifyInstruments' | 'focus'>): Promise<{
  scoreCredits: number;
  scoreMembersKnown: number;
  /** Members an "only these areas" override leaves unscored (topics outside every area). */
  scoreOutsideAreas: number;
  sweepCredits: { min: number; max: number };
  promoteScanCredits: { min: number; max: number };
  note: string;
}> {
  const n = options.institutionIds.length;
  let scoreCredits = 0;
  let scoreMembersKnown = 0;
  let scoreOutsideAreas = 0;
  if (options.stages.includes('score')) {
    const est = await estimateScoreCost({ institutionIds: options.institutionIds, focus: options.focus });
    scoreCredits = est.credits;
    scoreMembersKnown = est.members;
    scoreOutsideAreas = est.outsideAreas;
  }
  let sweepCredits = { min: 0, max: 0 };
  if (options.stages.includes('sweep')) {
    sweepCredits = await estimateSweepCredits(n, options.sweepBrands);
  }
  let promoteScanCredits = { min: 0, max: 0 };
  if (options.stages.includes('promote') && options.identifyInstruments) {
    const est = await estimatePromotion(options.threshold ?? DEFAULT_PROMOTE_THRESHOLD, options.institutionIds);
    promoteScanCredits = { min: est.scanCreditsPerLead.min * est.withOpenAlex, max: est.scanCreditsPerLead.max * est.withOpenAlex };
  }
  return {
    scoreCredits,
    scoreMembersKnown,
    scoreOutsideAreas,
    sweepCredits,
    promoteScanCredits,
    note:
      n > 0 && options.stages.includes('build')
        ? `Institutes not yet built add to the score cost once built — roughly 1 credit per eligible member found, same as the ${scoreMembersKnown}-member estimate above scaled to the new roster size.`
        : '',
  };
}

export async function runPipeline(options: PipelineOptions, ctx: JobContext): Promise<PipelineSummary> {
  const stages = new Set(options.stages);
  const summary: PipelineSummary = { institutions: [], completed: 0, openAlexExhausted: false };

  for (const [idx, id] of options.institutionIds.entries()) {
    ctx.checkpoint();
    const institution = INDIAN_INSTITUTIONS.find((i) => i.openAlexId === id);
    const name = institution?.name ?? id;
    const result: PipelineInstituteResult = { id, name, ran: [] };
    summary.institutions.push(result);
    const base = idx / options.institutionIds.length;
    ctx.log(`── ${name} (${idx + 1}/${options.institutionIds.length}) ──`);

    try {
      if (stages.has('build')) {
        ctx.setStage(`${name}: build`, base);
        await buildRoster({ institutionIds: [id], sources: options.sources, includeInferredRoles: options.includeInferredRoles, minWorks: options.minWorks }, ctx);
        result.ran.push('build');
      }
      ctx.checkpoint();
      if (stages.has('verify')) {
        ctx.setStage(`${name}: verify`, base);
        await verifyRoster({ institutionIds: [id], freshDays: 0 }, ctx);
        result.ran.push('verify');
      }
      ctx.checkpoint();
      if (stages.has('score')) {
        ctx.setStage(`${name}: score`, base);
        const scored = await scoreRoster({ institutionIds: [id], focus: options.focus }, ctx);
        result.ran.push('score');
        if (scored.openAlexExhausted) throw new OpenAlexBudgetError();
      }
      ctx.checkpoint();
      if (stages.has('sweep')) {
        ctx.setStage(`${name}: instrument sweep`, base);
        const swept = await sweepInstruments({ institutionIds: [id], brands: options.sweepBrands }, ctx);
        result.ran.push('sweep');
        if (swept.institutions.some((i) => i.budgetExhausted)) throw new OpenAlexBudgetError();
      }
      ctx.checkpoint();
      if (stages.has('promote')) {
        ctx.setStage(`${name}: promote`, base);
        const promoted = await promoteRoster(
          {
            institutionIds: [id],
            threshold: options.threshold ?? DEFAULT_PROMOTE_THRESHOLD,
            identifyInstruments: options.identifyInstruments ?? false,
            includeInstrumentOwners: options.includeInstrumentOwners ?? true,
            requireApplicationArea: resolveFocus(options.focus).requireArea,
          },
          ctx,
        );
        result.ran.push('promote');
        if (promoted.openAlexExhausted) throw new OpenAlexBudgetError();
      }
      ctx.checkpoint();
      if (stages.has('fill')) {
        ctx.setStage(`${name}: fill`, base);
        await fillRoster({ institutionIds: [id], useScraper: options.useScraper, useGeminiBackfill: options.useGeminiBackfill }, ctx);
        result.ran.push('fill');
      }
      summary.completed += 1;
    } catch (error) {
      if (error instanceof OpenAlexBudgetError) {
        summary.openAlexExhausted = true;
        result.stoppedReason = 'OpenAlex allowance exhausted';
        ctx.log(`${name}: OpenAlex allowance exhausted after ${result.ran.join(', ') || 'nothing'} — stopping; institutes already finished are complete and the rest can be resumed once the allowance resets`, 'error');
        break;
      }
      result.stoppedReason = error instanceof Error ? error.message : String(error);
      ctx.log(`${name}: ${result.stoppedReason}`, 'error');
    }
    ctx.set('institutionsCompleted', summary.completed);
  }
  return summary;
}
