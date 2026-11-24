/**
 * Application areas and the pipeline's keyword override.
 *
 * Default areas are Class One's focus list (Oct 2026 brief). Each area has curated match terms; a
 * researcher is tagged with an area when its terms appear in their indexed topics (weight 2) or recent
 * paper titles (weight 1) with a total of 2 or more — the same rule the hand-built workbook used.
 *
 * The override lets a pipeline run change what counts:
 *   - as "keywords",  mode "add":  extra relevance-scoring terms on top of the built-in ones
 *   - as "keywords",  mode "only": only these terms count towards relevance
 *   - as "applicationAreas", mode "add":  extra areas to tag on top of the defaults
 *   - as "applicationAreas", mode "only": tag only these areas, and promote only people in one of them
 * An area can be written "Label: term one, term two" to give its terms; otherwise terms come from
 * the label (or the curated default whose label it matches).
 */
import type { FacultyMember } from '../../types/domain.js';

export interface AreaDefinition {
  label: string;
  terms: string[];
}

export interface KeywordOverride {
  items: string[];
  as: 'keywords' | 'applicationAreas';
  mode: 'add' | 'only';
}

/** Class One's focus application areas (Oct 2026 brief), with curated match terms. */
export const DEFAULT_APPLICATION_AREAS: AreaDefinition[] = [
  { label: 'Thin-film coating & electrodeposition/electroplating', terms: ['thin film', 'thin-film', 'electrodeposit', 'electroplat', 'sputter', 'atomic layer deposition'] },
  { label: 'Corrosion, paints & protective coatings', terms: ['corros', 'anticorros', 'protective coating', 'coating', 'paint', 'rebar'] },
  { label: 'Battery testing, fuel cells & solar cells', terms: ['batter', 'lithium', 'li-ion', 'sodium-ion', 'na-ion', 'zinc-ion', 'anode material', 'cathode material', 'solid-state electrolyte', 'solid state electrolyte', 'fuel cell', 'sofc', 'pemfc', 'electrolysis cell', 'solar cell', 'photovoltaic', 'dye-sensitized', 'dye-sensitised', 'perovskite solar'] },
  { label: 'Supercapacitors & advanced materials', terms: ['supercapacit', 'pseudocapacit', 'capacitive energy', 'graphene', 'mxene', '2d material', 'metal-organic framework', 'conducting polymer', 'nanomaterial'] },
  { label: 'Photoelectronic materials', terms: ['optoelectron', 'photodetector', 'quantum dot', 'light-emitting', 'semiconductor material', 'perovskite material'] },
  { label: 'Biosensing & point-of-care diagnostics', terms: ['biosens', 'immunosens', 'aptasens', 'point-of-care', 'diagnos', 'bioanaly', 'electrochemical sensor', 'electrochemical detection'] },
  { label: 'Human biology & medical-device applications', terms: ['biomedical', 'medical device', 'implant', 'drug delivery', 'tissue', 'wearable', 'neural', 'biomaterial'] },
  { label: 'Environmental studies', terms: ['wastewater', 'pollutant', 'remediation', 'heavy metal', 'environmental', 'water treatment', 'arsenic', 'dye degradation'] },
  { label: 'Electrochemical measurements inside glove boxes', terms: ['glove box', 'glovebox', 'inert atmosphere', 'argon-filled'] },
  { label: 'Customized electrochemical systems & POC devices', terms: ['point-of-care', 'portable', 'lab-on-chip', 'lab-on-a-chip', 'microfluidic', 'handheld', 'smartphone'] },
];

const STOPWORDS = new Set(['and', 'or', 'of', 'the', 'for', 'in', 'on', 'with', 'to', 'a', 'an', 'applications', 'application', 'studies', 'study', 'based', 'related', 'inside', 'development', 'systems', 'devices', 'materials', 'measurements']);

/** Words of a label as prefix terms: "Electroplating and anodizing" -> ["electroplat", "anodiz"]. */
function termsFromLabel(label: string): string[] {
  const words = label
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s/]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const stems = words.map((w) => w.replace(/(ings?|ions?|ers?|es|s)$/, '')).filter((w) => w.length >= 4);
  const phrase = label.toLowerCase().replace(/\s+/g, ' ').trim();
  return [...new Set([phrase, ...stems])];
}

const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

