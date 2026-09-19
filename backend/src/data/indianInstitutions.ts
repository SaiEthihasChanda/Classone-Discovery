/**
 * Indian institutions of national importance — every IIT, NIT and IIIT that
 * OpenAlex indexes, with their stable OpenAlex institution ids.
 *
 * WHY IDS AND NOT NAME MATCHING: an institution id is exact. Filtering by name
 * would both miss records ("IIT Bombay" vs "Indian Institute of Technology
 * Bombay") and over-match unrelated institutes that share words. These ids let
 * OpenAlex do the filtering server-side, so we never download and discard
 * irrelevant records.
 *
 * Resolved live from the OpenAlex institutions API and verified: a combined
 * 72-institution filter query returns correctly-affiliated works.
 *
 * COVERAGE: all 23 IITs. 28 of 31 NITs — Mizoram, Puducherry and Uttarakhand
 * have no separate OpenAlex entry (small, recently established, output not
 * separately indexed). 21 IIITs of roughly 25; the remainder have little or no
 * indexed research output.
 *
 * To refresh, re-run the resolver against the OpenAlex institutions API
 * filtered by `country_code:in`.
 */

export type InstitutionKind = 'IIT' | 'NIT' | 'IIIT';

export interface IndianInstitution {
  /** OpenAlex institution id, e.g. "I162827531". */
  openAlexId: string;
  name: string;
  kind: InstitutionKind;
  /** Indexed works count at time of resolution — a rough proxy for research scale. */
  worksCount: number;
}

