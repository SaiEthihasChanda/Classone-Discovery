/**
 * Finds instrument brands and models in free text.
 *
 * This is the zero-cost half of instrument discovery. The full-text OpenAlex
 * search (in `sources.ts`) tells us a paper mentions a brand somewhere; this
 * pass reads the title and abstract we already hold and pulls out the exact
 * model when it is named — "measurements were performed on a CHI 660E".
 *
 * Deterministic regexes rather than an AI call: the set of brands is small and
 * known, the model strings are rigidly formatted, and running this over every
 * candidate would otherwise cost a prompt each.
 */
import {
  BRAND_DETECTION_RULES,
  type InstrumentBrandConfig,
} from '../../data/instrumentBrands.js';
import { brandSearchTerms } from './keywords.js';
import type { DetectedInstrument, DiscoveredCandidate } from './types.js';

/** Escapes a search term for use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A short window of text around a match, for the evidence field. */
function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 60);
  const raw = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${raw}${end < text.length ? '…' : ''}`;
}

/**
 * Scans `text` for every enabled brand and returns one entry per distinct
 * brand+model found.
 */
export function detectInstrumentsInText(
  text: string,
  brands: InstrumentBrandConfig[],
  sourceUrl?: string,
): DetectedInstrument[] {
  if (!text) return [];

  const found: DetectedInstrument[] = [];

  for (const brand of brands) {
    if (!brand.enabled) continue;

    const rules = BRAND_DETECTION_RULES[brand.key];

    // Brands added in the Settings page have no hand-written rules, so fall
    // back to matching their name and aliases literally (case-insensitive,
    // whole words). Good enough to flag the brand; no model extraction.
    const brandPatterns =
      rules?.brandPatterns ??
      brandSearchTerms(brand)
        .filter((t) => t.length >= 4)
        .map((t) => new RegExp(`\\b${escapeRegExp(t)}\\b`, 'i'));

    let brandMatch: RegExpExecArray | null = null;
    for (const pattern of brandPatterns) {
      brandMatch = new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(text);
      if (brandMatch) break;
    }

    const models = new Set<string>();
    let firstModelMatch: RegExpExecArray | null = null;

    for (const { pattern, standalone } of rules?.modelPatterns ?? []) {
      if (!standalone && !brandMatch) continue;
      const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = globalPattern.exec(text)) !== null) {
        const model = m[0].replace(/\s+/g, ' ').trim();
        // A bare brand-like token ("EmStat") is a brand sighting, not a model.
        if (model.length < 3) continue;
        models.add(model);
        firstModelMatch ??= m;
        if (m[0].length === 0) globalPattern.lastIndex += 1;
      }
    }

    if (!brandMatch && models.size === 0) continue;

    if (models.size === 0) {
      found.push({
        brandKey: brand.key,
        brand: brand.brand,
        vendor: brand.vendor,
        evidence: snippetAround(text, brandMatch!.index, brandMatch![0].length),
        sourceUrl,
        matchedVia: 'text_match',
      });
      continue;
    }

    // Keep the most specific models only: "EmStat4S" makes "EmStat" redundant.
    const specific = [...models].filter(
      (m) => ![...models].some((other) => other !== m && other.toLowerCase().startsWith(m.toLowerCase())),
    );

    for (const model of specific) {
      const at = text.toLowerCase().indexOf(model.toLowerCase());
      found.push({
        brandKey: brand.key,
        brand: brand.brand,
        vendor: brand.vendor,
        model,
        evidence: snippetAround(text, at >= 0 ? at : (firstModelMatch?.index ?? 0), model.length),
        sourceUrl,
        matchedVia: 'text_match',
      });
    }
  }

  return found;
}

/**
 * Electrochemistry vocabulary for paper titles. Deliberately generic (techniques, devices, fields),
 * so it is not tuned to any particular set of papers.
 */
const ELECTROCHEM_TITLE =
  /electro|batter|supercapac|fuel cell|sensor|biosens|corros|catal|photoanode|photocathode|photo-?electr|anode|cathode|electrolyte|redox|voltamm|impedance|solar cell|water splitting|oxygen evolution|hydrogen|lithium|sodium|li-ion|na-ion/i;

/** The paper title inside a full-text-search evidence line (`Full text of "<title>" … mentions …`). */
function evidenceTitle(evidence: string): string | null {
  return /Full text of "(.+?)"(?: \(\d{4}\))?(?: and \d+ more)? mentions/.exec(evidence)?.[1] ?? null;
}

/**
 * Whether a sighting should be checked by a person before it counts as ownership.
 *
 * Measured on the stored detections (Oct 2026): every false positive was a full-text-search hit on a
 * bare brand name in a paper that is not electrochemistry — a symposium report, a biology paper, a
 * civil-engineering paper. A named model number, a sentence we matched ourselves, or an
 * electrochemical title clears it.
 */
export function instrumentNeedsReview(i: DetectedInstrument): boolean {
  if (i.model || i.matchedVia === 'text_match') return false;
  const title = evidenceTitle(i.evidence);
  return !(title && ELECTROCHEM_TITLE.test(title));
}

/** Sightings that count as evidence of ownership (scoring, promotion, the sweep's admissions). */
export function confirmedInstruments<T extends DetectedInstrument>(list: T[] | undefined): T[] {
  return (list ?? []).filter((i) => !instrumentNeedsReview(i));
}

/**
 * Merges instrument sightings, dropping duplicates of the same brand+model.
 *
 * A text match with a model beats a search-only hit for the same brand, so
 * when both exist for one brand the model-less entry is dropped. Every
 * returned sighting carries a fresh `needsReview` flag.
 */
export function mergeInstruments(
  ...lists: Array<DetectedInstrument[] | undefined>
): DetectedInstrument[] {
  const byKey = new Map<string, DetectedInstrument>();

  for (const list of lists) {
    for (const item of list ?? []) {
      const key = `${item.brandKey}|${(item.model ?? '').toLowerCase()}`;
      if (!byKey.has(key)) byKey.set(key, item);
    }
  }

  const merged = [...byKey.values()];
  const brandsWithModel = new Set(merged.filter((i) => i.model).map((i) => i.brandKey));

  return merged
    .filter((i) => i.model || !brandsWithModel.has(i.brandKey))
    .slice(0, 12)
    .map((i) => {
      const { needsReview: _stale, ...rest } = i;
      return instrumentNeedsReview(i) ? { ...rest, needsReview: true } : rest;
    });
}

/** Runs text detection over everything we hold on a candidate and merges it in. */
export function attachDetectedInstruments(
  candidate: DiscoveredCandidate,
  brands: InstrumentBrandConfig[],
): void {
  const text = [
    candidate.evidenceText,
    candidate.publications.map((p) => p.title).join('. '),
    candidate.grants.map((g) => g.title).join('. '),
  ]
    .filter(Boolean)
    .join('\n');

  const detected = detectInstrumentsInText(text, brands, candidate.sourceUrl);
  const merged = mergeInstruments(detected, candidate.instruments);
  candidate.instruments = merged.length > 0 ? merged : undefined;
}
