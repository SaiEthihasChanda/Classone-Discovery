/**
 * Reads the funding acknowledgements on recent papers for people scored before funding was recorded.
 * New scoring runs record funding on their own (it rides on the works call), so this is a catch-up.
 *
 * Costs OpenAlex credits: one filter-only works call per person (1 credit). Without --apply it only
 * counts the people and estimates the credits; nothing is fetched or written.
 *
 *   npm --prefix backend run funding:refresh                         # estimate only
 *   npm --prefix backend run funding:refresh -- --apply              # everyone not yet checked
 *   npm --prefix backend run funding:refresh -- --apply --limit 50   # a first batch
 *   npm --prefix backend run funding:refresh -- --apply --institution I162827531,I68891433
 *   npm --prefix backend run funding:refresh -- --apply --force      # re-read people already checked
 *
 * Roster members are read from their OpenAlex author id; a promoted member's lead gets the same
 * funding. CRM leads with no roster member are covered when discovery recorded an author id.
 */
import { connectDatabase, disconnectDatabase } from '../db/connection.js';
import { repositories, where, type Filter } from '../repositories/index.js';
import { getAuthorFunding } from '../integrations/openAlexClient.js';
import { OpenAlexBudgetError } from '../integrations/openAlexBudget.js';
import { openAlexAuthorIdOf } from '../services/leads/affiliationService.js';
import { agenciesIn, AGENCY_LABEL } from '../services/funding/fundingAgencies.js';

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const LIMIT = Number(arg('limit') ?? Infinity);
const INSTITUTIONS = arg('institution')?.split(',').filter(Boolean);
const SINCE = new Date().getFullYear() - Number(arg('since-years') ?? 5);

await connectDatabase();

const filter: Filter = [where.ne('person.openAlexAuthorId', null)];
if (!FORCE) filter.push(where.eq('research.fundingCheckedAt', null));
if (INSTITUTIONS?.length) filter.push(where.in('institution.discoveredOpenAlexId', INSTITUTIONS));
const members = (await repositories.faculty.find({ filter, options: { limit: 1_000_000, sort: { 'relevance.score': -1 } } })).slice(0, LIMIT);

const leadFilter: Filter = [];
if (!FORCE) leadFilter.push(where.eq('research.fundingCheckedAt', null));
const memberLeadIds = new Set(
  (await repositories.faculty.find({ filter: [where.ne('leadId', null)], options: { limit: 1_000_000 } })).map((m) => m.leadId),
);
const orphanLeads = INSTITUTIONS?.length
  ? []
  : (await repositories.leads.find({ filter: leadFilter, options: { limit: 1_000_000 } }))
      .filter((l) => !memberLeadIds.has(l.id) && openAlexAuthorIdOf(l))
      .slice(0, Math.max(0, LIMIT - members.length));

const credits = members.length + orphanLeads.length;
console.log(`${members.length} roster members and ${orphanLeads.length} other CRM leads to read — about ${credits} OpenAlex credits (1 per person).`);
if (!APPLY) {
  console.log('Estimate only — nothing fetched or written. Re-run with --apply to read them.');
  await disconnectDatabase();
  process.exit(0);
}

const tally: Record<string, number> = {};
let done = 0;
let withFunding = 0;
try {
  for (const m of members) {
    const funding = await getAuthorFunding({ authorId: m.person.openAlexAuthorId!, sinceYear: SINCE });
    const now = new Date();
    await repositories.faculty.updateById(m.id, { research: { funding, fundingCheckedAt: now } } as never);
    if (m.leadId) await repositories.leads.updateById(m.leadId, { research: { funding, fundingCheckedAt: now } } as never);
    done += 1;
    const agencies = agenciesIn(funding);
    if (agencies.length) withFunding += 1;
    for (const a of agencies) tally[AGENCY_LABEL[a]] = (tally[AGENCY_LABEL[a]] ?? 0) + 1;
    if (done % 25 === 0) console.log(`  ${done}/${credits} read…`);
  }
  for (const l of orphanLeads) {
    const funding = await getAuthorFunding({ authorId: openAlexAuthorIdOf(l)!, sinceYear: SINCE });
    await repositories.leads.updateById(l.id, { research: { funding, fundingCheckedAt: new Date() } } as never);
    done += 1;
    const agencies = agenciesIn(funding);
    if (agencies.length) withFunding += 1;
    for (const a of agencies) tally[AGENCY_LABEL[a]] = (tally[AGENCY_LABEL[a]] ?? 0) + 1;
  }
} catch (error) {
  if (error instanceof OpenAlexBudgetError) console.log(`OpenAlex allowance exhausted after ${done} people — re-run tomorrow; already-read people are skipped.`);
  else throw error;
}

console.log(`\nread ${done} people; ${withFunding} acknowledge at least one tracked agency.`);
console.log('people per agency:', JSON.stringify(tally));
await disconnectDatabase();
