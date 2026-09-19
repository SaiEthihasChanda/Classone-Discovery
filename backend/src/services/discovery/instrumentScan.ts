/**
 * Per-lead instrument scan: every instrument a researcher has written up.
 *
 * WHY THIS EXISTS: the discovery run is institute-scoped and works outward
 * from queries — it sees the one or two papers of a person's that ranked for
 * a brand or model search, and tags what those papers show. A group that has
 * run a Gamry for years and bought a PalmSens last spring may surface only for
 * one of them. This works inward from the person instead: it asks OpenAlex
 * about ONE author's whole recent output, brand by brand, then model by model
 * for the brands that hit.
 *
 * Cost is what keeps it per-lead and on demand rather than part of every run:
 * one 10-credit search call per enabled brand, plus one per model of each
 * brand that turned up. Typically 130–300 credits for one researcher.
 */
import { repositories } from '../../repositories/index.js';
import { ApiError } from '../../middleware/errorHandler.js';
import { OpenAlexBudgetError } from '../../integrations/openAlexBudget.js';
import { searchAuthorWorks } from '../../integrations/openAlexClient.js';
import type { Lead, LeadInstrument, LeadPublication } from '../../types/domain.js';
import { logActivity } from '../activity/activityService.js';
import { getSettings } from '../settings/settingsService.js';
import { mergeInstruments } from './instrumentDetector.js';
import { modelsToIdentify } from './keywords.js';
import { buildBrandQuery, buildModelQuery, INSTRUMENT_LOOKBACK_YEARS } from './sources.js';

export interface InstrumentScanResult {
  lead: Lead;
  /** What this scan found, before merging with what was already known. */
  found: LeadInstrument[];
  /** Brands whose full-text query returned none of this author's papers. */
  brandsWithoutHits: string[];
  queriesIssued: number;
  /** Set when the allowance ran out part-way; the result is partial. */
  stoppedEarly?: string;
}

/** The OpenAlex author id a lead carries, in whichever field discovery stored it. */
function openAlexAuthorId(lead: Lead): string | null {
  const candidates = [lead.person.profileUrl, lead.source.sourceRecordId];
  for (const value of candidates) {
    const match = value?.match(/A\d{6,}/);
    if (match) return match[0];
  }
  return null;
}

/** Credits a scan could cost, before running it — for the button label. */
export async function estimateScanCredits(): Promise<{ min: number; max: number }> {
  const settings = await getSettings();
  const brands = settings.discovery.instrumentBrands.filter((b) => b.enabled);
  const brandCalls = brands.length;
  const modelCalls = settings.discovery.identifyModels
    ? brands.reduce((sum, b) => sum + modelsToIdentify(b).length, 0)
    : 0;
  return { min: brandCalls * 10, max: (brandCalls + modelCalls) * 10 };
}

export async function scanLeadInstruments(leadId: string): Promise<InstrumentScanResult> {
  const lead = await repositories.leads.findById(leadId);
  if (!lead) throw ApiError.notFound('Lead');

  const authorId = openAlexAuthorId(lead);
  if (!authorId) {
    throw ApiError.badRequest(
      'This lead has no OpenAlex author record to scan. Leads found by discovery carry one; ' +
        'a manually added lead can be linked by putting the OpenAlex author URL in its profile field.',
    );
  }

  const settings = await getSettings();
  const brands = settings.discovery.instrumentBrands.filter((b) => b.enabled);
  const sinceYear =
    new Date().getFullYear() - (settings.discovery.instrumentLookbackYears ?? INSTRUMENT_LOOKBACK_YEARS);

  const found: LeadInstrument[] = [];
  const brandsWithoutHits: string[] = [];
  let queriesIssued = 0;
  let stoppedEarly: string | undefined;

  const evidenceFor = (works: LeadPublication[], what: string): string => {
    const [first, ...rest] = works;
    const cite = first ? `"${first.title}"${first.year ? ` (${first.year})` : ''}` : 'a recent paper';
    return `Full text of ${cite}${rest.length > 0 ? ` and ${rest.length} more` : ''} mentions ${what}.`;
  };

  outer: for (const brand of brands) {
    let brandWorks: LeadPublication[];
    try {
      queriesIssued += 1;
      brandWorks = await searchAuthorWorks({ authorId, query: buildBrandQuery(brand), sinceYear });
    } catch (error) {
      if (error instanceof OpenAlexBudgetError) {
        stoppedEarly = error.message;
        break;
      }
      throw error;
    }

    if (brandWorks.length === 0) {
      brandsWithoutHits.push(brand.brand);
      continue;
    }

    // The brand-level sighting first; model sightings below replace it in the
    // merge when they exist, and stand beside it when they do not.
    found.push({
      brandKey: brand.key,
      brand: brand.brand,
      vendor: brand.vendor,
      evidence: evidenceFor(brandWorks, brand.brand),
      sourceUrl: brandWorks[0]?.url,
      matchedVia: 'fulltext_search',
    });

    if (!settings.discovery.identifyModels) continue;

    for (const model of modelsToIdentify(brand)) {
      let modelWorks: LeadPublication[];
      try {
        queriesIssued += 1;
        modelWorks = await searchAuthorWorks({ authorId, query: buildModelQuery(brand, model), sinceYear });
      } catch (error) {
        if (error instanceof OpenAlexBudgetError) {
          stoppedEarly = error.message;
          break outer;
        }
        throw error;
      }
      if (modelWorks.length === 0) continue;

      found.push({
        brandKey: brand.key,
        brand: brand.brand,
        vendor: brand.vendor,
        model: model.model,
        evidence: evidenceFor(modelWorks, `the ${model.model}`),
        sourceUrl: modelWorks[0]?.url,
        matchedVia: 'fulltext_search',
      });
    }
  }

  // A scan's model-level evidence is more specific than the run's, so it goes
  // first and wins the per-key dedupe; nothing already known is lost.
  const merged = mergeInstruments(found, lead.research.instruments);
  const updated =
    (await repositories.leads.updateById(lead.id, { research: { instruments: merged } })) ?? lead;

  if (found.length > 0) {
    await logActivity({
      type: 'lead_discovered',
      message: `Instrument scan — ${lead.person.name}: ${[...new Set(found.map((i) => i.model ?? i.brand))].join(', ')}`,
      relatedLeadId: lead.id,
      metadata: { scan: true, queriesIssued },
    });
  }

  return { lead: updated, found, brandsWithoutHits, queriesIssued, stoppedEarly };
}
