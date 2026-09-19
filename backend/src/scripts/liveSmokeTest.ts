/**
 * Live end-to-end discovery test.
 *
 * Unlike `npm run smoke` (offline, stubbed sources, deterministic), this drives
 * the REAL pipeline against REAL external services: OpenAlex, NIH, NSF, and — if
 * the Python service is running — live faculty-page and RSS scraping. Leads are
 * written to a throwaway in-memory database, so nothing touches your Atlas data.
 *
 * Use it to confirm the whole chain works after changing a source adapter, or
 * when discovery returns less than expected and you need to see the real payloads.
 *
 * Costs nothing unless OPENAI_API_KEY is set; without one the free keyword
 * heuristic scores the leads.
 *
 * Run:  npm run smoke:live
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

async function main(): Promise<void> {
  console.log('Starting in-memory MongoDB…');
  const mongo = await MongoMemoryServer.create();

  process.env.MONGO_URI = mongo.getUri();
  process.env.MONGO_DB_NAME = 'live_smoke';
  process.env.DB_PROVIDER = 'mongo';
  process.env.NODE_ENV = 'test';

  const { connectDatabase, disconnectDatabase } = await import('../db/connection.js');
  const { repositories } = await import('../repositories/index.js');
  const { runDiscovery } = await import('../services/discovery/discoveryOrchestrator.js');
  const { getAiProvider } = await import('../services/ai/enrichmentService.js');
  const { isScraperAvailable } = await import('../integrations/scraperServiceClient.js');
  const { seedProductCatalog } = await import('./catalogData.js');

  await connectDatabase();

  console.log('Seeding product catalog (needed to ground product mapping)…');
  const seeded = await seedProductCatalog();
  console.log(`  ${seeded} products`);

  const provider = getAiProvider();
  const scraperUp = await isScraperAvailable();
  console.log(`Scraper service: ${scraperUp ? 'up' : 'DOWN (faculty/news will be skipped)'}`);

  // Region can be overridden from the command line, e.g.
  //   npm run smoke:live -- global
  const regionArg = process.argv[2] as 'indian_institutes' | 'india' | 'global' | undefined;
  const region = regionArg ?? 'indian_institutes';

  // Sources are left unset on purpose so the run exercises the DEFAULT source
  // set for this region — which is the behaviour that actually ships. Forcing
  // NIH/NSF into an India-targeted run would test something nobody does.
  console.log(`\nRunning live discovery — region: ${region}`);
  console.log('(this hits real APIs and may take a minute)\n');

  const summary = await runDiscovery({ region });

  console.log('--- RUN SUMMARY ---');
  console.log(`  candidates after dedupe: ${summary.candidatesFound}`);
  console.log(`  leads created:           ${summary.leadsCreated}`);
  console.log(`  duplicates skipped:      ${summary.duplicatesSkipped}`);
  console.log(`  enriched:                ${summary.enrichedCount}`);
  console.log(`  estimated cost:          $${summary.estimatedCostUsd.toFixed(4)}`);
  console.log(`  duration:                ${(summary.durationMs / 1000).toFixed(1)}s`);

  if (summary.errors.length > 0) {
    console.log(`\n  ${summary.errors.length} source warning(s):`);
    for (const error of summary.errors.slice(0, 10)) console.log(`    - ${error}`);
  }

  // --- What actually landed ------------------------------------------------
  const top = await repositories.leads.find({
    options: { sort: { 'aiScoring.relevanceScore': -1 }, limit: 10 },
  });

  console.log('\n--- TOP SCORED LEADS ---');
  for (const lead of top) {
    console.log(
      `  [${String(lead.aiScoring.relevanceScore ?? '--').padStart(3)}] ${lead.person.name}` +
        ` — ${lead.institution.name ?? 'institution unknown'}` +
        ` (${lead.source.type})`,
    );
    if (lead.person.email) console.log(`        email: ${lead.person.email}`);
    if (lead.aiScoring.recommendedProductIds.length > 0) {
      console.log(`        products: ${lead.aiScoring.recommendedProductIds.join(', ')}`);
    }
  }

  // --- Assertions worth making about a live run ----------------------------
  const bySource = new Map<string, number>();
  const all = await repositories.leads.find({ options: { limit: 500 } });
  for (const lead of all) {
    bySource.set(lead.source.type, (bySource.get(lead.source.type) ?? 0) + 1);
  }

  console.log('\n--- LEADS BY SOURCE ---');
  for (const [source, count] of bySource) console.log(`  ${source}: ${count}`);

  const withEmail = all.filter((l) => l.person.email).length;
  const pending = all.filter((l) => l.status === 'pending_review').length;
  const scored = all.filter((l) => l.aiScoring.relevanceScore !== undefined).length;

  console.log('\n--- CHECKS ---');
  // When targeting Indian institutes, OpenAlex leads must actually be at one.
  // This is the check that would catch the institution filter silently breaking.
  const INDIAN_MARKERS = [
    'Indian Institute',
    'National Institute',
    'International Institute',
    'Malaviya',
    'Motilal',
    'Visvesvaraya',
    'Sardar Vallabhbhai',
    'Maulana Azad',
    'Atal Bihari',
    'Ambedkar',
  ];
  const openAlexLeads = all.filter((l) => l.source.type === 'openalex');
  const atTargetInstitute = openAlexLeads.filter((l) =>
    INDIAN_MARKERS.some((m) => (l.institution.name ?? '').includes(m)),
  );

  const checks: Array<[string, boolean]> = [
    ['at least one lead was created', all.length > 0],
    ['every lead awaits human review', pending === all.length],
    ['every lead was scored', scored === all.length],
    ['at least one lead has an email address', withEmail > 0],
    ['at least two sources produced leads', bySource.size >= 2],
    [`AI provider used was "${provider.name}"`, true],
  ];

  if (region === 'indian_institutes' && openAlexLeads.length > 0) {
    checks.push([
      `every OpenAlex lead is at an IIT/NIT/IIIT (${atTargetInstitute.length}/${openAlexLeads.length})`,
      atTargetInstitute.length === openAlexLeads.length,
    ]);
  }

  if (region !== 'global') {
    checks.push([
      'no US-grant leads in an India-targeted run',
      !bySource.has('grant_portal'),
    ]);
  }

  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed += 1;
  }
  console.log(
    `\n  ${all.length} leads total, ${withEmail} with email, across ${bySource.size} sources`,
  );

  await disconnectDatabase();
  await mongo.stop();

  console.log(`\n${checks.length - failed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Live smoke test crashed:', error);
  process.exit(1);
});
