/**
 * Subject nouns from classonesystems.in — the words the site itself uses to
 * describe what it sells and what its customers do.
 *
 * One of five keyword sources (see `services/discovery/keywords.ts`); the other
 * four — brand names, product names, application areas and per-product tags —
 * are derived from the catalog and brand data automatically. This list is the
 * hand-curated one, because "what the website is about" is a judgement call
 * rather than a field in Firestore.
 *
 * Each entry is matched as a phrase in paper titles and abstracts, so entries
 * are one to three words and specific: "screen-printed electrode" finds buyers,
 * "chemistry" finds noise. Grouped by the site's own navigation.
 */
export const SUBJECT_NOUNS: Record<string, string[]> = {
  'Sensing — instruments & techniques': [
    'potentiostat',
    'galvanostat',
    'bipotentiostat',
    'electrochemical workstation',
    'impedance analyzer',
    'frequency response analyzer',
    'electrochemical impedance spectroscopy',
    'cyclic voltammetry',
    'square wave voltammetry',
    'differential pulse voltammetry',
    'linear sweep voltammetry',
    'chronoamperometry',
    'chronopotentiometry',
    'amperometric detection',
    'anodic stripping voltammetry',
    'multiplexer',
  ],
  'Sensing — biosensors & kits': [
    'electrochemical biosensor',
    'electrochemical sensor',
    'screen-printed electrode',
    'screen-printed carbon electrode',
    'wearable sensor',
    'wearable biosensor',
    'point-of-care',
    'aptasensor',
    'immunosensor',
    'glucose sensor',
    'lab-on-a-chip',
    'spectroelectrochemistry',
    'spectroelectrochemical',
  ],
  'Energy — corrosion & CorrTest': [
    'corrosion',
    'corrosion inhibitor',
    'Tafel',
    'linear polarization resistance',
    'potentiodynamic polarization',
    'electrochemical noise',
    'coating degradation',
    'passivation',
    'electrodeposition',
    'electroplating',
  ],
  'Energy — batteries & TOB': [
    'lithium-ion battery',
    'sodium-ion battery',
    'zinc-ion battery',
    'solid-state battery',
    'lithium-sulfur',
    'coin cell',
    'pouch cell',
    'battery cycling',
    'galvanostatic charge-discharge',
    'supercapacitor',
    'electrolyte',
    'glove box',
    'planetary ball mill',
    'electrode slurry',
    'calendering',
  ],
  'Energy — electrocatalysis & fuel cells': [
    'electrocatalyst',
    'electrocatalysis',
    'oxygen evolution reaction',
    'hydrogen evolution reaction',
    'oxygen reduction reaction',
    'water splitting',
    'water electrolysis',
    'CO2 reduction',
    'fuel cell',
    'membrane electrode assembly',
    'rotating disk electrode',
    'rotating ring-disk electrode',
    'photoelectrochemical',
  ],
  'Nano technology — deposition & coating': [
    'sputter coater',
    'magnetron sputtering',
    'thermal evaporation',
    'pulsed laser deposition',
    'thin film deposition',
    'quartz crystal microbalance',
    'RF plasma',
    'plasma treatment',
    'carbon coating',
  ],
  'Accessories — electrodes & cells': [
    'reference electrode',
    'working electrode',
    'counter electrode',
    'glassy carbon electrode',
    'Ag/AgCl',
    'saturated calomel electrode',
    'reversible hydrogen electrode',
    'platinum electrode',
    'carbon paste electrode',
    'three-electrode cell',
    'electrochemical cell',
    'H-cell',
  ],
};

export const ALL_SUBJECT_NOUNS = Object.values(SUBJECT_NOUNS).flat();
