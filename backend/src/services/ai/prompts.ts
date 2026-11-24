/** Shared scoring prompt — same wording for every chat-style provider (OpenAI, Gemini), so results stay comparable. */
export const LEAD_SCORING_SYSTEM_PROMPT = `You qualify sales leads for Class One Systems (classonesystems.in), which supplies research instrumentation to institutions in India:
- Sensing: PalmSens potentiostats/galvanostats with EIS (PalmSens4, EmStat4S/4T/4X/4R, Nexus), multi-channel systems (MultiPalmSens4, MultiEmStat4, RackMount 16CH), OEM modules (EmStat Pico, EmStat4M), wireless/wearable biosensor potentiostats (Sensit BT/Smart/Wearable), spectroelectrochemistry, corrosion and educational application kits, and SDKs (Python, MATLAB, LabVIEW, .NET, MethodSCRIPT).
- Energy: CorrTest electrochemical workstations (CS-series, bipotentiostats, 5 A high-current, EIS) for corrosion and battery research; TOB battery-making and testing equipment (coin-cell crimpers and cutters, pouch-cell presses, winding machines, ball mills, glove boxes, solid-state split cells).
- Nano technology: sputter and thermal evaporation coaters, pulsed laser deposition, quartz crystal microbalance, RF plasma generators.
- Accessories: reference, working and counter electrodes (Ag/AgCl, SCE, RHE, Pt, glassy carbon), specimen clamps, MEA cells, glass cells.

Score how likely a researcher is to BUY THIS EQUIPMENT.

Be strict. A high score requires evidence they actually do electrochemical measurement — voltammetry, impedance spectroscopy, electrocatalysis, battery/corrosion/biosensor characterisation. A researcher in an adjacent field who merely mentions "electrode" or "catalysis" is a weak lead, not a strong one. When the evidence is thin, score low and say why: a false positive wastes a salesperson's time and risks emailing someone irrelevant.

Score each signal 0-100:
- product_relevance: does their work require this equipment?
- institutional_strength: research capacity and funding of their institution
- recency: how current is the evidence
- engagement_potential: how reachable and likely to respond

Recommend products ONLY by id from the supplied catalog. If nothing fits, return an empty list rather than guessing.

If "Instruments in use" is supplied, treat it as strong evidence: a researcher already running a Gamry, Autolab, BioLogic, CH Instruments or Admiral potentiostat is a proven buyer of this equipment category (a competitive-displacement or second-instrument opportunity); one already using PalmSens or CorrTest is an existing Class One brand user (an upgrade, multi-channel or accessory opportunity). Mention the instrument and the implied opportunity in the reasoning.`;

/** Builds the per-candidate user prompt shared by OpenAI and Gemini. */
export function buildLeadScoringUserPrompt(
  candidate: import('../discovery/types.js').DiscoveredCandidate,
  catalogSummary: string,
  focus?: import('./types.js').ScoringFocus,
): string {
  return [buildResearcherBlock(candidate), buildRunContext(catalogSummary, focus)].join('\n');
}

/** One researcher's evidence — the part of the prompt that differs per person. */
export function buildResearcherBlock(candidate: import('../discovery/types.js').DiscoveredCandidate): string {
  return [
    `Researcher: ${candidate.name}`,
    candidate.title ? `Position: ${candidate.title}` : '',
    candidate.institutionName ? `Institution: ${candidate.institutionName}` : '',
    candidate.topics.length > 0 ? `Indexed topics: ${candidate.topics.join(', ')}` : '',
    candidate.publications.length > 0
      ? `Recent publications:\n${candidate.publications.map((p) => `- ${p.title} (${p.year ?? 'n.d.'})`).join('\n')}`
      : '',
    candidate.grants.length > 0
      ? `Recent grants:\n${candidate.grants.map((g) => `- ${g.title} (${g.agency ?? '?'}, ${g.amount ? `$${g.amount}` : 'amount unknown'})`).join('\n')}`
      : '',
    `Evidence text:\n${candidate.evidenceText.slice(0, 1500)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The run's focus and the product catalog — shared by every researcher in a call. */
export function buildRunContext(catalogSummary: string, focus?: import('./types.js').ScoringFocus): string {
  return [
    focus?.keywords.length ? `Focus keywords for this run${focus.keywordsOnly ? ' (judge relevance on these only)' : ''}: ${focus.keywords.join(', ')}` : '',
    focus?.areas.length ? `Focus application areas: ${focus.areas.join('; ')}` : '',
    `Product catalog:\n${catalogSummary}`,
  ]
    .filter(Boolean)
    .join('\n');
}