/** One override item -> an area: "Label: t1, t2" gives terms; a default's label reuses its curated terms. */
export function parseArea(item: string): AreaDefinition | null {
  const raw = item.trim();
  if (!raw) return null;
  const colon = raw.indexOf(':');
  if (colon > 0) {
    const label = raw.slice(0, colon).trim();
    const terms = raw.slice(colon + 1).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (label && terms.length) return { label, terms };
  }
  const known = DEFAULT_APPLICATION_AREAS.find((a) => norm(a.label) === norm(raw) || norm(a.label).startsWith(norm(raw)));
  return known ?? { label: raw, terms: termsFromLabel(raw) };
}

export interface ResolvedFocus {
  areas: AreaDefinition[];
  /** Extra relevance terms (keywords mode). */
  keywords: string[];
  /** Only `keywords` count towards relevance (keywords + only). */
  keywordsOnly: boolean;
  /** Promote only members tagged with at least one area (applicationAreas + only). */
  requireArea: boolean;
  /** One line for logs and the run record. */
  describe: string;
}

export function resolveFocus(override?: KeywordOverride | null): ResolvedFocus {
  const items = (override?.items ?? []).map((s) => s.trim()).filter(Boolean);
  if (!override || items.length === 0) {
    return { areas: DEFAULT_APPLICATION_AREAS, keywords: [], keywordsOnly: false, requireArea: false, describe: 'default application areas and keywords' };
  }
  if (override.as === 'keywords') {
    const keywords = [...new Set(items.map((k) => k.toLowerCase()))];
    return {
      areas: DEFAULT_APPLICATION_AREAS,
      keywords,
      keywordsOnly: override.mode === 'only',
      requireArea: false,
      describe: `${override.mode === 'only' ? 'only these keywords' : 'default keywords plus'}: ${keywords.join(', ')}`,
    };
  }
  const custom = items.map(parseArea).filter((a): a is AreaDefinition => Boolean(a));
  const areas = override.mode === 'only' ? custom : [...DEFAULT_APPLICATION_AREAS, ...custom.filter((c) => !DEFAULT_APPLICATION_AREAS.some((d) => d.label === c.label))];
  return {
    areas,
    keywords: [],
    keywordsOnly: false,
    requireArea: override.mode === 'only',
    describe: `${override.mode === 'only' ? 'only these application areas' : 'default application areas plus'}: ${custom.map((a) => a.label).join('; ')}`,
  };
}

/** Escape a term for a whole-word-start match ("batter" matches "battery", not "abattery"). */
function termRegex(term: string): RegExp {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]+');
  return new RegExp(`(^|[^a-z0-9])${esc}`, 'i');
}
const regexCache = new Map<string, RegExp>();
const rx = (t: string) => {
  let r = regexCache.get(t);
  if (!r) regexCache.set(t, (r = termRegex(t)));
  return r;
};

/**
 * Areas a researcher's work falls in, strongest first (max 3): topics count 2, recent titles 1,
 * an area needs 2 or more.
 */
export function tagApplicationAreas(
  evidence: { topics: string[]; titles: string[] },
  areas: AreaDefinition[] = DEFAULT_APPLICATION_AREAS,
  max = 3,
): string[] {
  const scored: Array<{ label: string; score: number; order: number }> = [];
  areas.forEach((a, order) => {
    const hit = (s: string) => a.terms.some((t) => rx(t).test(s));
    const score = 2 * evidence.topics.filter(hit).length + evidence.titles.filter(hit).length;
    if (score >= 2) scored.push({ label: a.label, score, order });
  });
  return scored.sort((x, y) => y.score - x.score || x.order - y.order).slice(0, max).map((s) => s.label);
}

/**
 * Whether an "only these areas" run can leave this member out before spending anything on them:
 * there were topics to judge by, and none fell in the run's areas. A member with no topics yet (found
 * only on a faculty page or ORCID) is never left out on that basis — scoring is how they get topics.
 */
export function outsideFocus(member: Pick<FacultyMember, 'research'>, areas: AreaDefinition[]): boolean {
  const ev = evidenceOf(member);
  if (ev.topics.length === 0 && ev.titles.length === 0) return false;
  return tagApplicationAreas(ev, areas).length === 0;
}

export function evidenceOf(member: Pick<FacultyMember, 'research'>): { topics: string[]; titles: string[] } {
  return { topics: member.research.topics ?? [], titles: (member.research.recentPublications ?? []).map((p) => p.title) };
}
