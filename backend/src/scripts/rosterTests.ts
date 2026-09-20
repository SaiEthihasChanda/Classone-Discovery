/**
 * Faculty roster tests — run from the smoke test, all external calls injected.
 *
 * Covers the classifiers (role, domain, name matching), the build merge across
 * OpenAlex/ORCID/faculty pages, verification precedence, scoring, promotion
 * into the CRM, filling from ORCID, CSV import and the HTTP surface.
 */
import assert from 'node:assert/strict';

type Check = (name: string, fn: () => Promise<void> | void) => Promise<void>;
type Request = (path: string, init?: RequestInit) => Promise<{ status: number; body: any }>;

export async function runRosterTests(check: Check, request: Request): Promise<void> {
  const { classifyRole, inferSeniority, strongerRole } = await import('../services/roster/roles.js');
  const { decideDomain, domainFromTopics } = await import('../services/roster/domains.js');
  const { nameKeys, NameIndex } = await import('../services/roster/names.js');
  const { buildRoster, importRoster, shortInstitutionNames, DEPARTMENT_HINTS } = await import('../services/roster/rosterBuilder.js');
  const { verifyRoster } = await import('../services/roster/rosterAffiliation.js');
  const { scoreRoster, promoteRoster } = await import('../services/roster/rosterRelevance.js');
  const { fillRoster, missingFields } = await import('../services/roster/rosterFill.js');
  const { startJob, getJob, resetJobs } = await import('../services/jobs/jobRunner.js');
  const { HeuristicProvider } = await import('../services/ai/heuristicProvider.js');
  const { repositories } = await import('../repositories/index.js');
  const { parseCsv, rowsFromCsv } = await import('../routes/roster.routes.js');

  console.log('\nFaculty roster — classifiers:\n');

  await check('classifyRole keeps professors, scientists, officers and faculty fellowships', () => {
    assert.equal(classifyRole('Professor').category, 'professor');
    assert.equal(classifyRole('Assistant Professor (Grade I)').category, 'professor');
    assert.equal(classifyRole('Professor Emeritus').category, 'professor');
    assert.equal(classifyRole('Head of Department').category, 'professor');
    assert.equal(classifyRole('Senior Scientist').category, 'scientist');
    assert.equal(classifyRole('Scientific Officer').category, 'officer');
    assert.equal(classifyRole('Lab In-charge').category, 'officer');
    assert.equal(classifyRole('INSPIRE Faculty Fellow').category, 'fellow');
    assert.equal(classifyRole('Ramanujan Fellow').category, 'fellow');
  });

  await check('classifyRole drops students, postdocs, project staff and adjunct/visiting appointments', () => {
    for (const t of ['PhD Student', 'Ph.D. Scholar', 'Research Scholar', 'Postdoctoral Fellow', 'Post-doctoral Research Scientist', 'Senior Research Fellow', 'JRF', 'Project Assistant', 'Project Research Scientist', 'Research Associate', 'M.Tech student', 'National Post-Doctoral Fellow']) {
      assert.equal(classifyRole(t).category, 'excluded', `"${t}" should be excluded`);
    }
    for (const t of ['Adjunct Professor', 'Visiting Professor', 'Guest Faculty', 'Honorary Professor', 'Former Professor', 'Retired Professor']) {
      assert.equal(classifyRole(t).category, 'excluded', `"${t}" should be excluded`);
    }
    assert.equal(classifyRole('').category, 'unknown');
    assert.equal(classifyRole('Fellow').category, 'unknown', 'a bare "Fellow" is ambiguous');
  });

  await check('a stated exclusion beats an inferred role; a stated title beats an inference', () => {
    assert.equal(strongerRole({ category: 'inferred' }, { category: 'excluded' }).category, 'excluded');
    assert.equal(strongerRole({ category: 'inferred' }, { category: 'professor' }).category, 'professor');
    assert.equal(strongerRole({ category: 'professor' }, { category: 'unknown' }).category, 'professor');
    assert.equal(strongerRole({ category: 'professor', source: 'faculty_page' }, { category: 'excluded', source: 'orcid' }).category, 'professor', 'a faculty-page title beats a stale ORCID exclusion');
    assert.equal(strongerRole({ category: 'professor', source: 'orcid' }, { category: 'excluded', source: 'faculty_page' }).category, 'excluded', 'an exclusion from the page itself wins');
    assert.equal(decideDomain({ department: 'BSBE' }).domain, 'biology');
    assert.equal(decideDomain({ department: 'MEMS' }).domain, 'materials');
  });

  await check('inferSeniority needs output, an h-index, an 8-year span and recent activity', () => {
    const now = new Date('2026-09-19');
    const here = { yearsAtInstitute: [2019, 2021, 2023, 2025, 2026], name: 'Kavita Rao' };
    assert.equal(inferSeniority({ worksCount: 60, hIndex: 20, firstPublicationYear: 2010, lastPublicationYear: 2026, ...here }, now).senior, true);
    assert.equal(inferSeniority({ worksCount: 20, hIndex: 9, firstPublicationYear: 2021, lastPublicationYear: 2026, ...here }, now).senior, false, 'a productive PhD student is not senior');
    assert.equal(inferSeniority({ worksCount: 60, hIndex: 20, firstPublicationYear: 2005, lastPublicationYear: 2019, ...here }, now).senior, false, 'not recently active');
    assert.equal(inferSeniority({ worksCount: 60, hIndex: 20, firstPublicationYear: 2010, lastPublicationYear: 2026, yearsAtInstitute: [2025, 2026], name: 'Kavita Rao' }, now).senior, false, 'only two years at the institute');
    assert.equal(inferSeniority({ worksCount: 60, hIndex: 20, firstPublicationYear: 2010, lastPublicationYear: 2026, yearsAtInstitute: here.yearsAtInstitute, name: 'A. Sharma' }, now).senior, false, 'initial-only names are not inferred');
  });

  await check('decideDomain keeps the named departments and reads topics when no department is known', () => {
    assert.deepEqual(decideDomain({ department: 'Department of Chemistry' }).domain, 'chemistry');
    assert.equal(decideDomain({ department: 'Chemical Engineering' }).domain, 'chemical_engineering');
    assert.equal(decideDomain({ department: 'Biochemical Engineering and Biotechnology' }).domain, 'biochemical_engineering');
    assert.ok(['biology', 'biotechnology'].includes(decideDomain({ department: 'Biosciences and Bioengineering' }).domain));
    assert.equal(decideDomain({ department: 'Metallurgical Engineering and Materials Science' }).domain, 'materials');
    assert.equal(decideDomain({ department: 'Energy Science and Engineering' }).domain, 'energy');
    assert.equal(decideDomain({ department: 'Physics' }).kept, false);
    assert.equal(decideDomain({ department: 'Computer Science' }).kept, false);
    const byTopics = decideDomain({ topics: [{ field: 'Chemistry', subfield: 'Electrochemistry', count: 30 }, { field: 'Engineering', subfield: 'Mechanical Engineering', count: 5 }] });
    assert.equal(byTopics.domain, 'chemistry');
    assert.equal(byTopics.kept, true);
    assert.equal(domainFromTopics([{ field: 'Physics and Astronomy', count: 40 }]), 'other');
    assert.equal(domainFromTopics([{ field: 'Physics and Astronomy', subfield: 'Nuclear and High Energy Physics', name: 'High-Energy Particle Collisions Research', count: 40 }]), 'other', 'high-energy physics is not energy engineering');
    assert.equal(domainFromTopics([{ field: 'Physics and Astronomy', count: 40 }, { field: 'Materials Science', count: 6 }]), 'other', 'one materials topic does not make a physicist a materials scientist');
    assert.equal(decideDomain({ department: 'Department of Physics', topics: [{ field: 'Chemistry', subfield: 'Electrochemistry', count: 30 }] }).kept, true, 'a physicist with electrochemistry topics passes the gate');
    assert.equal(decideDomain({ department: 'Department of Physics', topics: [{ field: 'Chemistry', subfield: 'Electrochemistry', count: 30 }] }).gate, 'electrochemistry');
    assert.equal(decideDomain({ department: 'Electrical Engineering' }).domain, 'electrical', 'EE is a kept department since 20 Sep 2026');
    assert.equal(decideDomain({ department: 'Computer Science and Engineering', topics: [{ field: 'Materials Science', count: 30 }] }).kept, false, 'a stated out-of-list department is not overridden by topics');
  });

  await check('civil and mechanical engineering pass only with corrosion-related work', () => {
    const plain = decideDomain({ department: 'Civil Engineering', text: 'bridge dynamics finite element seismic' });
    assert.equal(plain.kept, false);
    assert.match(plain.reason ?? '', /corrosion/);
    const corr = decideDomain({ department: 'Civil Engineering', text: 'Chloride ingress and rebar corrosion in marine concrete' });
    assert.equal(corr.kept, true);
    assert.ok(corr.gateTerms?.includes('corrosion'));
    assert.equal(decideDomain({ department: 'Mechanical Engineering', text: 'tribocorrosion of implant alloys' }).kept, true);
  });

  await check('nameKeys and NameIndex match "Prof. S. Tallur" to "Siddharth Tallur" but never between two candidates', () => {
    assert.equal(nameKeys('Prof. Siddharth Tallur').full, nameKeys('Tallur, Siddharth').full);
    const idx = new NameIndex<string>();
    idx.add('Siddharth Tallur', 'tallur');
    idx.add('Rahul Verma', 'verma-1');
    assert.equal(idx.find('Prof. S. Tallur'), 'tallur');
    assert.equal(idx.find('Tallur S.'), 'tallur');
    assert.equal(idx.find('Rahul Verma'), 'verma-1');
    idx.add('Ritu Verma', 'verma-2');
    assert.equal(idx.find('R. Verma'), undefined, 'two R. Vermas — no guess');
    assert.equal(shortInstitutionNames('Indian Institute of Technology Bombay')[0], 'IIT Bombay');
    assert.equal(shortInstitutionNames('National Institute of Technology Karnataka')[0], 'NIT Karnataka');
  });

  // -------------------------------------------------------------------------
  console.log('\nFaculty roster — build (all sources injected):\n');

  const IITB_ID = 'I162827531';
  const NOW = new Date('2026-09-19');
  const noopCtx = () => {
    const log: string[] = [];
    return {
      id: 't',
      log: (m: string) => log.push(m),
      setStage: () => {},
      count: () => {},
      set: () => {},
      cancelled: () => false,
      checkpoint: () => {},
      lines: log,
    };
  };

  const authors = [
    { id: 'A5000000001', name: 'Siddharth Tallur', orcid: '0000-0002-0001-0001', worksCount: 80, hIndex: 22, yearsHere: [2026, 2025], firstPublicationYear: 2009, lastPublicationYear: 2026, topics: [{ name: 'Electrochemical Sensors', count: 30, subfield: 'Electrochemistry', field: 'Chemistry' }], lastKnown: [{ id: IITB_ID, name: 'IIT Bombay' }] },
    { id: 'A5000000002', name: 'Rahul Verma', worksCount: 6, hIndex: 3, yearsHere: [2026], firstPublicationYear: 2022, lastPublicationYear: 2026, topics: [{ name: 'Organic Synthesis', count: 6, subfield: 'Organic Chemistry', field: 'Chemistry' }], lastKnown: [{ id: IITB_ID, name: 'IIT Bombay' }] },
    { id: 'A5000000003', name: 'Priya Nair', worksCount: 90, hIndex: 25, yearsHere: [2026, 2024, 2022, 2020], firstPublicationYear: 2005, lastPublicationYear: 2026, topics: [{ name: 'Quantum Optics', count: 60, subfield: 'Atomic and Molecular Physics', field: 'Physics and Astronomy' }], lastKnown: [{ id: IITB_ID, name: 'IIT Bombay' }] },
    { id: 'A5000000004', name: 'Kavita Rao', worksCount: 45, hIndex: 15, yearsHere: [2026, 2025, 2023, 2021, 2019], firstPublicationYear: 2012, lastPublicationYear: 2026, topics: [{ name: 'Lithium Batteries', count: 20, subfield: 'Energy Engineering', field: 'Energy' }], lastKnown: [{ id: IITB_ID, name: 'IIT Bombay' }] },
  ];
  const orcidHits = [
    { orcid: '0000-0002-0001-0001', name: 'Siddharth Tallur', institutionNames: ['Indian Institute of Technology Bombay'], emails: [] },
    { orcid: '0000-0002-0001-0002', name: 'Anil Kumar', institutionNames: ['IIT Bombay'], emails: ['anil.kumar@iitb.ac.in'] },
    { orcid: '0000-0002-0001-0003', name: 'Student One', institutionNames: ['IIT Bombay'], emails: [] },
    { orcid: '0000-0002-0001-0004', name: 'Old Alum', institutionNames: ['IIT Bombay', 'MIT'], emails: [] },
    { orcid: '0000-0002-0001-0005', name: 'Civil Guy', institutionNames: ['IIT Bombay'], emails: [] },
    { orcid: '0000-0002-0001-0006', name: 'Civil Other', institutionNames: ['IIT Bombay'], emails: [] },
  ];
  const employments: Record<string, Array<{ organization: string; department?: string; role?: string; startYear?: number; endYear?: number; current: boolean; orgId?: string }>> = {
    '0000-0002-0001-0001': [{ organization: 'Indian Institute of Technology Bombay', department: 'Electrical Engineering', role: 'Associate Professor', startYear: 2016, current: true, orgId: 'https://ror.org/02qyf5152' }],
    '0000-0002-0001-0002': [{ organization: 'IIT Bombay', department: 'Chemistry', role: 'Assistant Professor', startYear: 2021, current: true }],
    '0000-0002-0001-0003': [{ organization: 'IIT Bombay', department: 'Chemistry', role: 'PhD Student', startYear: 2022, current: true }],
    '0000-0002-0001-0004': [{ organization: 'IIT Bombay', department: 'Chemistry', role: 'Professor', startYear: 2005, endYear: 2019, current: false }, { organization: 'MIT', role: 'Professor', startYear: 2019, current: true }],
    '0000-0002-0001-0005': [{ organization: 'Indian Institute of Technology Bombay', department: 'Civil Engineering', role: 'Professor', startYear: 2010, current: true }],
    '0000-0002-0001-0006': [{ organization: 'Indian Institute of Technology Bombay', department: 'Civil Engineering', role: 'Professor', startYear: 2010, current: true }],
  };
  const orcidPeople: Record<string, { orcid: string; emails: string[]; keywords: string[]; urls: Array<{ url: string }> }> = {
    '0000-0002-0001-0005': { orcid: '0000-0002-0001-0005', emails: [], keywords: ['Rebar corrosion', 'Concrete durability'], urls: [] },
    '0000-0002-0001-0006': { orcid: '0000-0002-0001-0006', emails: [], keywords: ['Bridge dynamics'], urls: [] },
    '0000-0002-0001-0001': { orcid: '0000-0002-0001-0001', emails: ['stallur@ee.iitb.ac.in'], keywords: ['electrochemical sensors'], urls: [{ url: 'https://www.ee.iitb.ac.in/~stallur' }] },
  };

  const vidwanRows = [
    { vidwan_id: '9001', profile_url: 'https://vidwan.inflibnet.ac.in/profile/9001', name: 'Siddharth Tallur', designation: 'Associate Professor', institute: 'Indian Institute of Technology Bombay', department: 'Electrical Engineering', phone: '+91 22 2576 9999', expertise: 'Electrochemical sensors; MEMS' },
    { vidwan_id: '9002', profile_url: 'https://vidwan.inflibnet.ac.in/profile/9002', name: 'Vidwan Only', designation: 'Professor', institute: 'IIT Bombay', department: 'Chemistry', email: 'vonly@chem.iitb.ac.in' },
    { vidwan_id: '9003', profile_url: 'https://vidwan.inflibnet.ac.in/profile/9003', name: 'Elsewhere Person', designation: 'Professor', institute: 'National Institute of Technology Karnataka', department: 'Chemistry' },
    { vidwan_id: '9004', profile_url: 'https://vidwan.inflibnet.ac.in/profile/9004', name: 'Vidwan Scholar', designation: 'Research Scholar', institute: 'IIT Bombay', department: 'Chemistry' },
  ];
  const deps = {
    // Listing call returns cards (no department/phone); the profile batch fills them in.
    vidwan: async () => ({ job_id: 'v', rows: vidwanRows.map((r) => ({ vidwan_id: r.vidwan_id, profile_url: r.profile_url, name: r.name, designation: r.designation, institute: r.institute, card_only: true })), listing_profiles: 4, site_total: 4, pages_fetched: 1, requests: 2, blocked: false, errors: [] }),
    vidwanProfiles: async (refs: Array<{ vidwan_id: string }>) => ({ job_id: 'p', rows: vidwanRows.filter((r) => refs.some((x) => x.vidwan_id === r.vidwan_id)), listing_profiles: 0, pages_fetched: 0, profiles_fetched: refs.length, requests: refs.length, blocked: false, errors: [] }),
    institutionProfile: async () => ({ id: IITB_ID, name: 'Indian Institute of Technology Bombay', ror: 'https://ror.org/02qyf5152', homepageUrl: 'https://www.iitb.ac.in', acronyms: ['IITB'], alternatives: [] }),
    listAuthors: async (p: { limit?: number }) => ({ authors: authors.slice(0, p.limit ?? authors.length), total: authors.length }),
    searchOrcid: async () => ({ hits: orcidHits, total: orcidHits.length, truncated: false }),
    orcidEmployments: async (id: string) => (employments[id] ? { orcid: id, employments: employments[id]! } : null),
    orcidPerson: async (id: string) => orcidPeople[id] ?? null,
    scraperUp: async () => true,
    findPages: async () => ({ job_id: 'x', results: [{ institution: 'Indian Institute of Technology Bombay', pages: [{ url: 'https://www.chem.iitb.ac.in/faculty', department: 'chemistry', people: 3, emails: 1, profiles: 3, sample: [], hop: 2 }] }] }),
    scrapePages: async () => ({
      job_id: 'x',
      status: 'completed' as const,
      results: [
        {
          source_url: 'https://www.chem.iitb.ac.in/faculty',
          university_name: 'Indian Institute of Technology Bombay',
          scraped_at: NOW.toISOString(),
          extracted: [
            { name: 'Prof. R. Verma', title: 'Assistant Professor', email: 'rverma@chem.iitb.ac.in', profile_url: 'https://www.chem.iitb.ac.in/faculty/rverma' },
            { name: 'Meena Iyer', title: 'Professor', email: null, profile_url: 'https://www.chem.iitb.ac.in/faculty/miyer' },
            { name: 'Some Scholar', title: 'Research Scholar', email: null, profile_url: null },
          ],
        },
      ],
      errors: [],
    }),
  };

  let summary: Awaited<ReturnType<typeof buildRoster>> | null = null;
  await check('buildRoster merges the three sources and keeps only faculty in the kept departments', async () => {
    summary = await buildRoster({ institutionIds: [IITB_ID] }, noopCtx(), deps as any);
    const r = summary.institutions[0]!;
    assert.equal(r.openAlexAuthors, 4);
    assert.equal(r.orcidRecords, 6);
    assert.equal(r.orcidCurrentHere, 5, 'the alum with an ended employment is not current');
    assert.equal(r.pagesFound, 1);
    assert.equal(r.pagePeople, 3);
    assert.equal(r.vidwanProfiles, 2, 'two faculty-titled Vidwan cards at the institute; the NIT one and the scholar are ignored');
    assert.equal(r.created, 7, `created ${r.created}: Tallur, Anil Kumar, Rahul Verma, Kavita Rao, Civil Guy, Meena Iyer, Vidwan Only`);
    assert.equal(r.excludedRole, 2, 'the PhD student and the research scholar (the Vidwan scholar never reaches the decision)');
    assert.equal(r.excludedDomain, 2, 'the physicist and the bridge engineer');
    assert.equal(r.droppedUnconfirmed, 0);
  });

  await check('a person seen by several sources is ONE member with every source recorded', async () => {
    const tallur = await repositories.faculty.findSamePerson({ orcid: '0000-0002-0001-0001', normalizedNameKey: '' });
    assert.ok(tallur);
    assert.equal(tallur.person.openAlexAuthorId, 'A5000000001');
    assert.deepEqual(tallur.sources.map((s) => s.type).sort(), ['openalex', 'orcid', 'vidwan']);
    assert.equal(tallur.role.category, 'professor');
    assert.equal(tallur.institution.affiliation?.source, 'vidwan', 'a Vidwan profile at the institute outranks ORCID as the placement source');
    assert.ok(tallur.institution.affiliation?.evidence?.some((e) => e.source === 'orcid'), 'ORCID evidence still recorded');
    assert.equal(tallur.department.domain, 'electrical', 'EE is a kept department');
    assert.equal(tallur.institution.affiliation?.status, 'current', 'a current ORCID employment settles it at build time');
    assert.equal(tallur.institution.discoveredOpenAlexId, IITB_ID);
  });

  await check('"Prof. R. Verma" on the faculty page is the OpenAlex "Rahul Verma" — title, email and profile attached', async () => {
    const verma = await repositories.faculty.findSamePerson({ openAlexAuthorId: 'A5000000002', normalizedNameKey: '' });
    assert.ok(verma);
    assert.equal(verma.status, 'eligible');
    assert.equal(verma.role.category, 'professor', 'junior output alone would not have kept him; the page title does');
    assert.equal(verma.person.email, 'rverma@chem.iitb.ac.in');
    assert.equal(verma.person.profileUrl, 'https://www.chem.iitb.ac.in/faculty/rverma');
    assert.deepEqual(verma.sources.map((s) => s.type).sort(), ['faculty_page', 'openalex']);
  });

  await check('an OpenAlex-only senior author is kept as "inferred" and tagged; a junior one without a title is dropped', async () => {
    const rao = await repositories.faculty.findSamePerson({ openAlexAuthorId: 'A5000000004', normalizedNameKey: '' });
    assert.ok(rao);
    assert.equal(rao.role.category, 'inferred');
    assert.ok(rao.tags.includes('role-inferred'));
    assert.equal(rao.department.domain, 'energy');
    const all = await repositories.faculty.find({});
    assert.ok(!all.some((m) => m.person.name === 'Student One'), 'students are never stored');
    assert.ok(!all.some((m) => m.person.name === 'Some Scholar'));
    assert.ok(!all.some((m) => m.person.name === 'Old Alum'), 'an ended employment is not a current one');
    assert.ok(!all.some((m) => m.person.name === 'Priya Nair'), 'physics is outside the kept departments');
  });

  await check('the civil engineer passes the corrosion gate via ORCID keywords; the bridge engineer does not', async () => {
    const guy = await repositories.faculty.findSamePerson({ orcid: '0000-0002-0001-0005', normalizedNameKey: '' });
    assert.ok(guy);
    assert.equal(guy.department.domain, 'civil');
    assert.ok(guy.department.gateTerms?.includes('corrosion'), `gate terms: ${guy.department.gateTerms}`);
    const other = await repositories.faculty.findSamePerson({ orcid: '0000-0002-0001-0006', normalizedNameKey: '' });
    assert.equal(other, null);
  });

  await check('a department-less duplicate profile does not exclude a member whose department is known', async () => {
    // OpenAlex sometimes holds two records for one person; the second has no
    // department and physics-looking topics.
    const twin = { ...authors[0]!, id: 'A5000000099', orcid: undefined, yearsHere: [2026, 2025, 2023, 2021, 2019], topics: [{ name: 'Quantum Optics', count: 20, subfield: 'Atomic and Molecular Physics', field: 'Physics and Astronomy' }] };
    const twinDeps = { ...deps, listAuthors: async () => ({ authors: [...authors, twin], total: authors.length + 1 }) };
    await buildRoster({ institutionIds: [IITB_ID] }, noopCtx(), twinDeps as any);
    const tallur = await repositories.faculty.findSamePerson({ orcid: '0000-0002-0001-0001', normalizedNameKey: '' });
    assert.equal(tallur!.status, 'eligible', 'the thinner twin must not downgrade him');
  });

  await check('a Vidwan-only professor is a member with the Vidwan id as source record', async () => {
    const v = (await repositories.faculty.find({})).find((m) => m.person.name === 'Vidwan Only');
    assert.ok(v, 'created from Vidwan alone');
    assert.equal(v.role.category, 'professor');
    assert.equal(v.department.domain, 'chemistry');
    assert.equal(v.person.email, 'vonly@chem.iitb.ac.in');
    assert.deepEqual(v.sources.map((s) => [s.type, s.recordId]), [['vidwan', '9002']]);
    assert.ok(!(await repositories.faculty.find({})).some((m) => m.person.name === 'Elsewhere Person'), 'another institute\'s profile is not added here');
    assert.ok(!(await repositories.faculty.find({})).some((m) => m.person.name === 'Vidwan Scholar'), 'a research scholar on Vidwan is dropped like any other');
  });

  await check('an always-keep entry bypasses the department gate (a physicist pinned by ORCID is kept)', async () => {
    const { updateSettings, getSettings, invalidateSettingsCache } = await import('../services/settings/settingsService.js');
    const before = (await getSettings()).discovery.rosterAlwaysKeep;
    // Priya Nair (A5000000003) is a physicist the gate drops; pin her by name + institute.
    await updateSettings({ discovery: { ...(await getSettings()).discovery, rosterAlwaysKeep: [...before, { name: 'Priya Nair', institution: 'IIT Bombay', note: 'known customer' }] } });
    invalidateSettingsCache();
    const res = await buildRoster({ institutionIds: [IITB_ID] }, noopCtx(), deps as any);
    assert.equal(res.institutions[0]!.created, 1, 'exactly the pinned person is added');
    const nair = (await repositories.faculty.find({})).find((m) => m.person.name === 'Priya Nair');
    assert.ok(nair, 'kept despite physics topics');
    assert.equal(nair.status, 'eligible');
    assert.ok(nair.tags.includes('always-keep'));
    assert.equal(nair.department.domain, 'other');
    await repositories.faculty.deleteById(nair.id);
    await updateSettings({ discovery: { ...(await getSettings()).discovery, rosterAlwaysKeep: before } });
    invalidateSettingsCache();
  });

  await check('a second build is idempotent: nothing created, everything updated', async () => {
    const again = await buildRoster({ institutionIds: [IITB_ID] }, noopCtx(), deps as any);
    assert.equal(again.institutions[0]!.created, 0);
    assert.equal(again.institutions[0]!.updated, 7);
    assert.equal(await repositories.faculty.count(), 7);
  });

  // -------------------------------------------------------------------------
  console.log('\nFaculty roster — verify, score, promote, fill:\n');

  await check('verifyRoster: ORCID current employment outranks a newer paper elsewhere; a mover outside the list is tagged', async () => {
    const NUS = { id: 'I165932596', name: 'National University of Singapore', country: 'SG' };
    const IITB = { id: IITB_ID, name: 'Indian Institute of Technology Bombay', country: 'IN' };
    const result = await verifyRoster({ freshDays: 0 }, noopCtx(), {
      fetchAffiliations: async (authorId: string) => {
        if (authorId === 'A5000000001') return { authorId, lastKnown: [NUS], affiliations: [{ ...NUS, years: [2026] }, { ...IITB, years: [2024] }] };
        if (authorId === 'A5000000004') return { authorId, lastKnown: [NUS], affiliations: [{ ...NUS, years: [2026] }, { ...IITB, years: [2023] }] };
        return { authorId, lastKnown: [IITB], affiliations: [{ ...IITB, years: [2026] }] };
      },
      fetchOrcid: async (id: string) => (employments[id] ? { orcid: id, employments: employments[id]! } : null),
    });
    assert.equal(result.moved, 1, 'only Kavita Rao (no ORCID) moves');
    assert.equal(result.outsideTarget, 1);
    const tallur = await repositories.faculty.findSamePerson({ orcid: '0000-0002-0001-0001', normalizedNameKey: '' });
    assert.equal(tallur!.institution.affiliation?.status, 'current');
    assert.equal(tallur!.institution.affiliation?.source, 'orcid');
    const rao = await repositories.faculty.findSamePerson({ openAlexAuthorId: 'A5000000004', normalizedNameKey: '' });
    assert.equal(rao!.institution.affiliation?.status, 'moved');
    assert.equal(rao!.institution.name, NUS.name);
    assert.equal(rao!.institution.affiliation?.previousInstitution, IITB.name);
    assert.equal(rao!.institution.outsideTarget, true);
    assert.ok(rao!.tags.includes('outside-target'));
    assert.equal(rao!.institution.discoveredName, IITB.name, 'the reference point never moves');
  });

  await check('scoreRoster reads one works call per person and scores with the catalog-grounded scorer', async () => {
    const result = await scoreRoster({}, noopCtx(), {
      provider: new HeuristicProvider(),
      recentWorks: async ({ authorId }: { authorId: string }) => {
        if (authorId === 'A5000000001') {
          return {
            publications: [{ title: 'A portable potentiostat for electrochemical impedance spectroscopy of biosensors', year: 2025, sourceId: 'W1' }],
            topics: ['Electrochemical Sensors'],
            evidenceText: 'We report cyclic voltammetry and electrochemical impedance spectroscopy on screen-printed electrodes with a potentiostat.',
          };
        }
        return { publications: [{ title: 'Deep learning for cricket analytics', year: 2025 }], topics: ['Sports Analytics'], evidenceText: 'Neural networks predict match outcomes.' };
      },
      orcidWorks: async () => [],
    });
    assert.ok(result.scored >= 3, `scored ${result.scored}`);
    assert.equal(result.openAlexExhausted, false);
    const tallur = await repositories.faculty.findSamePerson({ orcid: '0000-0002-0001-0001', normalizedNameKey: '' });
    assert.ok((tallur!.relevance.score ?? 0) >= 40, `Tallur scored ${tallur!.relevance.score}`);
    assert.equal(tallur!.research.recentPublications.length, 1);
    const verma = await repositories.faculty.findSamePerson({ openAlexAuthorId: 'A5000000002', normalizedNameKey: '' });
    assert.ok((verma!.relevance.score ?? 100) < 40, `Verma scored ${verma!.relevance.score}`);
    const iyer = (await repositories.faculty.find({})).find((m) => m.person.name === 'Meena Iyer');
    assert.equal(iyer!.relevance.score, 0, 'no ids, no evidence → scored 0, not left unscored');
  });

  await check('sweepInstruments tags roster members seen in institute-wide brand queries and re-scores them', async () => {
    const { sweepInstruments } = await import('../services/roster/rosterSweep.js');
    const verma = await repositories.faculty.findSamePerson({ openAlexAuthorId: 'A5000000002', normalizedNameKey: '' });
    const before = verma!.relevance.score ?? 0;
    const result = await sweepInstruments({ institutionIds: [IITB_ID] }, noopCtx(), {
      fetchBrands: async () => ({
        source: 'openalex',
        errors: [],
        candidates: [
          {
            sourceType: 'openalex', sourceRecordId: 'https://openalex.org/A5000000002', name: 'Rahul Verma', institutionName: 'Indian Institute of Technology Bombay',
            publications: [{ title: 'Field sensing with a handheld potentiostat', year: 2025 }], grants: [], topics: [], evidenceText: '',
            instruments: [{ brandKey: 'palmsens', brand: 'PalmSens', vendor: 'classone', model: 'PalmSens4', evidence: 'Full text mentions the PalmSens4.', matchedVia: 'fulltext_search' }],
          },
          {
            sourceType: 'openalex', sourceRecordId: 'https://openalex.org/A5999999999', name: 'Some Student', institutionName: 'Indian Institute of Technology Bombay',
            publications: [], grants: [], topics: [], evidenceText: '',
            instruments: [{ brandKey: 'gamry', brand: 'Gamry', vendor: 'competitor', evidence: 'x', matchedVia: 'fulltext_search' }],
          },
        ],
      }),
    });
    assert.equal(result.membersTagged, 1);
    assert.equal(result.institutions[0]!.notOnRoster, 1, 'a student on the paper is not on the roster');
    assert.equal(result.institutions[0]!.admitted, 0, 'the student is not admitted');
    assert.equal(result.institutions[0]!.declined[0]!.name, 'Some Student');
    const after = await repositories.faculty.findSamePerson({ openAlexAuthorId: 'A5000000002', normalizedNameKey: '' });
    assert.equal(after!.research.instruments[0]!.model, 'PalmSens4');
    assert.ok(after!.tags.includes('instruments-swept'));
    assert.ok((after!.relevance.score ?? 0) > before, `re-scored ${before} → ${after!.relevance.score}`);
    // Put him back below the bar so the promotion test below still promotes exactly one.
    await repositories.faculty.updateById(after!.id, { relevance: { score: 10 }, research: { instruments: [] } });
  });

  await check('a sighted instrument owner outside the kept departments is ADMITTED when they read as faculty', async () => {
    const { sweepInstruments } = await import('../services/roster/rosterSweep.js');
    const result = await sweepInstruments({ institutionIds: [IITB_ID] }, noopCtx(), {
      fetchBrands: async () => ({
        source: 'openalex',
        errors: [],
        candidates: [
          {
            sourceType: 'openalex', sourceRecordId: 'https://openalex.org/A5000000777', name: 'Ultra Sonic', institutionName: 'Indian Institute of Technology Bombay',
            publications: [{ title: 'Acoustic sensing with a handheld potentiostat', year: 2025 }], grants: [], topics: [], evidenceText: '',
            instruments: [{ brandKey: 'palmsens', brand: 'PalmSens', vendor: 'classone', model: 'PalmSens4', evidence: 'Full text mentions the PalmSens4.', matchedVia: 'fulltext_search' }],
          },
        ],
      }),
      admit: async (p) =>
        (await import('../services/roster/rosterBuilder.js')).admitInstrumentOwner({
          ...p,
          deps: {
            // An electrical engineer: MEMS topics, EE department on ORCID, ten years at the institute.
            author: async () => ({ id: 'A5000000777', name: 'Ultra Sonic', orcid: '0000-0002-0007-0007', worksCount: 140, hIndex: 21, yearsHere: [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017], firstPublicationYear: 2009, lastPublicationYear: 2026, topics: [{ name: 'Ultrasonics and Acoustic Wave Propagation', count: 28, subfield: 'Mechanics of Materials', field: 'Engineering' }], lastKnown: [{ id: IITB_ID, name: 'IIT Bombay' }] }),
            orcidEmployments: async () => ({ orcid: '0000-0002-0007-0007', employments: [{ organization: 'Indian Institute of Technology Bombay', department: 'Electrical Engineering', role: 'Associate Professor', startYear: 2016, current: true }] }),
          },
        }),
    });
    assert.equal(result.institutions[0]!.admitted, 1);
    assert.ok(result.classOneOwners.includes('Ultra Sonic'));
    const m = (await repositories.faculty.find({})).find((x) => x.person.name === 'Ultra Sonic');
    assert.ok(m, 'admitted to the roster');
    assert.equal(m.role.category, 'professor');
    assert.equal(m.department.name, 'Electrical Engineering');
    assert.equal(m.department.domain, 'electrical');
    assert.ok(m.tags.includes('instrument-owner'), `tags: ${m.tags}`);
    assert.equal(m.research.instruments[0]!.model, 'PalmSens4');
    assert.equal(m.institution.affiliation?.source, 'orcid');
    assert.ok((m.relevance.score ?? 0) >= 40, `scored ${m.relevance.score} — a PalmSens owner must clear the bar`);
    await repositories.faculty.deleteById(m.id);
  });

  await check('promoteRoster creates CRM leads above the threshold, linked back to the member', async () => {
    const result = await promoteRoster({ threshold: 40 }, noopCtx());
    assert.equal(result.promoted, 1);
    const tallur = await repositories.faculty.findSamePerson({ orcid: '0000-0002-0001-0001', normalizedNameKey: '' });
    assert.equal(tallur!.status, 'promoted');
    assert.ok(tallur!.leadId);
    const lead = await repositories.leads.findById(tallur!.leadId!);
    assert.ok(lead);
    assert.equal(lead.source.type, 'faculty_roster');
    assert.equal(lead.source.sourceRecordId, 'A5000000001', 'the OpenAlex id rides along for the instrument scan');
    assert.equal(lead.person.orcid, '0000-0002-0001-0001');
    assert.equal(lead.institution.affiliation?.status, 'current');
    assert.equal(lead.aiScoring.relevanceScore, tallur!.relevance.score);
    assert.equal(lead.status, 'pending_review');
    const again = await promoteRoster({ threshold: 40 }, noopCtx());
    assert.equal(again.promoted, 0, 'promotion is idempotent');
  });

  await check('fillRoster takes email, website and title from ORCID when the scraper is down', async () => {
    const result = await fillRoster({ useScraper: false }, noopCtx(), {
      orcidPerson: async (id: string) => orcidPeople[id] ?? null,
      orcidEmployments: async (id: string) => (employments[id] ? { orcid: id, employments: employments[id]! } : null),
      scraperUp: async () => false,
    });
    assert.equal(result.considered, 1);
    assert.equal(result.filledFromOrcid, 1);
    const tallur = await repositories.faculty.findSamePerson({ orcid: '0000-0002-0001-0001', normalizedNameKey: '' });
    const lead = await repositories.leads.findById(tallur!.leadId!);
    assert.equal(lead!.person.email, 'stallur@ee.iitb.ac.in');
    assert.equal(lead!.person.websiteUrl, 'https://www.ee.iitb.ac.in/~stallur');
    assert.equal(lead!.person.title, 'Associate Professor');
    assert.deepEqual(missingFields(lead!), ['phone'], 'phone is not on ORCID (nor on Vidwan)');
    assert.equal(tallur!.person.email, 'stallur@ee.iitb.ac.in', 'mirrored onto the member');
  });

  // -------------------------------------------------------------------------
  console.log('\nFaculty roster — import, HTTP surface, jobs:\n');

  await check('parseCsv handles quotes and CRLF; rowsFromCsv maps Vidwan-style headers', async () => {
    const rows = parseCsv('Name,Institution\r\n"Kumar, Anil",IIT Bombay\r\nB,"X ""Y"" Z"\r\n');
    assert.deepEqual(rows, [['Name', 'Institution'], ['Kumar, Anil', 'IIT Bombay'], ['B', 'X "Y" Z']]);
    const mapped = rowsFromCsv('Expert Name,Organisation,Designation,Department,Email\nDr. Neha Gupta,IIT Bombay,Professor,Chemistry,ng@iitb.ac.in\n');
    assert.equal(mapped.length, 1);
    assert.equal(mapped[0]!.name, 'Dr. Neha Gupta');
    assert.equal(mapped[0]!.title, 'Professor');
    assert.equal(mapped[0]!.email, 'ng@iitb.ac.in');
    // The Vidwan search notebook's export, column names as it writes them.
    const vidwan = rowsFromCsv(
      'vidwan_id,name,listing_name,designation,institute,department,state,email,phone,website,search_queries,profile_url,listing_card_text,profile_text\n' +
        '12345,Dr. Ravi Kumar,Ravi Kumar,Professor,Indian Institute of Technology Bombay,Civil Engineering,Maharashtra,rk@civil.iitb.ac.in,+91 22 2576 0000,https://www.civil.iitb.ac.in/~rk,corrosion,https://vidwan.inflibnet.ac.in/profile/12345,card,"Expertise: chloride-induced rebar corrosion in concrete"\n',
    );
    assert.equal(vidwan.length, 1);
    assert.equal(vidwan[0]!.institutionName, 'Indian Institute of Technology Bombay');
    assert.equal(vidwan[0]!.phone, '+91 22 2576 0000');
    assert.equal(vidwan[0]!.websiteUrl, 'https://www.civil.iitb.ac.in/~rk');
    assert.equal(vidwan[0]!.sourceId, '12345');
    assert.match(vidwan[0]!.profileText ?? '', /rebar corrosion/);
    const imported = await importRoster(vidwan, 'vidwan_import');
    assert.equal(imported.created, 1, 'the civil engineer passes the corrosion gate on his Vidwan profile text');
    const rk = (await repositories.faculty.find({})).find((m) => m.person.name === 'Dr. Ravi Kumar');
    assert.equal(rk!.department.domain, 'civil');
    assert.equal(rk!.person.phone, '+91 22 2576 0000');
    assert.equal(rk!.sources[0]!.recordId, '12345');
    await repositories.faculty.deleteById(rk!.id);
  });

  await check('POST /roster/import applies the same role and department rules', async () => {
    const csv = [
      'Name,Institution,Designation,Department',
      'Neha Gupta,IIT Bombay,Professor,Chemistry',
      'Some Student,IIT Bombay,PhD Scholar,Chemistry',
      'Physics Person,IIT Bombay,Professor,Physics',
      'Unknown Place,Some University,Professor,Chemistry',
    ].join('\n');
    const { status, body } = await request('/roster/import', { method: 'POST', body: JSON.stringify({ csv }) });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.created, 1);
    assert.equal(body.excludedRole, 1);
    assert.equal(body.excludedDomain, 1);
    assert.equal(body.unknownInstitution, 1);
    const gupta = (await repositories.faculty.find({})).find((m) => m.person.name === 'Neha Gupta');
    assert.equal(gupta!.sources[0]!.type, 'vidwan_import');
  });

  await check('GET /roster lists with filters; /summary and /config answer; export.csv is a CSV', async () => {
    const all = await request('/roster');
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 8);
    const promoted = await request('/roster?status=promoted');
    assert.equal(promoted.body.total, 1);
    const chem = await request('/roster?domain=chemistry&status=eligible');
    assert.ok(chem.body.total >= 3, `chemistry eligible: ${chem.body.total}`);
    const inferred = await request('/roster?tag=role-inferred');
    assert.equal(inferred.body.total, 1);
    const search = await request('/roster?q=verma');
    assert.equal(search.body.total, 1);
    const typo = await request('/roster?q=talur');
    assert.ok(typo.body.items.some((m: { person: { name: string } }) => m.person.name === 'Siddharth Tallur'), 'a one-letter typo still finds him');
    const initials = await request('/roster?q=s%20tallur');
    assert.equal(initials.body.items[0]?.person.name, 'Siddharth Tallur', 'initial + surname');
    const twoStatuses = await request('/roster?status=eligible,promoted');
    const onlyEligible = await request('/roster?status=eligible');
    assert.ok(twoStatuses.body.total > onlyEligible.body.total, 'multi-status returns more than one status');
    const byOrcid = await request('/roster?q=0000-0002-0001-0002');
    assert.equal(byOrcid.body.items[0]?.person.name, 'Anil Kumar', 'an ORCID typed into the box matches by substring');
    const summary = await request('/roster/summary');
    assert.equal(summary.body.total, 8);
    assert.equal(summary.body.byStatus.promoted, 1);
    assert.ok(summary.body.byInstitution[0].name.includes('Bombay'));
    const config = await request('/roster/config');
    assert.equal(config.body.institutions.length, 72);
    assert.equal(config.body.defaultThreshold, 40);
    const csv = await fetch('http://localhost:4999/api/roster/export.csv?status=promoted');
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    const text = await csv.text();
    assert.match(text, /Siddharth Tallur/);
    assert.match(text.split('\n')[0]!, /Relevance/);
  });

  await check('new list filters: source, brand/vendor, hasEmail, maxScore, comma-separated domains', async () => {
    const vid = await request('/roster?source=vidwan');
    assert.ok(vid.body.total >= 2, `vidwan-sourced: ${vid.body.total}`);
    const twoDomains = await request('/roster?domain=chemistry,energy&status=eligible');
    const chemOnly = await request('/roster?domain=chemistry&status=eligible');
    assert.ok(twoDomains.body.total > chemOnly.body.total, 'two domains return more than one');
    const withEmail = await request('/roster?hasEmail=yes');
    const noEmail = await request('/roster?hasEmail=no');
    const all = await request('/roster');
    assert.equal(withEmail.body.total + noEmail.body.total, all.body.total, 'hasEmail yes+no covers everyone');
    // Give one member a sighting so the instrument filters have something to find.
    const vermaM = await repositories.faculty.findSamePerson({ openAlexAuthorId: 'A5000000002', normalizedNameKey: '' });
    await repositories.faculty.updateById(vermaM!.id, { research: { instruments: [{ brandKey: 'palmsens', brand: 'PalmSens', vendor: 'classone', model: 'PalmSens4', evidence: 'test', matchedVia: 'fulltext_search' }] } });
    const owners = await request('/roster?vendor=classone');
    assert.equal(owners.body.total, 1, 'one PalmSens owner on the test roster');
    const byBrand = await request('/roster?brand=palmsens');
    assert.equal(byBrand.body.total, 1);
    const none = await request('/roster?vendor=none');
    assert.equal(none.body.total, all.body.total - 1);
    const low = await request('/roster?maxScore=30&scored=yes');
    assert.ok(low.body.items.every((m: { relevance: { score: number } }) => m.relevance.score <= 30));
  });

  await check('fuzzy scoring: whole-word matching, typos, initials, no substring bleed', async () => {
    const { fuzzyScore, tokenScore } = await import('../services/roster/fuzzy.js');
    const tallur = { name: 'Siddharth Tallur', department: 'Electrical Engineering', institution: 'Indian Institute of Technology Bombay' };
    const mems = { name: 'I. Samajdar', department: 'Metallurgical Engineering and Materials Science', institution: 'Indian Institute of Technology Bombay' };
    assert.ok(fuzzyScore('tallur', tallur) >= 0.95);
    assert.equal(fuzzyScore('tallur', mems), 0, '"tallur" must not match "metallurgical"');
    assert.ok(fuzzyScore('talur', tallur) >= 0.8, 'one edit away');
    assert.ok(fuzzyScore('sidharth talur', tallur) >= 0.8, 'two typos across two tokens');
    assert.ok(fuzzyScore('s tallur', tallur) >= 0.8, 'initial + surname');
    assert.equal(fuzzyScore('tallur zzzz', tallur), 0, 'every token must match');
    assert.ok(fuzzyScore('electrical', tallur) > 0.8, 'department words count');
    assert.ok(fuzzyScore('metallurg', mems) > 0.8, 'prefix of a department word');
    assert.equal(tokenScore('bombay', 'bombay'), 1);
    assert.ok(tokenScore('mumbai', 'bombay') === 0);
  });

  await check('GET /roster/export.xlsx returns a workbook split into one sheet per value plus "All"', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const res = await fetch('http://localhost:4999/api/roster/export.xlsx?splitBy=domain&filename=my%20export');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /spreadsheetml/);
    assert.match(res.headers.get('content-disposition') ?? '', /filename="my export.xlsx"/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const names = wb.worksheets.map((w) => w.name);
    assert.equal(names[0], 'All');
    assert.ok(names.includes('Chemistry'), `sheets: ${names.join(', ')}`);
    const all = wb.getWorksheet('All')!;
    const total = (await request('/roster')).body.total as number;
    assert.equal(all.rowCount - 1, total, 'All sheet holds every member');
    assert.equal(String(all.getRow(1).getCell(1).value), 'Name');
    const sumSplit = wb.worksheets.slice(1).reduce((n, w) => n + w.rowCount - 1, 0);
    assert.equal(sumSplit, total, 'domain is single-valued, so the split sheets add up to the total');
    const byBrand = new ExcelJS.Workbook();
    const r2 = await fetch('http://localhost:4999/api/roster/export.xlsx?splitBy=brand');
    await byBrand.xlsx.load(await r2.arrayBuffer());
    assert.ok(byBrand.worksheets.some((w) => w.name === 'PalmSens'), `brand sheets: ${byBrand.worksheets.map((w) => w.name).join(', ')}`);
    const csv = await fetch('http://localhost:4999/api/roster/export.csv?filename=x%2Fy');
    assert.match(csv.headers.get('content-disposition') ?? '', /filename="x_y.csv"/, 'unsafe characters in the file name are replaced');
    const vermaM = await repositories.faculty.findSamePerson({ openAlexAuthorId: 'A5000000002', normalizedNameKey: '' });
    await repositories.faculty.updateById(vermaM!.id, { research: { instruments: [] } });
  });

  await check('PATCH /roster/:id excludes and restores a member; a promoted one is refused', async () => {
    const verma = await repositories.faculty.findSamePerson({ openAlexAuthorId: 'A5000000002', normalizedNameKey: '' });
    const ex = await request(`/roster/${verma!.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'excluded', reason: 'not a buyer' }) });
    assert.equal(ex.status, 200);
    assert.equal(ex.body.member.status, 'excluded');
    assert.equal(ex.body.member.exclusionReason, 'not a buyer');
    const back = await request(`/roster/${verma!.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'eligible' }) });
    assert.equal(back.body.member.status, 'eligible');
    assert.equal(back.body.member.exclusionReason, undefined);
    const tallur = await repositories.faculty.findSamePerson({ orcid: '0000-0002-0001-0001', normalizedNameKey: '' });
    const refused = await request(`/roster/${tallur!.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'excluded' }) });
    assert.equal(refused.status, 400);
  });

  await check('jobs run detached, report progress, refuse a duplicate and can be cancelled', async () => {
    resetJobs();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const job = startJob('roster_build', async (ctx) => {
      ctx.setStage('working', 0.5);
      ctx.count('items', 3);
      await gate;
      ctx.checkpoint();
      return { done: true };
    });
    assert.equal(job.status, 'running');
    const viaHttp = await request(`/roster/jobs/${job.id}`);
    assert.equal(viaHttp.status, 200);
    assert.equal(viaHttp.body.stage, 'working');
    assert.equal(viaHttp.body.counters.items, 3);
    assert.throws(() => startJob('roster_build', async () => null), /already running/);
    const cancel = await request(`/roster/jobs/${job.id}/cancel`, { method: 'POST' });
    assert.equal(cancel.status, 200);
    release();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(getJob(job.id)!.status, 'cancelled');
    const list = await request('/roster/jobs?kind=roster_build');
    assert.equal(list.body.jobs.length, 1);
  });

  await check('POST /roster/build validates institutes and returns 202 with a job; DELETE wipes with confirmation', async () => {
    const bad = await request('/roster/build', { method: 'POST', body: JSON.stringify({ institutionIds: ['I1'] }) });
    assert.equal(bad.status, 400);
    const noConfirm = await request('/roster', { method: 'DELETE', body: JSON.stringify({}) });
    assert.equal(noConfirm.status, 400);
    const wiped = await request('/roster', { method: 'DELETE', body: JSON.stringify({ confirm: 'WIPE ROSTER' }) });
    assert.equal(wiped.status, 200);
    assert.equal(wiped.body.deleted, 8);
    assert.equal(await repositories.faculty.count(), 0);
    assert.ok(DEPARTMENT_HINTS.findIndex((h) => h.hint === 'biochem') < DEPARTMENT_HINTS.findIndex((h) => h.hint === 'chemical'), 'biochem must be matched before chemical');
  });
}
