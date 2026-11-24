/**
 * Funding agencies behind a researcher's recent papers, read from the papers' own acknowledgements.
 *
 * OpenAlex records, per work, the funders a paper thanks and the grant numbers it prints (`awards`:
 * funder id + name + `funder_award_id`). That is the only free, machine-readable link between Indian
 * researchers and their grants: the agencies themselves publish no complete project list (SERB-PRISM
 * has a captcha; DST/DBT/ICMR lists are scattered PDFs). It costs nothing extra — the fields ride on
 * the works call the relevance pass already makes.
 *
 * What it gives: which agency funds whom, the grant number, and — decoded from the number — the
 * scheme and the sanction year. What it does not give: project title, amount, status or end date
 * (look those up in SERB-PRISM by grant number for a shortlisted researcher). About half of papers
 * name no funder at all, so absence of funding here is not evidence of no funding.
 */
import type { FundingAcknowledgement, FundingAgency } from '../../types/domain.js';

/** The agencies the sales team tracks (Oct 2026 brief), in display order. */
export const TRACKED_AGENCIES: Array<{ key: Exclude<FundingAgency, 'other'>; label: string }> = [
  { key: 'serb', label: 'SERB' },
  { key: 'anrf', label: 'ANRF' },
  { key: 'dst', label: 'DST' },
  { key: 'dbt', label: 'DBT' },
  { key: 'icmr', label: 'ICMR' },
  { key: 'csir', label: 'CSIR' },
  { key: 'birac', label: 'BIRAC' },
];
export const AGENCY_LABEL: Record<FundingAgency, string> = {
  ...Object.fromEntries(TRACKED_AGENCIES.map((a) => [a.key, a.label])),
  other: 'Other',
} as Record<FundingAgency, string>;

/** OpenAlex funder ids, measured Oct 2026 (the biggest Indian funder records). */
const FUNDER_IDS: Record<string, FundingAgency> = {
  F4320334771: 'serb',
  F4320320719: 'dst',
  F4320320717: 'dbt',
  F4320320720: 'icmr',
  F4320320721: 'csir',
  F4320336200: 'birac',
};

/** Name patterns, for the many duplicate/variant funder records. Order matters: SERB before DST. */
const NAME_PATTERNS: Array<[RegExp, FundingAgency]> = [
  [/anusandhan national research foundation|\banrf\b/i, 'anrf'],
  [/science (and|&) engineering research board|\bserb\b/i, 'serb'],
  [/biotechnology industry research assistance|\bbirac\b/i, 'birac'],
  [/department of biotechnology|\bdbt\b|biocare/i, 'dbt'],
  [/indian council of medical research|\bicmr\b/i, 'icmr'],
  [/council of scientific (and|&) industrial research|\bcsir\b/i, 'csir'],
  [/department of science (and|&) technology|\bdst\b/i, 'dst'],
];

/**
 * Scheme codes at the start of SERB/ANRF file numbers (e.g. CRG/2022/001541). Only codes whose
 * meaning is certain; anything else keeps its grant number as printed, undecoded.
 */
const SERB_SCHEMES: Record<string, string> = {
  CRG: 'Core Research Grant',
  EMR: 'Extramural Research (now CRG)',
  ECR: 'Early Career Research',
  SRG: 'Start-up Research Grant',
  MTR: 'MATRICS',
  SPR: 'SUPRA',
  TAR: 'TARE',
  SPG: 'POWER Grant',
  ARG: 'Advanced Research Grant',
  PDF: 'National Post-Doctoral Fellowship',
  JCB: 'J C Bose Fellowship',
};

export function agencyOf(funderName?: string, funderId?: string): FundingAgency {
  const id = funderId?.split('/').pop();
  if (id && FUNDER_IDS[id]) return FUNDER_IDS[id]!;
  for (const [re, agency] of NAME_PATTERNS) if (funderName && re.test(funderName)) return agency;
  return 'other';
}