export const INDIAN_INSTITUTIONS: IndianInstitution[] = [
  // --- IITs (23) ---
  { openAlexId: 'I68891433', name: 'Indian Institute of Technology Delhi', kind: 'IIT', worksCount: 72686 },
  { openAlexId: 'I145894827', name: 'Indian Institute of Technology Kharagpur', kind: 'IIT', worksCount: 72265 },
  { openAlexId: 'I24676775', name: 'Indian Institute of Technology Madras', kind: 'IIT', worksCount: 68063 },
  { openAlexId: 'I162827531', name: 'Indian Institute of Technology Bombay', kind: 'IIT', worksCount: 66024 },
  { openAlexId: 'I94234084', name: 'Indian Institute of Technology Kanpur', kind: 'IIT', worksCount: 52785 },
  { openAlexId: 'I154851008', name: 'Indian Institute of Technology Roorkee', kind: 'IIT', worksCount: 52179 },
  { openAlexId: 'I1317621060', name: 'Indian Institute of Technology Guwahati', kind: 'IIT', worksCount: 34687 },
  { openAlexId: 'I64295750', name: 'Indian Institute of Technology Indore', kind: 'IIT', worksCount: 25045 },
  { openAlexId: 'I189109744', name: 'Indian Institute of Technology Dhanbad', kind: 'IIT', worksCount: 23630 },
  { openAlexId: 'I65181880', name: 'Indian Institute of Technology Hyderabad', kind: 'IIT', worksCount: 21114 },
  { openAlexId: 'I56404289', name: 'Indian Institute of Technology BHU', kind: 'IIT', worksCount: 16479 },
  { openAlexId: 'I132153292', name: 'Indian Institute of Technology Patna', kind: 'IIT', worksCount: 10000 },
  { openAlexId: 'I99729588', name: 'Indian Institute of Technology Bhubaneswar', kind: 'IIT', worksCount: 9800 },
  { openAlexId: 'I27674431', name: 'Indian Institute of Technology Gandhinagar', kind: 'IIT', worksCount: 9625 },
  { openAlexId: 'I154549908', name: 'Indian Institute of Technology Jodhpur', kind: 'IIT', worksCount: 9067 },
  { openAlexId: 'I119241673', name: 'Indian Institute of Technology Ropar', kind: 'IIT', worksCount: 8744 },
  { openAlexId: 'I9579091', name: 'Indian Institute of Technology Mandi', kind: 'IIT', worksCount: 8656 },
  { openAlexId: 'I4210121466', name: 'Indian Institute of Technology Bhilai', kind: 'IIT', worksCount: 4604 },
  { openAlexId: 'I4210127441', name: 'Indian Institute of Technology Jammu', kind: 'IIT', worksCount: 4040 },
  { openAlexId: 'I4210113248', name: 'Indian Institute of Technology Palakkad', kind: 'IIT', worksCount: 3495 },
  { openAlexId: 'I4210109292', name: 'Indian Institute of Technology Tirupati', kind: 'IIT', worksCount: 3361 },
  { openAlexId: 'I4210152718', name: 'Indian Institute of Technology Dharwad', kind: 'IIT', worksCount: 2835 },
  { openAlexId: 'I4210112052', name: 'Indian Institute of Technology Goa', kind: 'IIT', worksCount: 2032 },

  // --- NITs (28) ---
  { openAlexId: 'I16292982', name: 'National Institute of Technology Rourkela', kind: 'NIT', worksCount: 23143 },
  { openAlexId: 'I122964287', name: 'National Institute of Technology Tiruchirappalli', kind: 'NIT', worksCount: 22356 },
  { openAlexId: 'I83205935', name: 'Malaviya National Institute of Technology Jaipur', kind: 'NIT', worksCount: 22257 },
  { openAlexId: 'I121750182', name: 'National Institute of Technology Warangal', kind: 'NIT', worksCount: 17656 },
  { openAlexId: 'I11880225', name: 'National Institute of Technology Karnataka', kind: 'NIT', worksCount: 17356 },
  { openAlexId: 'I42014448', name: 'Sardar Vallabhbhai National Institute of Technology Surat', kind: 'NIT', worksCount: 14886 },
  { openAlexId: 'I155837530', name: 'National Institute of Technology Durgapur', kind: 'NIT', worksCount: 14227 },
  { openAlexId: 'I152869788', name: 'Motilal Nehru National Institute of Technology', kind: 'NIT', worksCount: 12012 },
  { openAlexId: 'I91277730', name: 'Maulana Azad National Institute of Technology', kind: 'NIT', worksCount: 11773 },
  { openAlexId: 'I151903974', name: 'National Institute Of Technology Silchar', kind: 'NIT', worksCount: 11574 },
  { openAlexId: 'I114845381', name: 'National Institute of Technology Calicut', kind: 'NIT', worksCount: 11555 },
  { openAlexId: 'I105094715', name: 'National Institute of Technology Kurukshetra', kind: 'NIT', worksCount: 11155 },
  { openAlexId: 'I70971781', name: 'Dr. B. R. Ambedkar National Institute of Technology Jalandhar', kind: 'NIT', worksCount: 10522 },
  { openAlexId: 'I167153416', name: 'Visvesvaraya National Institute of Technology', kind: 'NIT', worksCount: 10445 },
  { openAlexId: 'I38335241', name: 'National Institute of Technology Raipur', kind: 'NIT', worksCount: 10143 },
  { openAlexId: 'I11793825', name: 'National Institute of Technology Patna', kind: 'NIT', worksCount: 8626 },
  { openAlexId: 'I36909309', name: 'National Institute of Technology Hamirpur', kind: 'NIT', worksCount: 8245 },
  { openAlexId: 'I8778637', name: 'National Institute of Technology Srinagar', kind: 'NIT', worksCount: 7498 },
  { openAlexId: 'I196486160', name: 'National Institute of Technology Agartala', kind: 'NIT', worksCount: 6571 },
  { openAlexId: 'I187761245', name: 'National Institute of Technology Jamshedpur', kind: 'NIT', worksCount: 6259 },
  { openAlexId: 'I9523339', name: 'National Institute of Technology Meghalaya', kind: 'NIT', worksCount: 5075 },
  { openAlexId: 'I4210153924', name: 'National Institute of Technology Andhra Pradesh', kind: 'NIT', worksCount: 3693 },
  { openAlexId: 'I44635919', name: 'National Institute of Technology Delhi', kind: 'NIT', worksCount: 3364 },
  { openAlexId: 'I265627732', name: 'National Institute of Technology Manipur', kind: 'NIT', worksCount: 2198 },
  { openAlexId: 'I4210109276', name: 'National Institute of Technology Goa', kind: 'NIT', worksCount: 2054 },
  { openAlexId: 'I57496824', name: 'National Institute of Technology Arunachal Pradesh', kind: 'NIT', worksCount: 1962 },
  { openAlexId: 'I3131484930', name: 'National Institute of Technology Nagaland', kind: 'NIT', worksCount: 1762 },
  { openAlexId: 'I101326570', name: 'National Institute of Technology Sikkim', kind: 'NIT', worksCount: 1478 },

  // --- IIITs (21) ---
  { openAlexId: 'I26072440', name: 'Indian Institute of Information Technology Allahabad', kind: 'IIIT', worksCount: 8612 },
  { openAlexId: 'I188963388', name: 'International Institute of Information Technology', kind: 'IIIT', worksCount: 7739 },
  { openAlexId: 'I64189192', name: 'International Institute of Information Technology, Hyderabad', kind: 'IIIT', worksCount: 6574 },
  { openAlexId: 'I181514455', name: 'International Institute of Information Technology Bangalore', kind: 'IIIT', worksCount: 6420 },
  { openAlexId: 'I9747756', name: 'Atal Bihari Vajpayee Indian Institute of Information Technology and Management', kind: 'IIIT', worksCount: 6363 },
  { openAlexId: 'I207223250', name: 'Indian Institute of Information Technology Design and Manufacturing Jabalpur', kind: 'IIIT', worksCount: 4920 },
  { openAlexId: 'I39244652', name: 'Indian Institute of Information Technology, Design and Manufacturing, Kancheepuram', kind: 'IIIT', worksCount: 2863 },
  { openAlexId: 'I4210089896', name: 'Indian Institute of Information Technology Guwahati', kind: 'IIIT', worksCount: 2636 },
  { openAlexId: 'I4210100893', name: 'Indian Institute of Information Technology Vadodara', kind: 'IIIT', worksCount: 1907 },
  { openAlexId: 'I4210097016', name: 'International Institute of Information Technology', kind: 'IIIT', worksCount: 1846 },
  { openAlexId: 'I4210113821', name: 'Indian Institute of Information Technology, Pune', kind: 'IIIT', worksCount: 1304 },
  { openAlexId: 'I68695296', name: 'Indian Institute of Information Technology and Management, Kerala', kind: 'IIIT', worksCount: 1296 },
  { openAlexId: 'I4210138251', name: 'Indian Institute of Information Technology, Nagpur', kind: 'IIIT', worksCount: 1073 },
  { openAlexId: 'I4210127244', name: 'Indian Institute of Information Technology Una', kind: 'IIIT', worksCount: 431 },
  { openAlexId: 'I4405259730', name: 'Indian Institute of Information Technology Kalyani', kind: 'IIIT', worksCount: 327 },
  { openAlexId: 'I4210161644', name: 'Indian Institute of Information Technology Senapati, Manipur', kind: 'IIIT', worksCount: 215 },
  { openAlexId: 'I4405265662', name: 'Indian Institute of Information Technology Kota', kind: 'IIIT', worksCount: 159 },
  { openAlexId: 'I4405259253', name: 'Indian Institute of Information Technology Bhopal', kind: 'IIIT', worksCount: 114 },
  { openAlexId: 'I4405261310', name: 'Indian Institute of Information Technology Surat', kind: 'IIIT', worksCount: 66 },
  { openAlexId: 'I4405256517', name: 'Indian Institute of Information Technology Lucknow', kind: 'IIIT', worksCount: 0 },
  { openAlexId: 'I4405255737', name: 'Indian Institute of Information Technology, Sonepat', kind: 'IIIT', worksCount: 0 },
];

/** Institution ids for one or more categories. An empty selection means all of them. */
export function institutionIdsFor(kinds?: InstitutionKind[]): string[] {
  const wanted = kinds && kinds.length > 0 ? new Set(kinds) : null;
  return INDIAN_INSTITUTIONS.filter((i) => !wanted || wanted.has(i.kind)).map(
    (i) => i.openAlexId,
  );
}

export function institutionCounts(): Record<InstitutionKind, number> {
  const counts: Record<InstitutionKind, number> = { IIT: 0, NIT: 0, IIIT: 0 };
  for (const institution of INDIAN_INSTITUTIONS) counts[institution.kind] += 1;
  return counts;
}
