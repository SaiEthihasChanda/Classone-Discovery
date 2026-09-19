/**
 * OpenAlex topics that map onto Class One's product lines.
 *
 * WHY TOPICS AND NOT KEYWORDS: OpenAlex bills a *search* call (any free-text
 * `search` or `.search:` filter) at 10 credits, but a *filter-only* call —
 * `primary_topic.id:T10212` — at 1 credit, and the page size makes no
 * difference to either. So one topic-group query returning 200 works costs a
 * tenth of one keyword query returning 15. Every work in OpenAlex already
 * carries machine-assigned topics derived from its title and abstract, which is
 * exactly what the keyword search was approximating by hand.
 *
 * Groups mirror the website's catalogue: Sensing (potentiostats, biosensor and
 * application kits), Energy (CorrTest corrosion/battery workstations, TOB
 * battery-making equipment), Nano Technology (deposition and coating systems),
 * and Accessories (electrodes and cells). A researcher whose primary topic is
 * in one of these groups is a plausible buyer of that part of the range.
 *
 * Ids were resolved from the OpenAlex topics endpoint (4,516 topics, Sept 2026)
 * and are stable. `works_count` is the global count at that time — a rough
 * guide to how much each group yields.
 */

export interface OpenAlexTopic {
  id: string;
  name: string;
  worksCount: number;
}

export interface TopicGroup {
  key: string;
  label: string;
  /** Which part of the Class One range this group's researchers tend to buy. */
  productLine: string;
  topics: OpenAlexTopic[];
}

export const OPENALEX_TOPIC_GROUPS: TopicGroup[] = [
  {
    key: 'electroanalysis',
    label: 'Electroanalysis & electrochemical sensors',
    productLine: 'PalmSens4, EmStat4S/4T, Sensit, biosensor & application kits, electrodes',
    topics: [
      { id: 'T11434', name: 'Electrochemical Analysis and Applications', worksCount: 159122 },
      { id: 'T10212', name: 'Electrochemical sensors and biosensors', worksCount: 101682 },
      { id: 'T11472', name: 'Analytical Chemistry and Sensors', worksCount: 162873 },
      { id: 'T10660', name: 'Conducting polymers and applications', worksCount: 126063 },
    ],
  },
  {
    key: 'biosensing',
    label: 'Biosensing, point-of-care & wearables',
    productLine: 'Sensit BT/Smart/Wearable, EmStat Pico, OEM modules',
    topics: [
      { id: 'T10207', name: 'Advanced biosensing and bioanalysis techniques', worksCount: 143645 },
      { id: 'T11393', name: 'Biosensors and Analytical Detection', worksCount: 47914 },
      { id: 'T10338', name: 'Advanced Sensor and Energy Harvesting Materials', worksCount: 120330 },
      { id: 'T11255', name: 'Microfluidic and Bio-sensing Technologies', worksCount: 49057 },
    ],
  },
  {
    key: 'energy_storage',
    label: 'Batteries & supercapacitors',
    productLine: 'CorrTest CS-series (EIS, 5 A), MultiEmStat4, TOB coin-cell & pouch-cell equipment, glove box',
    topics: [
      { id: 'T10018', name: 'Advancements in Battery Materials', worksCount: 193652 },
      { id: 'T10281', name: 'Advanced Battery Materials and Technologies', worksCount: 78980 },
      { id: 'T11690', name: 'Advanced battery technologies research (zinc-ion)', worksCount: 46293 },
      { id: 'T10179', name: 'Supercapacitor Materials and Fabrication', worksCount: 102841 },
      { id: 'T10663', name: 'Advanced Battery Technologies Research', worksCount: 132192 },
    ],
  },
  {
    key: 'electrocatalysis',
    label: 'Electrocatalysis, fuel cells & electrolysis',
    productLine: 'EmStat4X, PalmSens4, CorrTest CS350/CS2350 bipotentiostat, RHE & Pt electrodes',
    topics: [
      { id: 'T10030', name: 'Electrocatalysts for Energy Conversion', worksCount: 150348 },
      { id: 'T10409', name: 'Fuel Cells and Related Materials', worksCount: 137214 },
      { id: 'T10311', name: 'Advancements in Solid Oxide Fuel Cells', worksCount: 69573 },
      { id: 'T11784', name: 'CO2 Reduction Techniques and Catalysts', worksCount: 37443 },
      { id: 'T12112', name: 'Ammonia Synthesis and Nitrogen Reduction', worksCount: 41976 },
      { id: 'T11231', name: 'Microbial Fuel Cells and Bioremediation', worksCount: 45263 },
      { id: 'T10078', name: 'Advanced Photocatalysis Techniques (water splitting)', worksCount: 158091 },
    ],
  },
  {
    key: 'corrosion',
    label: 'Corrosion, coatings & electrodeposition',
    productLine: 'CorrTest CS-series, EIS + corrosion package, specimen clamps & holders',
    topics: [
      { id: 'T10310', name: 'Corrosion Behavior and Inhibition', worksCount: 124737 },
      { id: 'T10736', name: 'Hydrogen embrittlement and corrosion behaviors in metals', worksCount: 66579 },
      { id: 'T11850', name: 'Concrete Corrosion and Durability', worksCount: 69985 },
      { id: 'T11200', name: 'Electrodeposition and Electroless Coatings', worksCount: 44693 },
      { id: 'T12340', name: 'Anodic Oxide Films and Nanostructures', worksCount: 32361 },
    ],
  },
  {
    key: 'thin_films',
    label: 'Thin films, coatings & nano-fabrication',
    productLine: 'Sputter & thermal evaporation coaters, pulsed laser deposition, QCM, RF plasma',
    topics: [
      { id: 'T11160', name: 'Acoustic Wave Resonator Technologies (QCM)', worksCount: 73638 },
      { id: 'T10590', name: 'Chalcogenide Semiconductor Thin Films', worksCount: 100202 },
      { id: 'T10247', name: 'Perovskite Materials and Applications', worksCount: 117959 },
      { id: 'T11128', name: 'Transition Metal Oxide Nanomaterials (electrochromic)', worksCount: 51961 },
      { id: 'T10024', name: 'TiO2 Photocatalysis and Solar Cells', worksCount: 90787 },
    ],
  },
];

export const TOPIC_GROUP_KEYS = OPENALEX_TOPIC_GROUPS.map((g) => g.key);

/** Every topic id across all groups — for validating settings input. */
export const ALL_TOPIC_IDS = new Set(
  OPENALEX_TOPIC_GROUPS.flatMap((g) => g.topics.map((t) => t.id)),
);
