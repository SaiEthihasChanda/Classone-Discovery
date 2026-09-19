/**
 * Discovery source health check.
 *
 * Hits every live data source and reports what came back. Run it when discovery
 * returns fewer leads than expected — it separates "the API changed or is down"
 * from "our filters are too narrow", which are otherwise hard to tell apart.
 *
 * Makes no database writes and no AI calls, so it is free and safe to run.
 *
 * Run:  npm run probe:sources
 */
import { discoverViaNih, discoverViaNsf } from '../integrations/grantClients.js';
import { discoverViaOpenAlex, findAuthorByName } from '../integrations/openAlexClient.js';
import { isScraperAvailable } from '../integrations/scraperServiceClient.js';
import { loadScrapeTargetsFromFile } from '../services/discovery/scrapeTargetsFile.js';

function heading(text: string): void {
  console.log(`\n${'-'.repeat(70)}\n${text}\n${'-'.repeat(70)}`);
}

async function main(): Promise<void> {
  heading('Scrape targets (docs/scrape-targets.yaml)');
  // Reads the seed file directly: this probe is for checking source health
  // without needing a database connection.
  const all = loadScrapeTargetsFromFile();
  const targets = {
    faculty: all.faculty.filter((t) => t.enabled),
    news: all.news.filter((t) => t.enabled),
  };
  console.log(`Faculty pages enabled: ${targets.faculty.length}`);
  for (const target of targets.faculty) {
    console.log(`  - ${target.universityName} (${target.department ?? 'n/a'})`);
    console.log(`    ${target.url}`);
  }
  console.log(`News feeds enabled: ${targets.news.length}`);
  for (const target of targets.news) {
    console.log(`  - ${target.universityName}: ${target.url}`);
  }

  heading('Scraper service');
  const scraperUp = await isScraperAvailable();
  console.log(
    scraperUp
      ? 'Reachable — faculty and news sources will run'
      : 'Unreachable — faculty and news sources will be skipped (start it with uvicorn)',
  );

  heading('OpenAlex');
  try {
    const candidates = await discoverViaOpenAlex({
      query: 'electrochemical impedance spectroscopy battery',
      sinceYear: 2023,
      maxResults: 5,
    });
    console.log(`${candidates.length} candidates`);
    for (const c of candidates.slice(0, 3)) {
      console.log(`  - ${c.name} | ${c.institutionName ?? 'institution unknown'} (${c.country ?? '?'})`);
      console.log(`    topics: ${c.topics.slice(0, 3).join(', ') || 'none'}`);
      console.log(`    paper: "${(c.publications[0]?.title ?? '').slice(0, 60)}" (${c.publications[0]?.year ?? '?'})`);
    }
  } catch (error) {
    console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }

  heading('NIH RePORTER');
  try {
    const candidates = await discoverViaNih({
      query: 'electrochemical biosensor',
      sinceYear: 2023,
      maxResults: 5,
    });
    console.log(`${candidates.length} candidates`);
    for (const c of candidates.slice(0, 3)) {
      console.log(`  - ${c.name} | ${c.title ?? 'no title'} | ${c.institutionName}`);
      console.log(`    grant: "${(c.grants[0]?.title ?? '').slice(0, 55)}" ($${c.grants[0]?.amount ?? '?'})`);
    }
  } catch (error) {
    console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }

  heading('NSF Award Search');
  try {
    const candidates = await discoverViaNsf({
      query: 'electrochemistry potentiostat',
      maxResults: 5,
    });
    const withEmail = candidates.filter((c) => c.email).length;
    console.log(`${candidates.length} candidates (${withEmail} with an email address)`);
    for (const c of candidates.slice(0, 3)) {
      console.log(`  - ${c.name} | ${c.email ?? 'no email'} | ${c.institutionName}`);
      console.log(`    grant: "${(c.grants[0]?.title ?? '').slice(0, 55)}" ($${c.grants[0]?.amount ?? '?'})`);
    }
  } catch (error) {
    console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }

  heading('Name lookup (the "feed a name" path)');
  try {
    const matches = await findAuthorByName('John Goodenough');
    console.log(`${matches.length} matches for "John Goodenough"`);
    for (const c of matches.slice(0, 3)) {
      console.log(`  - ${c.name} | ${c.institutionName ?? 'institution unknown'}`);
    }
  } catch (error) {
    console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log('\nDone.\n');
  process.exit(0);
}

main().catch((error) => {
  console.error('Probe crashed:', error);
  process.exit(1);
});
