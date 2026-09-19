/**
 * Demonstrates what OpenAlex enrichment does for faculty-page leads.
 *
 * The problem it solves: scraping gives a name, title and email but no research
 * evidence, so the scorer rates those leads near zero — leaving the only
 * contactable leads ranked worst. This prints the before/after score for real
 * people scraped from live faculty pages.
 *
 * Run:  npm run test:enrichment
 */
import { lookupAuthorProfile } from '../integrations/openAlexClient.js';
import { HeuristicProvider } from '../services/ai/heuristicProvider.js';
import type { DiscoveredCandidate } from '../services/discovery/types.js';

const PEOPLE = [
  { name: 'Saikat Dutta', inst: 'National Institute of Technology Karnataka' },
  { name: 'Darshak R. Trivedi', inst: 'National Institute of Technology Karnataka' },
  { name: 'Abanti Sahoo', inst: 'National Institute of Technology Rourkela' },
  { name: 'Suman Mukhopadhyay', inst: 'Indian Institute of Technology Indore' },
  { name: 'Shaikh M. Mobin', inst: 'Indian Institute of Technology Indore' },
];

async function main(): Promise<void> {
  const provider = new HeuristicProvider();
  let improved = 0;
  let matched = 0;

  console.log('\nFaculty-page lead enrichment — before vs after OpenAlex lookup\n');
  console.log(`${'RESEARCHER'.padEnd(24)} ${'MATCH'.padEnd(7)} ${'PUBS'.padEnd(6)} SCORE`);
  console.log('-'.repeat(64));

  for (const person of PEOPLE) {
    const scrapedOnly: DiscoveredCandidate = {
      sourceType: 'faculty_page',
      sourceRecordId: `test:${person.name}`,
      name: person.name,
      institutionName: person.inst,
      publications: [],
      grants: [],
      topics: [],
      evidenceText: `${person.name} — Professor at ${person.inst}`,
    };

    const before = await provider.enrich({ candidate: scrapedOnly, catalog: [] });

    const profile = await lookupAuthorProfile({
      name: person.name,
      institutionName: person.inst,
    });

    const enriched: DiscoveredCandidate = {
      ...scrapedOnly,
      topics: profile?.topics ?? [],
      publications: profile?.publications ?? [],
      evidenceText: `${scrapedOnly.evidenceText}\n\n${profile?.evidenceText ?? ''}`,
    };

    const after = await provider.enrich({ candidate: enriched, catalog: [] });

    if (profile?.matched) matched += 1;
    if (after.relevanceScore > before.relevanceScore) improved += 1;

    const arrow = after.relevanceScore > before.relevanceScore ? '->' : '  ';
    console.log(
      `${person.name.padEnd(24)} ${(profile?.matched ? 'yes' : 'no').padEnd(7)} ` +
        `${String(profile?.publications.length ?? 0).padEnd(6)} ` +
        `${String(before.relevanceScore).padStart(3)} ${arrow} ${String(after.relevanceScore).padStart(3)}`,
    );

    if (profile?.matched && profile.topics.length > 0) {
      console.log(`${' '.repeat(24)} topics: ${profile.topics.slice(0, 3).join(', ')}`);
    }
  }

  console.log('-'.repeat(64));
  console.log(`matched in OpenAlex: ${matched}/${PEOPLE.length}`);
  console.log(`score improved:      ${improved}/${PEOPLE.length}\n`);

  process.exit(0);
}

main().catch((error) => {
  console.error('Enrichment test failed:', error);
  process.exit(1);
});