/** Scheme and sanction year from a grant number, where the format is known. */
export function decodeAward(awardId?: string): { scheme?: string; year?: number; serbScheme: boolean } {
  if (!awardId) return { serbScheme: false };
  const id = awardId.trim().toUpperCase();
  const prefix = /^([A-Z]{2,5})\s*[/-]/.exec(id)?.[1];
  const serbScheme = Boolean(prefix && SERB_SCHEMES[prefix]);
  let scheme = prefix ? SERB_SCHEMES[prefix] : undefined;
  if (!scheme && /^DST\s*\/\s*INSPIRE/.test(id)) scheme = 'INSPIRE Faculty Fellowship';
  if (!scheme && /EMR-?II\b/.test(id)) scheme = 'CSIR Extramural Research (EMR-II)';
  let year: number | undefined;
  const four = /(?:^|[^0-9])((?:19[89]|20[0-4])\d)(?:[^0-9]|$)/.exec(id);
  if (four) year = Number(four[1]);
  else {
    const csir = /\/(\d{2})\/EMR/.exec(id); // CSIR: 01(2955)/18/EMR-II
    if (csir) year = 2000 + Number(csir[1]);
  }
  if (year && year > new Date().getFullYear()) year = undefined;
  return { scheme: scheme ? (prefix && serbScheme ? `${scheme} (${prefix})` : scheme) : undefined, year, serbScheme };
}

/** The slice of an OpenAlex work this module reads. */
export interface WorkFunding {
  id?: string;
  doi?: string;
  title?: string;
  publication_year?: number;
  funders?: Array<{ id?: string; display_name?: string }>;
  awards?: Array<{ funder_id?: string; funder_display_name?: string; funder_award_id?: string; display_name?: string }>;
}

/**
 * One entry per (agency, grant number) — or per funder when no number was printed — across a
 * researcher's recent works, newest acknowledgement kept as the example paper. Tracked agencies
 * first, then by sanction (or paper) year, newest first.
 */
export function summariseFunding(works: WorkFunding[], max = 15): FundingAcknowledgement[] {
  const byKey = new Map<string, FundingAcknowledgement>();
  const add = (w: WorkFunding, funder: string | undefined, funderId: string | undefined, awardId: string | undefined) => {
    const decoded = decodeAward(awardId);
    let agency = agencyOf(funder, funderId);
    // SERB was a DST body: papers often thank "DST" for what is a SERB grant number.
    if (agency === 'dst' && decoded.serbScheme) agency = 'serb';
    const award = awardId?.trim() || undefined;
    const key = `${agency}|${award ? award.toUpperCase() : `funder:${(funderId ?? funder ?? '').toLowerCase()}`}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.papers += 1;
      if ((w.publication_year ?? 0) > (prev.workYear ?? 0)) Object.assign(prev, exampleOf(w));
      return;
    }
    byKey.set(key, {
      agency,
      funder: funder ?? AGENCY_LABEL[agency],
      funderId: funderId?.split('/').pop(),
      awardId: award,
      scheme: decoded.scheme,
      year: decoded.year,
      papers: 1,
      ...exampleOf(w),
    });
  };
  for (const w of works) {
    const awarded = new Set<string>();
    for (const a of w.awards ?? []) {
      add(w, a.funder_display_name, a.funder_id, a.funder_award_id);
      if (a.funder_id) awarded.add(a.funder_id.split('/').pop()!);
    }
    // Funders thanked without a grant number.
    for (const f of w.funders ?? []) {
      const fid = f.id?.split('/').pop();
      if (fid && awarded.has(fid)) continue;
      add(w, f.display_name, f.id, undefined);
    }
  }
  const tracked = (a: FundingAgency) => (a === 'other' ? 1 : 0);
  return [...byKey.values()]
    .sort((x, y) => tracked(x.agency) - tracked(y.agency) || (y.year ?? y.workYear ?? 0) - (x.year ?? x.workYear ?? 0))
    .slice(0, max);
}

function exampleOf(w: WorkFunding): Pick<FundingAcknowledgement, 'workTitle' | 'workYear' | 'workUrl'> {
  return { workTitle: w.title ?? undefined, workYear: w.publication_year, workUrl: w.doi ?? w.id };
}

/** Tracked agencies present, for filtering and the "Funding agencies" column. */
export function agenciesIn(funding: FundingAcknowledgement[] | undefined): FundingAgency[] {
  const set = new Set((funding ?? []).map((f) => f.agency).filter((a) => a !== 'other'));
  return TRACKED_AGENCIES.map((a) => a.key).filter((k) => set.has(k));
}

/** Short human line per grant: "SERB · Core Research Grant (CRG) · 2022 · CRG/2022/001541". */
export function fundingLine(f: FundingAcknowledgement): string {
  return [f.agency === 'other' ? f.funder : AGENCY_LABEL[f.agency], f.scheme, f.year, f.awardId].filter(Boolean).join(' · ');
}

/** Most recent sanction year among tracked-agency grants (the "recently funded" signal). */
export function latestGrantYear(funding: FundingAcknowledgement[] | undefined): number | undefined {
  const ys = (funding ?? []).filter((f) => f.agency !== 'other' && f.year).map((f) => f.year!);
  return ys.length ? Math.max(...ys) : undefined;
}
