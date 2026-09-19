/**
 * Phase 1 end-to-end smoke test.
 *
 * Spins up an in-memory MongoDB, boots the real Express app, and drives the real
 * HTTP API — no mocks below the network boundary. Proves the repository
 * abstraction, models, validation, dedupe, review flow and dashboard all work
 * together before anything is pointed at a real Atlas cluster.
 *
 * Run:  npm run smoke
 */
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { OpenAlexTargeting } from '../services/discovery/sources.js';

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  FAIL  ${name}\n        ${message}`);
    failed += 1;
  }
}

async function main(): Promise<void> {
  console.log('Starting in-memory MongoDB…');
  const mongo = await MongoMemoryServer.create();

  // The env module reads process.env at import time, so these must be set before
  // any application module is imported — hence the dynamic imports below.
  process.env.MONGO_URI = mongo.getUri();
  process.env.MONGO_DB_NAME = 'smoke_test';
  process.env.DB_PROVIDER = 'mongo';
  process.env.NODE_ENV = 'test';
  process.env.PORT = '4999';
  // Never let a test reach a real scraper: web enrichment would fetch real
  // institute pages. Anything scraper-shaped in these tests is injected.
  process.env.SCRAPER_SERVICE_URL = 'http://127.0.0.1:1';

  const { connectDatabase, disconnectDatabase } = await import('../db/connection.js');
  const { createApp } = await import('../app.js');

  await connectDatabase();

  const app = createApp();
  const server = app.listen(4999);
  const base = 'http://localhost:4999/api';

  // `body` is intentionally `any`: this is a test driver asserting against real
  // JSON responses, and threading exact types through every assertion would add
  // noise without catching anything the assertions do not already catch.
  const request = async (
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, body };
  };

  console.log('\nRunning checks:\n');

  // --- Health -------------------------------------------------------------
  await check('GET /health reports the database connected', async () => {
    const { status, body } = await request('/health');
    assert.equal(status, 200);
    assert.equal(body.dependencies.database, 'connected');
  });

  // --- Create -------------------------------------------------------------
  let leadId = '';
  await check('POST /leads creates a lead', async () => {
    const { status, body } = await request('/leads', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Dr. Lily Chen',
        email: 'L.Chen@MIT.edu',
        title: 'Associate Professor',
        institutionName: 'Massachusetts Institute of Technology',
        department: 'Department of Chemistry',
        researchSummary: 'Solid-state battery interfaces and impedance spectroscopy.',
      }),
    });
    assert.equal(status, 201);
    assert.equal(body.wasDuplicate, false);
    assert.equal(body.lead.status, 'pending_review');
    // Emails are lowercased on the way in so dedupe is case-insensitive.
    assert.equal(body.lead.person.email, 'l.chen@mit.edu');
    leadId = body.lead.id;
  });

  await check('name is normalised into a dedupe key', async () => {
    const { body } = await request(`/leads/${leadId}`);
    // Title prefix stripped, tokens sorted — so "Chen, Lily" collapses to the same key.
    assert.equal(body.person.normalizedNameKey, 'chen lily');
  });

  // --- Dedupe -------------------------------------------------------------
  await check('re-submitting the same email is detected as a duplicate', async () => {
    const { status, body } = await request('/leads', {
      method: 'POST',
      body: JSON.stringify({ name: 'Lily Chen', email: 'l.chen@mit.edu' }),
    });
    assert.equal(status, 200, 'a duplicate must not report 201 Created');
    assert.equal(body.wasDuplicate, true);
    assert.equal(body.lead.id, leadId);
  });

  await check('same name + institution without an email is also deduped', async () => {
    const { body } = await request('/leads', {
      method: 'POST',
      body: JSON.stringify({
        // Written surname-first and without the title, exercising name normalisation:
        // "Chen, Lily" and "Dr. Lily Chen" both reduce to the key "chen lily".
        name: 'Chen, Lily',
        // Punctuation and the noise words "the"/"inst"/"of" are stripped, so this
        // and "Massachusetts Institute of Technology" both key to
        // "massachusetts technology".
        institutionName: 'The Massachusetts Inst. of Technology',
      }),
    });
    assert.equal(body.wasDuplicate, true, 'name+institution fallback dedupe did not match');
  });

  await check('DOCUMENTED LIMIT: an abbreviated institution does not dedupe', async () => {
    // "MIT" and "Massachusetts Institute of Technology" normalise differently, so
    // this creates a second record. Acceptable for now — email is the strong
    // signal and fuzzy institution matching is a rabbit hole — but it is a real
    // source of duplicates once automated discovery starts in Phase 2. Asserted
    // here so the boundary is explicit rather than a surprise later.
    const { body } = await request('/leads', {
      method: 'POST',
      body: JSON.stringify({ name: 'Chen, Lily', institutionName: 'MIT' }),
    });
    assert.equal(body.wasDuplicate, false);

    // Clean up so the counts in the checks below stay meaningful.
    await request(`/leads/${body.lead.id}`, { method: 'DELETE' });
  });

  // --- Read / list --------------------------------------------------------
  await check('GET /leads lists leads with a total', async () => {
    const { status, body } = await request('/leads');
    assert.equal(status, 200);
    assert.equal(body.total, 1, 'duplicates should not have created extra records');
    assert.equal(body.items.length, 1);
  });

  await check('GET /leads?search= finds by institution', async () => {
    const { body } = await request('/leads?search=Massachusetts');
    assert.equal(body.total, 1);
  });

  await check('GET /leads?search= returns nothing for a non-match', async () => {
    const { body } = await request('/leads?search=zzzznotarealthing');
    assert.equal(body.total, 0);
  });

  await check('GET /leads?status= filters', async () => {
    const pending = await request('/leads?status=pending_review');
    assert.equal(pending.body.total, 1);
    const approved = await request('/leads?status=approved');
    assert.equal(approved.body.total, 0);
  });

  await check('GET /leads/:id returns the lead with its threads', async () => {
    const { status, body } = await request(`/leads/${leadId}`);
    assert.equal(status, 200);
    assert.equal(body.person.name, 'Dr. Lily Chen');
    assert.deepEqual(body.threads, []);
  });

  // --- Update -------------------------------------------------------------
  await check('PATCH /leads/:id merges nested fields without clobbering siblings', async () => {
    const { status, body } = await request(`/leads/${leadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Full Professor' }),
    });
    assert.equal(status, 200);
    assert.equal(body.person.title, 'Full Professor');
    // The real regression this guards: a naive $set would wipe out person.name.
    assert.equal(body.person.name, 'Dr. Lily Chen', 'sibling field was clobbered by the patch');
    assert.equal(body.person.email, 'l.chen@mit.edu', 'sibling field was clobbered by the patch');
  });

  // --- Review gate --------------------------------------------------------
  await check('POST /leads/:id/review approves and records who decided', async () => {
    const { status, body } = await request(`/leads/${leadId}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', reviewedBy: 'smoke-test' }),
    });
    assert.equal(status, 200);
    assert.equal(body.status, 'approved');
    assert.equal(body.review.decision, 'approved');
    assert.equal(body.review.reviewedBy, 'smoke-test');
    assert.ok(body.review.reviewedAt);
  });

  // --- Validation ---------------------------------------------------------
  await check('POST /leads rejects a missing name with 400', async () => {
    const { status, body } = await request('/leads', {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody@example.com' }),
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'Validation failed');
  });

  await check('POST /leads rejects a malformed email with 400', async () => {
    const { status } = await request('/leads', {
      method: 'POST',
      body: JSON.stringify({ name: 'Someone', email: 'not-an-email' }),
    });
    assert.equal(status, 400);
  });

  await check('GET /leads/:id with an unknown id returns 404, not 500', async () => {
    const { status } = await request('/leads/507f1f77bcf86cd799439011');
    assert.equal(status, 404);
  });

  await check('GET /leads/:id with a malformed id returns 404, not 500', async () => {
    const { status } = await request('/leads/not-a-valid-object-id');
    assert.equal(status, 404);
  });

  // --- Catalog ------------------------------------------------------------
  await check('POST /api/catalog upserts and does not duplicate on re-run', async () => {
    const payload = {
      name: 'Portable Potentiostat',
      category: 'potentiostat_portable',
      applicationAreas: ['corrosion'],
      sdkSupport: ['python'],
    };
    await request('/catalog', { method: 'POST', body: JSON.stringify(payload) });
    await request('/catalog', { method: 'POST', body: JSON.stringify(payload) });

    const { body } = await request('/catalog');
    assert.equal(body.total, 1, 'upsert created a duplicate product');
    assert.equal(body.items[0].productId, 'portable-potentiostat', 'slug was not generated');
  });

  // --- Dashboard ----------------------------------------------------------
  await check('GET /dashboard reflects the activity above', async () => {
    const { status, body } = await request('/dashboard');
    assert.equal(status, 200);
    assert.equal(body.tiles.activeCustomers, 1, 'the approved lead should count as active');
    assert.equal(body.tiles.inProgressDiscoveries, 0);
    assert.equal(body.tiles.openThreads, 0);
    // Manual creation + approval should both have been logged.
    assert.ok(body.recentActivity.length >= 2, 'activity feed is missing entries');
    assert.ok(
      body.recentActivity.some((e: { type: string }) => e.type === 'lead_approved'),
      'approval was not logged to the activity feed',
    );
  });

  // --- Delete -------------------------------------------------------------
  await check('DELETE /leads/:id removes the record', async () => {
    const { status } = await request(`/leads/${leadId}`, { method: 'DELETE' });
    assert.equal(status, 204);
    const after = await request('/leads');
    assert.equal(after.body.total, 0);
  });

  // =========================================================================
  // Phase 2 — discovery pipeline
  //
  // Fake source adapters are injected so these run offline, deterministically,
  // and without touching a live API or spending anything. The orchestrator,
  // dedupe, enrichment, caching and storage are all the real code paths.
  // =========================================================================
  const { runDiscovery, dedupeWithinBatch } = await import(
    '../services/discovery/discoveryOrchestrator.js'
  );
  const { HeuristicProvider } = await import('../services/ai/heuristicProvider.js');
  const { computeContentHash, BudgetTracker, BudgetExceededError, isEnrichmentFresh } =
    await import('../services/ai/enrichmentService.js');

  const provider = new HeuristicProvider();

  /** Builds a candidate with sensible defaults so each test states only what it varies. */
  const candidate = (over: Record<string, any> = {}) => ({
    sourceType: 'openalex' as const,
    sourceRecordId: `rec-${Math.random().toString(36).slice(2)}`,
    name: 'Dr. Ada Voltmore',
    publications: [],
    grants: [],
    topics: [],
    evidenceText: '',
    ...over,
  });

  const emptySource = async () => ({ source: 'stub', candidates: [], errors: [] });
  const stubFetchers = (candidates: any[]) => ({
    openalex: async () => ({ source: 'openalex', candidates, errors: [] }),
    grants: emptySource,
    faculty: emptySource,
    news: emptySource,
  });

  console.log('\nPhase 2 — discovery:\n');

  await check('in-batch dedupe merges the same person from several sources', () => {
    const merged = dedupeWithinBatch([
      candidate({
        name: 'Dr. Ada Voltmore',
        institutionName: 'Cambridge University',
        publications: [{ title: 'Impedance study', year: 2024 }],
      }),
      // Same person via a grant award: different source, no email, name written
      // differently — this is the realistic duplicate the pipeline must catch.
      candidate({
        sourceType: 'grant_portal',
        name: 'Voltmore, Ada',
        institutionName: 'Cambridge University',
        title: 'Professor',
        grants: [{ title: 'Electrocatalysis grant', agency: 'NSF', amount: 500_000 }],
      }),
    ]);

    assert.equal(merged.length, 1, 'the same researcher was not merged');
    // The merge must keep data from BOTH records, not just the first seen.
    assert.equal(merged[0]!.title, 'Professor', 'field from the second source was lost');
    assert.equal(merged[0]!.publications.length, 1);
    assert.equal(merged[0]!.grants.length, 1);
  });

  await check('email beats name matching when institutions differ', () => {
    const merged = dedupeWithinBatch([
      candidate({ name: 'Ada Voltmore', email: 'a@uni.edu', institutionName: 'Cambridge' }),
      candidate({ name: 'A. Voltmore', email: 'a@uni.edu', institutionName: 'MIT' }),
    ]);
    assert.equal(merged.length, 1, 'matching emails should collapse regardless of institution');
  });

  await check('genuinely different people are not merged', () => {
    const merged = dedupeWithinBatch([
      candidate({ name: 'Ada Voltmore', institutionName: 'Cambridge' }),
      candidate({ name: 'Bob Ohmsley', institutionName: 'Cambridge' }),
    ]);
    assert.equal(merged.length, 2);
  });

  await check('discovery stores leads as pending_review, never auto-approved', async () => {
    const summary = await runDiscovery(
      { sources: ['openalex'] },
      {
        provider,
        fetchers: stubFetchers([
          candidate({
            name: 'Dr. Ada Voltmore',
            email: 'ada@cambridge.example',
            institutionName: 'Cambridge University',
            evidenceText:
              'Uses cyclic voltammetry and electrochemical impedance spectroscopy to study solid-state battery electrolyte interfaces with a potentiostat.',
            publications: [{ title: 'Impedance of solid electrolytes', year: 2024 }],
            topics: ['Electrochemistry'],
          }),
        ]),
      },
    );

    assert.equal(summary.leadsCreated, 1);
    assert.equal(summary.estimatedCostUsd, 0, 'the heuristic provider must be free');

    const { body } = await request('/leads?status=pending_review');
    assert.equal(body.total, 1, 'discovered lead is not awaiting review');
    assert.equal(body.items[0].source.type, 'openalex');
  });

  await check('a strongly on-topic lead scores well above an off-topic one', async () => {
    const onTopic = await provider.enrich({
      candidate: candidate({
        evidenceText:
          'Cyclic voltammetry and electrochemical impedance spectroscopy with a potentiostat to characterise battery electrodes and electrocatalysis.',
      }),
      catalog: [],
    });
    const offTopic = await provider.enrich({
      candidate: candidate({
        evidenceText: 'Medieval French poetry and its influence on modern literature.',
      }),
      catalog: [],
    });

    assert.ok(
      onTopic.relevanceScore > offTopic.relevanceScore + 25,
      `expected a clear gap, got ${onTopic.relevanceScore} vs ${offTopic.relevanceScore}`,
    );
    assert.ok(offTopic.relevanceScore < 40, 'an irrelevant researcher scored too high');
  });

  await check('product mapping only ever returns real catalog ids', async () => {
    const catalogResponse = await request('/catalog');
    const result = await provider.enrich({
      candidate: candidate({
        evidenceText: 'Corrosion studies of steel alloys using electrochemical methods.',
      }),
      catalog: catalogResponse.body.items,
    });

    const validIds = new Set(catalogResponse.body.items.map((p: any) => p.productId));
    for (const id of result.recommendedProductIds) {
      assert.ok(validIds.has(id), `recommended a product id that does not exist: ${id}`);
    }
    assert.ok(
      result.recommendedProductIds.includes('portable-potentiostat'),
      'a corrosion researcher should map to the corrosion-tagged product',
    );
  });

  await check('re-running discovery does not duplicate an existing lead', async () => {
    const before = await request('/leads');

    const summary = await runDiscovery(
      { sources: ['openalex'] },
      {
        provider,
        fetchers: stubFetchers([
          candidate({
            name: 'Ada Voltmore',
            email: 'ada@cambridge.example',
            institutionName: 'Cambridge University',
            evidenceText: 'Electrochemical impedance spectroscopy of battery interfaces.',
            publications: [{ title: 'Impedance of solid electrolytes', year: 2024 }],
            topics: ['Electrochemistry'],
          }),
        ]),
      },
    );

    assert.equal(summary.leadsCreated, 0, 'a known researcher was inserted again');
    assert.equal(summary.duplicatesSkipped, 1);

    const after = await request('/leads');
    assert.equal(after.body.total, before.body.total, 'lead count changed on a repeat run');
  });

  await check('unchanged source material skips re-enrichment (the cost saver)', () => {
    const sample = candidate({
      publications: [{ title: 'Impedance of solid electrolytes', year: 2024, sourceId: 'W1' }],
      topics: ['Electrochemistry'],
    });
    const hash = computeContentHash(sample);

    const scoredLead = {
      research: { contentHash: hash },
      aiScoring: { scoredAt: new Date() },
    } as any;
    assert.equal(isEnrichmentFresh(scoredLead, hash), true, 'fresh enrichment was not reused');

    // A new publication changes the hash, which must force a re-score.
    const withNewPaper = candidate({
      publications: [
        { title: 'Impedance of solid electrolytes', year: 2024, sourceId: 'W1' },
        { title: 'A brand new paper', year: 2025, sourceId: 'W2' },
      ],
      topics: ['Electrochemistry'],
    });
    assert.notEqual(
      computeContentHash(withNewPaper),
      hash,
      'new source material did not invalidate the cache',
    );

    const stale = {
      research: { contentHash: hash },
      aiScoring: { scoredAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
    } as any;
    assert.equal(isEnrichmentFresh(stale, hash), false, 'a 40-day-old score was treated as fresh');
  });

  await check('the budget tracker refuses to exceed its ceiling', () => {
    const budget = new BudgetTracker(0.05);
    budget.assertWithinBudget(); // Fresh tracker: fine.
    budget.record(0.06);
    assert.throws(() => budget.assertWithinBudget(), BudgetExceededError);
  });

  await check('one failing source does not abort the whole run', async () => {
    const summary = await runDiscovery(
      { sources: ['openalex', 'nih'] },
      {
        provider,
        fetchers: {
          openalex: async () => ({
            source: 'openalex',
            candidates: [
              candidate({
                name: 'Grace Faraday',
                institutionName: 'ETH Zurich',
                evidenceText: 'Spectroelectrochemistry and voltammetry of catalytic surfaces.',
              }),
            ],
            errors: [],
          }),
          // This is the realistic failure: a live API is down mid-run.
          grants: async () => {
            throw new Error('NIH API unreachable');
          },
          faculty: emptySource,
          news: emptySource,
        },
      },
    );

    assert.equal(summary.leadsCreated, 1, 'the healthy source should still have produced a lead');
    assert.ok(summary.errors.length > 0, 'the failing source was not reported');
    assert.ok(
      summary.errors.some((e) => e.includes('NIH')),
      'the error message lost which source failed',
    );
  });

  await check('skipEnrichment stores leads without scoring them', async () => {
    const summary = await runDiscovery(
      { sources: ['openalex'], skipEnrichment: true },
      {
        provider,
        fetchers: stubFetchers([
          candidate({ name: 'Unscored Person', institutionName: 'Somewhere Poly' }),
        ]),
      },
    );

    assert.equal(summary.leadsCreated, 1);
    assert.equal(summary.enrichedCount, 0, 'enrichment ran despite skipEnrichment');

    const { body } = await request('/leads?search=Unscored');
    assert.equal(body.items[0].aiScoring.relevanceScore, undefined);
  });

  await check('GET /discovery/config reports the active provider', async () => {
    const { status, body } = await request('/discovery/config');
    assert.equal(status, 200);
    // No key is set in the test environment, so the free heuristic must be chosen
    // rather than the app crashing or silently trying to bill.
    assert.equal(body.aiProvider.billable, false);
    assert.ok(Array.isArray(body.defaultQueries) && body.defaultQueries.length > 0);
  });

  await check('POST /discovery/run rejects an unknown source with 400', async () => {
    const { status } = await request('/discovery/run', {
      method: 'POST',
      body: JSON.stringify({ sources: ['not-a-real-source'] }),
    });
    assert.equal(status, 400);
  });

  await check('POST /discovery/by-name rejects a too-short name', async () => {
    const { status } = await request('/discovery/by-name', {
      method: 'POST',
      body: JSON.stringify({ name: 'ab' }),
    });
    assert.equal(status, 400);
  });

  // --- Indian institution targeting ---------------------------------------
  const { INDIAN_INSTITUTIONS, institutionIdsFor, institutionCounts } = await import(
    '../data/indianInstitutions.js'
  );

  await check('the institution list covers all 23 IITs plus NITs and IIITs', () => {
    const counts = institutionCounts();
    assert.equal(counts.IIT, 23, 'India has 23 IITs; the list is incomplete');
    assert.ok(counts.NIT >= 28, `expected at least 28 NITs, got ${counts.NIT}`);
    assert.ok(counts.IIIT >= 20, `expected at least 20 IIITs, got ${counts.IIIT}`);
  });

  await check('every institution has a well-formed, unique OpenAlex id', () => {
    const ids = new Set<string>();
    for (const institution of INDIAN_INSTITUTIONS) {
      assert.match(
        institution.openAlexId,
        /^I\d+$/,
        `malformed id for ${institution.name}: ${institution.openAlexId}`,
      );
      assert.ok(!ids.has(institution.openAlexId), `duplicate id: ${institution.openAlexId}`);
      ids.add(institution.openAlexId);
    }
    assert.equal(ids.size, INDIAN_INSTITUTIONS.length);
  });

  await check('institutionIdsFor filters by kind, and defaults to all', () => {
    const iits = institutionIdsFor(['IIT']);
    assert.equal(iits.length, 23);

    const both = institutionIdsFor(['IIT', 'NIT']);
    assert.equal(both.length, 23 + institutionCounts().NIT);

    assert.equal(institutionIdsFor().length, INDIAN_INSTITUTIONS.length, 'no filter should mean all');
    assert.equal(institutionIdsFor([]).length, INDIAN_INSTITUTIONS.length, 'empty filter should mean all');
  });

  await check('an India-targeted run drops the US-only grant sources', async () => {
    let grantsWereCalled = false;
    const summary = await runDiscovery(
      // No explicit `sources`, so the default set for this region applies.
      { region: 'indian_institutes' },
      {
        provider,
        fetchers: {
          openalex: async () => ({ source: 'openalex', candidates: [], errors: [] }),
          grants: async () => {
            grantsWereCalled = true;
            return { source: 'grants', candidates: [], errors: [] };
          },
          faculty: emptySource,
          news: emptySource,
        },
      },
    );

    assert.equal(grantsWereCalled, false, 'NIH/NSF ran despite an India-targeted run');
    assert.ok(!summary.sourcesRun.includes('nih'));
    assert.ok(!summary.sourcesRun.includes('nsf'));
  });

  await check('a global run still includes the grant sources', async () => {
    let grantsWereCalled = false;
    await runDiscovery(
      { region: 'global' },
      {
        provider,
        fetchers: {
          openalex: async () => ({ source: 'openalex', candidates: [], errors: [] }),
          grants: async () => {
            grantsWereCalled = true;
            return { source: 'grants', candidates: [], errors: [] };
          },
          faculty: emptySource,
          news: emptySource,
        },
      },
    );
    assert.equal(grantsWereCalled, true, 'a global run should still query NIH/NSF');
  });

  await check('the targeting choice is passed through to the OpenAlex adapter', async () => {
    let received: { region?: string; institutionKinds?: string[] } | undefined;
    await runDiscovery(
      { region: 'indian_institutes', institutionKinds: ['IIT'], sources: ['openalex'] },
      {
        provider,
        fetchers: {
          openalex: async (_q: string[], _y: number, targeting?: OpenAlexTargeting) => {
            received = targeting;
            return { source: 'openalex', candidates: [], errors: [] };
          },
          grants: emptySource,
          faculty: emptySource,
          news: emptySource,
        },
      },
    );

    assert.equal(received?.region, 'indian_institutes');
    assert.deepEqual(received?.institutionKinds, ['IIT']);
  });

  await check('POST /discovery/run rejects an invalid region', async () => {
    const { status } = await request('/discovery/run', {
      method: 'POST',
      body: JSON.stringify({ region: 'atlantis' }),
    });
    assert.equal(status, 400);
  });

  await check('GET /discovery/institutions lists and filters institutions', async () => {
    const all = await request('/discovery/institutions');
    assert.equal(all.status, 200);
    assert.equal(all.body.total, INDIAN_INSTITUTIONS.length);
    // Sorted by research output, so the biggest institutes surface first.
    assert.ok(all.body.items[0].worksCount >= all.body.items[1].worksCount);

    const iits = await request('/discovery/institutions?kind=IIT');
    assert.equal(iits.body.total, 23);
    assert.ok(iits.body.items.every((i: { kind: string }) => i.kind === 'IIT'));
  });

  // --- Settings -----------------------------------------------------------
  console.log('\nSettings:\n');

  await check('GET /settings seeds from the files on first read', async () => {
    const { status, body } = await request('/settings');
    assert.equal(status, 200);
    // `queries` is the ADDITIONAL-keywords list and is empty by design; the
    // searched set is derived from the catalog (asserted below).
    assert.deepEqual(body.discovery.queries, [], 'additional keywords should start empty');
    assert.ok(body.facultyTargets.length > 0, 'faculty targets were not seeded');
    // Disabled entries are kept so the UI can show them with their reason.
    assert.ok(
      body.facultyTargets.some((t: { enabled: boolean }) => !t.enabled),
      'known-broken targets should be retained, disabled',
    );
    assert.ok(body.institutions.total >= 70, 'institution list missing from the response');
  });

  console.log('\nAffiliation check — is the lead still at the institute?\n');

  const { assessAffiliation, verifyLeadAffiliation, affiliationIsStale } = await import(
    '../services/leads/affiliationService.js'
  );
  const IITB = { id: 'I162827531', name: 'Indian Institute of Technology Bombay', country: 'IN' };
  const IISC = { id: 'I4210', name: 'Indian Institute of Science', country: 'IN' };
  const NUS = { id: 'I165932596', name: 'National University of Singapore', country: 'SG' };
  const NOW = new Date('2026-09-19');
  const atIITB = { institutionName: IITB.name, institutionOpenAlexId: IITB.id };

  await check('still named on the latest work → current', async () => {
    const a = assessAffiliation(atIITB, {
      authorId: 'A1',
      lastKnown: [IITB],
      affiliations: [{ ...IITB, years: [2026, 2025, 2024] }],
    }, NOW);
    assert.equal(a.status, 'current');
    assert.equal(a.institution.name, IITB.name);
    assert.equal(a.affiliation.lastSeenYear, 2026);
  });

  await check('latest work elsewhere, newer than anything from ours → moved, new institute shown', async () => {
    const a = assessAffiliation(atIITB, {
      authorId: 'A1',
      lastKnown: [NUS],
      affiliations: [{ ...NUS, years: [2026] }, { ...IITB, years: [2025, 2024, 2023] }],
    }, NOW);
    assert.equal(a.status, 'moved');
    assert.equal(a.institution.name, NUS.name);
    assert.equal(a.institution.openAlexId, NUS.id);
    assert.equal(a.affiliation.previousInstitution, IITB.name);
    assert.match(a.affiliation.note ?? '', /2026.*National University of Singapore.*2025/);
  });

  await check('a concurrent second affiliation with the same latest year is NOT a move', async () => {
    const a = assessAffiliation(atIITB, {
      authorId: 'A1',
      lastKnown: [IISC],
      affiliations: [{ ...IISC, years: [2025] }, { ...IITB, years: [2025, 2024] }],
    }, NOW);
    assert.equal(a.status, 'current');
    assert.equal(a.institution.name, IITB.name);
    assert.match(a.affiliation.note ?? '', /Also affiliated with Indian Institute of Science/);
  });

  await check('no last-known institution but recent output from ours → current', async () => {
    const a = assessAffiliation(atIITB, {
      authorId: 'A1',
      lastKnown: [],
      affiliations: [{ ...IITB, years: [2024] }],
    }, NOW);
    assert.equal(a.status, 'current');
  });

  await check('no last-known institution and nothing recent → unknown, institution BLANK', async () => {
    const a = assessAffiliation(atIITB, {
      authorId: 'A1',
      lastKnown: [],
      affiliations: [{ ...IITB, years: [2021, 2020] }],
    }, NOW);
    assert.equal(a.status, 'unknown');
    assert.equal(a.institution.name, undefined);
    assert.equal(a.affiliation.previousInstitution, IITB.name);
    assert.equal(a.affiliation.lastSeenYear, 2021);
  });

  await check('matches by name when the lead has no institution id', async () => {
    const a = assessAffiliation({ institutionName: 'IIT Bombay' }, {
      authorId: 'A1',
      lastKnown: [IITB],
      affiliations: [{ ...IITB, years: [2026] }],
    }, NOW);
    assert.equal(a.status, 'current');
  });

  // A lead that OpenAlex says has moved: the institution must actually change
  // in the database, and the old one be kept as previousInstitution.
  const moverId = (
    await request('/leads', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Test Mover',
        institutionName: IITB.name,
        department: 'Department of Chemistry',
        profileUrl: 'https://openalex.org/A5000000001',
      }),
    })
  ).body.lead.id as string;

  await check('verifyLeadAffiliation writes the move: new institute, department cleared, old kept', async () => {
    const { lead, assessment } = await verifyLeadAffiliation(moverId, {
      fetchAffiliations: async () => ({
        authorId: 'A5000000001',
        lastKnown: [NUS],
        affiliations: [{ ...NUS, years: [2026] }, { ...IITB, years: [2025] }],
      }),
    });
    assert.equal(assessment?.status, 'moved');
    assert.equal(lead.institution.name, NUS.name);
    assert.equal(lead.institution.openAlexId, NUS.id);
    assert.equal(lead.institution.department, undefined, 'department should not follow a move');
    assert.equal(lead.institution.affiliation?.previousInstitution, IITB.name);
    assert.ok(!affiliationIsStale(lead), 'a fresh check must not read as stale');
  });

  await check('verifyLeadAffiliation BLANKS an institution that cannot be confirmed', async () => {
    const { lead, assessment } = await verifyLeadAffiliation(moverId, {
      fetchAffiliations: async () => ({
        authorId: 'A5000000001',
        lastKnown: [],
        affiliations: [{ ...NUS, years: [2020] }],
      }),
    });
    assert.equal(assessment?.status, 'unknown');
    assert.equal(lead.institution.name, undefined, 'institution should be blank');
    assert.equal(lead.institution.normalizedNameKey, undefined);
    // The previous institute is the one we were just at (NUS), kept for the record.
    assert.equal(lead.institution.affiliation?.previousInstitution, NUS.name);
    const fetched = (await request(`/leads/${moverId}`)).body;
    assert.equal(fetched.institution.name, undefined, 'blank must persist, not just be returned');
  });

  await check('a lead with no OpenAlex author id is refused with a clear message', async () => {
    const manualId = (
      await request('/leads', { method: 'POST', body: JSON.stringify({ name: 'No Record Person' }) })
    ).body.lead.id as string;
    const { status, body } = await request(`/leads/${manualId}/verify-affiliation`, { method: 'POST' });
    assert.equal(status, 400);
    assert.match(body.error, /no OpenAlex author record/i);
  });

  await check('a discovery run verifies each new lead and blanks a mover it cannot place', async () => {
    const candidate = {
      sourceType: 'openalex' as const,
      sourceRecordId: 'https://openalex.org/A5000000777',
      profileUrl: 'https://openalex.org/A5000000777',
      name: 'Gone Elsewhere',
      institutionName: IITB.name,
      institutionOpenAlexId: IITB.id,
      country: 'IN',
      publications: [{ title: 'Old paper on electrochemical sensors', year: 2022, sourceId: 'https://openalex.org/W7' }],
      grants: [],
      topics: ['Electrochemical sensors and biosensors'],
      evidenceText: 'Old paper on electrochemical sensors using a potentiostat.',
    };
    const summary = await runDiscovery(
      { sources: ['openalex'], skipEnrichment: true, verifyAffiliations: true },
      {
        provider,
        fetchers: {
          openalex: async () => ({ source: 'openalex', candidates: [candidate], errors: [] }),
          grants: emptySource,
          faculty: emptySource,
          news: emptySource,
          affiliations: async () => ({
            authorId: 'A5000000777',
            lastKnown: [],
            affiliations: [{ ...IITB, years: [2022, 2021] }],
          }),
        },
      },
    );
    assert.equal(summary.leadsCreated, 1);
    assert.equal(summary.affiliationChanges, 1);
    const { body } = await request('/leads?search=Gone%20Elsewhere');
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].institution.name, undefined, 'mover was still shown at the institute');
    assert.equal(body.items[0].institution.affiliation.status, 'unknown');
    assert.equal(body.items[0].institution.affiliation.previousInstitution, IITB.name);
  });

  await check('POST /leads/verify-affiliations tallies results and skips leads without a record', async () => {
    const { status, body } = await request('/leads/verify-affiliations', {
      method: 'POST',
      body: JSON.stringify({ limit: 50 }),
    });
    assert.equal(status, 200);
    // Live lookups are impossible here (no network), so every lead with an id
    // is counted as skipped — the point is the endpoint works and never throws.
    assert.equal(typeof body.checked, 'number');
    assert.ok(body.skipped >= 1);
  });

  console.log('\nWeb enrichment (profile, lab site, papers) — all dependencies injected:\n');

  const { enrichLeadFromWeb } = await import('../services/leads/webEnrichment.js');
  const { repositories } = await import('../repositories/index.js');

  const enrichLeadId = (
    await request('/leads', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Asha Rao',
        institutionName: 'Indian Institute of Technology Bombay',
        // A title a human typed must survive enrichment untouched.
        title: 'Chair Professor',
      }),
    })
  ).body.lead.id as string;
  // Give the lead a paper with an OpenAlex work id so the paper path runs.
  await repositories.leads.updateById(enrichLeadId, {
    research: {
      recentPublications: [{ title: 'A wearable sweat lactate sensor', year: 2024, sourceId: 'https://openalex.org/W111' }],
    },
  });

  const fakeScrape = async () => ({
    job_id: 'x',
    profile_url: 'https://www.iitb.ac.in/people/asha-rao',
    email: 'asha.rao@iitb.ac.in',
    phone: '+91 22 2576 7890',
    designation: 'Professor',
    department: 'Department of Chemistry',
    websites: ['https://raolab.example.org/'],
    snippets: [
      { url: 'https://raolab.example.org/facilities', text: 'Autolab PGSTAT302N potentiostat/galvanostat (Metrohm) and a CHI 660E workstation.' },
      { url: 'https://raolab.example.org/', text: 'We develop screen-printed electrode sensors.' },
    ],
    pages_visited: ['https://www.iitb.ac.in/faculty', 'https://www.iitb.ac.in/people/asha-rao', 'https://raolab.example.org/', 'https://raolab.example.org/facilities'],
    errors: [],
  });
  const fakeResolve = async (workId: string) => ({
    workId: workId.split('/').pop()!,
    title: 'A wearable sweat lactate sensor',
    isOpenAccess: true,
    pdfUrl: 'https://repo.example.org/paper.pdf',
  });
  const fakeRead = async () => ({
    job_id: 'y',
    results: [
      {
        id: 'W111',
        url: 'https://repo.example.org/paper.pdf',
        kind: 'pdf' as const,
        chars: 12000,
        snippets: ['All measurements were performed using an EmStat Pico potentiostat (PalmSens BV).'],
      },
    ],
    errors: [],
  });

  await check('web enrichment records the directory signal on the affiliation', async () => {
    const dirLeadId = (
      await request('/leads', {
        method: 'POST',
        body: JSON.stringify({ name: 'Listed Person', institutionName: IITB.name, profileUrl: 'https://openalex.org/A5000000002' }),
      })
    ).body.lead.id as string;
    const listed = await enrichLeadFromWeb(dirLeadId, {
      scrapeLead: async () => ({
        job_id: 'd', directory_checked: true, directory_listed: true, profile_url: 'https://www.iitb.ac.in/people/lp',
        email: null, phone: null, designation: null, department: null, websites: [], snippets: [], pages_visited: ['x'], errors: [],
      }),
      readPapers: async () => ({ job_id: 'd', results: [], errors: [] }),
      resolveOpenAccess: async () => null,
      scraperUp: async () => true,
    });
    assert.deepEqual(listed.affiliation, { directoryListed: true });
    assert.equal(listed.lead.institution.affiliation?.status, 'current');
    assert.equal(listed.lead.institution.affiliation?.source, 'directory');

    const dropped = await enrichLeadFromWeb(dirLeadId, {
      scrapeLead: async () => ({
        job_id: 'd', directory_checked: true, directory_listed: false, profile_url: null,
        email: null, phone: null, designation: null, department: null, websites: [], snippets: [], pages_visited: ['x'], errors: [],
      }),
      readPapers: async () => ({ job_id: 'd', results: [], errors: [] }),
      resolveOpenAccess: async () => null,
      scraperUp: async () => true,
    });
    assert.deepEqual(dropped.affiliation, { directoryListed: false });
    assert.equal(dropped.lead.institution.affiliation?.directoryListed, false);
    assert.match(dropped.lead.institution.affiliation?.note ?? '', /Not found in the institute faculty directory/);
    // Not overridden on the directory alone — the institute stays until OpenAlex agrees.
    assert.equal(dropped.lead.institution.name, IITB.name);
  });

  await check('fills email, phone, department and website; never overwrites a set title', async () => {
    const result = await enrichLeadFromWeb(enrichLeadId, {
      scrapeLead: fakeScrape,
      readPapers: fakeRead,
      resolveOpenAccess: fakeResolve,
      scraperUp: async () => true,
    });
    assert.deepEqual([...result.filled].sort(), ['department', 'email', 'phone', 'websiteUrl']);
    assert.equal(result.lead.person.email, 'asha.rao@iitb.ac.in');
    assert.equal(result.lead.person.title, 'Chair Professor', 'a human-entered title was overwritten');
    assert.equal(result.lead.person.phone, '+91 22 2576 7890');
    assert.equal(result.lead.person.websiteUrl, 'https://raolab.example.org/');
    assert.equal(result.lead.institution.department, 'Department of Chemistry');
    assert.equal(result.lead.person.profileUrl, 'https://www.iitb.ac.in/people/asha-rao');
    assert.ok(result.lead.research.webEnrichedAt, 'webEnrichedAt not stamped');
  });

  await check('instruments from the lab page and the paper are detected and merged', async () => {
    const lead = await repositories.leads.findById(enrichLeadId);
    const labels = lead!.research.instruments.map((i) => `${i.brandKey}:${i.model ?? ''}`).sort();
    assert.deepEqual(labels, ['autolab:PGSTAT302N', 'chi:CHI 660E', 'palmsens:EmStat Pico']);
    const pico = lead!.research.instruments.find((i) => i.model === 'EmStat Pico')!;
    assert.match(pico.evidence, /^Methods of “A wearable sweat lactate sensor”/);
    assert.equal(pico.sourceUrl, 'https://repo.example.org/paper.pdf');
    const autolab = lead!.research.instruments.find((i) => i.model === 'PGSTAT302N')!;
    assert.match(autolab.evidence, /^Lab facilities page/);
  });

  await check('a second pass does not duplicate instruments or refill fields', async () => {
    const result = await enrichLeadFromWeb(enrichLeadId, {
      scrapeLead: fakeScrape,
      readPapers: fakeRead,
      resolveOpenAccess: fakeResolve,
      scraperUp: async () => true,
    });
    assert.deepEqual(result.filled, []);
    assert.equal(result.lead.research.instruments.length, 3);
  });

  await check('papers that are not open access are never sent to the scraper', async () => {
    let sent = 0;
    await enrichLeadFromWeb(enrichLeadId, {
      scrapeLead: fakeScrape,
      readPapers: async (p) => {
        sent += p.papers.length;
        return { job_id: 'z', results: [], errors: [] };
      },
      resolveOpenAccess: async (workId) => ({ workId, isOpenAccess: false }),
      scraperUp: async () => true,
    });
    assert.equal(sent, 0);
  });

  await check('POST /leads/:id/enrich-web returns 503 with a clear message when the scraper is down', async () => {
    const { status, body } = await request(`/leads/${enrichLeadId}/enrich-web`, { method: 'POST' });
    assert.equal(status, 503);
    assert.match(body.error, /scraper service is not running/i);
  });

  await check('POST /leads/enrich-web-bulk stops at the first scraper-down error', async () => {
    const { status, body } = await request('/leads/enrich-web-bulk', {
      method: 'POST',
      body: JSON.stringify({ ids: [enrichLeadId, enrichLeadId] }),
    });
    assert.equal(status, 200);
    assert.equal(body.results.length, 1, 'should stop after the first 503');
    assert.match(body.results[0].error, /scraper service/i);
  });

  await check('the keyword set is derived from the product catalog', async () => {
    const { body } = await request('/discovery/config');

    const byKey = Object.fromEntries(
      body.keywordSearch.groups.map((g: { key: string }) => [g.key, g]),
    );
    for (const key of ['subject_nouns', 'application_areas', 'product_keywords', 'product_names', 'brand_names']) {
      assert.ok(byKey[key], `keyword group "${key}" is missing`);
      assert.ok(byKey[key].count > 0, `keyword group "${key}" is empty`);
    }

    // Model names and brands are carried by the full-text brand search, so they
    // must never be spent as title/abstract keyword queries as well.
    assert.equal(byKey.product_names.searchedAs, 'fulltext');
    assert.equal(byKey.brand_names.searchedAs, 'fulltext');
    assert.ok(
      byKey.product_names.phrases.includes('PalmSens4'),
      'catalog model names are missing from the derived set',
    );

    const searched: string[] = body.defaultQueries;
    assert.ok(searched.length > 50, `expected a substantial keyword set, got ${searched.length}`);
    assert.ok(
      !searched.some((p) => /palmsens|emstat|^cs\d/i.test(p)),
      'model names should not be spent as keyword queries',
    );
  });

  await check('PATCH /settings persists a change', async () => {
    const patched = await request('/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        discovery: { queries: ['solid-state electrolyte'], disabledKeywordGroups: ['product_keywords'] },
      }),
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body.discovery.queries, ['solid-state electrolyte']);

    const reread = await request('/settings');
    assert.deepEqual(
      reread.body.discovery.disabledKeywordGroups,
      ['product_keywords'],
      'the change did not persist',
    );
  });

  await check('saved settings govern a run that passes no options', async () => {
    let seenQueries: string[] = [];

    await runDiscovery(
      // Deliberately empty: this is what the cron job does.
      {},
      {
        provider,
        fetchers: {
          openalex: async (queries) => {
            seenQueries = queries;
            return { source: 'openalex', candidates: [], errors: [] };
          },
          grants: emptySource,
          faculty: emptySource,
          news: emptySource,
        },
      },
    );

    // The derived set plus the extra keyword just saved, and nothing from the
    // group that was switched off.
    assert.ok(seenQueries.includes('solid-state electrolyte'), 'saved extra keyword was ignored');
    assert.ok(seenQueries.includes('cyclic voltammetry'), 'derived subject terms are missing');
    assert.ok(seenQueries.length > 50, `expected the derived keyword set, got ${seenQueries.length}`);
  });

  await check('explicit run options still override saved settings', async () => {
    let seenQueries: string[] = [];
    await runDiscovery(
      { queries: ['one-off query'], sources: ['openalex'] },
      {
        provider,
        fetchers: {
          openalex: async (queries) => {
            seenQueries = queries;
            return { source: 'openalex', candidates: [], errors: [] };
          },
          grants: emptySource,
          faculty: emptySource,
          news: emptySource,
        },
      },
    );
    assert.deepEqual(seenQueries, ['one-off query']);
  });

  await check('disabling an institution removes it from the search set', async () => {
    const { getActiveInstitutionIds } = await import('../services/settings/settingsService.js');

    const before = await getActiveInstitutionIds(['IIT']);
    assert.equal(before.length, 23);

    // IIT Bombay.
    await request('/settings', {
      method: 'PATCH',
      body: JSON.stringify({ discovery: { disabledInstitutionIds: ['I162827531'] } }),
    });

    const after = await getActiveInstitutionIds(['IIT']);
    assert.equal(after.length, 22, 'the disabled institution was still searched');
    assert.ok(!after.includes('I162827531'));
  });

  await check('POST /settings/targets adds a source and rejects a duplicate URL', async () => {
    const payload = {
      kind: 'faculty',
      universityName: 'Test Institute of Technology',
      url: 'https://test.example.ac.in/faculty',
      enabled: true,
    };

    const added = await request('/settings/targets', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    assert.equal(added.status, 201);
    const target = added.body.facultyTargets.find(
      (t: { url: string }) => t.url === payload.url,
    );
    assert.ok(target, 'the new target is missing');
    assert.ok(target.targetId, 'the new target has no id');

    const duplicate = await request('/settings/targets', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    assert.equal(duplicate.status, 400, 'a duplicate URL should be rejected');

    const removed = await request(`/settings/targets/${target.targetId}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.ok(
      !removed.body.facultyTargets.some((t: { url: string }) => t.url === payload.url),
      'the target was not removed',
    );
  });

  await check('POST /settings rejects a malformed URL', async () => {
    const { status } = await request('/settings/targets', {
      method: 'POST',
      body: JSON.stringify({ kind: 'faculty', universityName: 'X', url: 'not-a-url' }),
    });
    assert.equal(status, 400);
  });

  await check('POST /settings/reset restores the seed values', async () => {
    const { status, body } = await request('/settings/reset', { method: 'POST' });
    assert.equal(status, 200);
    assert.notDeepEqual(body.discovery.queries, ['solid-state electrolyte']);
    assert.deepEqual(body.discovery.disabledInstitutionIds, []);
    assert.deepEqual(body.discovery.disabledKeywordGroups, []);
  });

  await check('the run is recorded in the activity feed as one rollup entry', async () => {
    const { body } = await request('/dashboard');
    const runEntries = body.recentActivity.filter(
      (e: { type: string }) => e.type === 'discovery_run_completed',
    );
    assert.ok(runEntries.length > 0, 'no discovery run was logged');
    assert.ok(
      /Discovery run complete/.test(runEntries[0].message),
      'the rollup message is not human-readable',
    );
  });

  // --- Teardown -----------------------------------------------------------
  server.close();
  await disconnectDatabase();
  await mongo.stop();
  // The scraper-availability probe leaves a pending fetch when the Python
  // service is down; without an explicit exit the process lingers on its timer.

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
