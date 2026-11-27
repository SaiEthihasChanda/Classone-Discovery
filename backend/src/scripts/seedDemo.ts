/**
 * Fills the DEMO database (MONGO_DB_NAME=classone_demo) with a fictional, realistic data set, for the
 * feature document's screenshots. Every person is made up and every address is @example.edu (a
 * reserved domain that can never receive mail). Public data is copied from the live database: the
 * product catalog, app settings and the team's own user accounts. It refuses to run on any other
 * database.
 *
 *   MONGO_DB_NAME=classone_demo npx tsx src/scripts/seedDemo.ts
 */
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { ActivityLogModel } from '../models/activityLog.model.js';
import { AppUserModel } from '../models/appUser.model.js';
import { CampaignModel, CampaignRecipientModel } from '../models/campaign.model.js';
import { ContactModel } from '../models/contact.model.js';
import { EmailThreadModel } from '../models/emailThread.model.js';
import { FacultyMemberModel } from '../models/facultyMember.model.js';
import { InboundEmailModel } from '../models/inboundEmail.model.js';
import { LeadModel } from '../models/lead.model.js';
import { PipelineScheduleModel, PipelineSettingsModel } from '../models/pipeline.model.js';
import { ProductModel } from '../models/productCatalog.model.js';
import { RosterRunModel } from '../models/rosterRun.model.js';
import { ScheduleEventModel } from '../models/scheduleEvent.model.js';
import { setState } from '../models/systemState.model.js';
import { ProductLaunchModel } from '../services/catalog/catalogWatcher.js';
import { normalizeInstitutionKey, normalizeNameKey } from '../utils/normalize.js';

if (env.MONGO_DB_NAME !== 'classone_demo') {
  console.error(`Refusing to seed "${env.MONGO_DB_NAME}" — this script only fills the demo database (MONGO_DB_NAME=classone_demo).`);
  process.exit(1);
}

const H = 3_600_000;
const D = 24 * H;
const now = Date.now();
const ago = (ms: number) => new Date(now - ms);
const ahead = (ms: number) => new Date(now + ms);
/** Today at hh:mm local (IST on the team's machines). */
const today = (h: number, m = 0) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
};
const dayAt = (offsetDays: number, h: number, m = 0) => {
  const d = new Date(now + offsetDays * D);
  d.setHours(h, m, 0, 0);
  return d;
};
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

// --- People (all fictional) ----------------------------------------------------------------------------
const FIRST = ['Kavya', 'Arvind', 'Meera', 'Rohan', 'Sneha', 'Imran', 'Lakshmi', 'Farhan', 'Ananya', 'Vikram', 'Divya', 'Suresh', 'Nisha', 'Rahul', 'Pooja', 'Aditya', 'Shalini', 'Karthik', 'Neha', 'Manoj', 'Ritu', 'Sanjay', 'Gayatri', 'Harish', 'Aparna', 'Deepak', 'Swati', 'Naveen', 'Bhavna', 'Ashok', 'Tanvi', 'Prakash', 'Revathi', 'Gaurav', 'Ishita', 'Mohan', 'Smita', 'Varun', 'Anjali', 'Rajesh', 'Keerthi', 'Siddharth', 'Madhuri', 'Nikhil', 'Usha', 'Abhishek', 'Preeti', 'Venkat', 'Sunita', 'Kiran', 'Jaya', 'Amit', 'Rekha', 'Sameer', 'Leela', 'Tarun', 'Hema', 'Ajay', 'Charu', 'Dinesh'];
const LAST = ['Raman', 'Kulkarni', 'Pillai', 'Desai', 'Joshi', 'Sheikh', 'Narayanan', 'Ali', 'Iyer', 'Menon', 'Rao', 'Banerjee', 'Gupta', 'Verma', 'Hegde', 'Chatterjee', 'Bhat', 'Saxena', 'Nair', 'Mishra', 'Reddy', 'Kapoor', 'Sinha', 'Patil', 'Ghosh', 'Shetty', 'Bose', 'Trivedi', 'Dutta', 'Krishnan'];
const INSTITUTES = [
  { name: 'Indian Institute of Technology Madras', city: 'Chennai' },
  { name: 'Indian Institute of Technology Bombay', city: 'Mumbai' },
  { name: 'Indian Institute of Technology Delhi', city: 'New Delhi' },
  { name: 'Indian Institute of Science', city: 'Bengaluru' },
  { name: 'Indian Institute of Technology Kharagpur', city: 'Kharagpur' },
  { name: 'National Institute of Technology Tiruchirappalli', city: 'Tiruchirappalli' },
  { name: 'Indian Institute of Technology Hyderabad', city: 'Hyderabad' },
  { name: 'CSIR-Central Electrochemical Research Institute', city: 'Karaikudi' },
  { name: 'Indian Institute of Science Education and Research Pune', city: 'Pune' },
  { name: 'Anna University', city: 'Chennai' },
  { name: 'Indian Institute of Technology Guwahati', city: 'Guwahati' },
  { name: 'Vellore Institute of Technology', city: 'Vellore' },
];
const DEPTS = ['Department of Chemistry', 'Department of Chemical Engineering', 'Department of Metallurgical and Materials Engineering', 'Department of Energy Science', 'Department of Biotechnology', 'Department of Physics'];
const TOPICS: Array<{ topics: string[]; areas: string[]; products: string[]; summary: string }> = [
  { topics: ['sodium-ion batteries', 'cathode materials', 'electrochemical impedance spectroscopy'], areas: ['battery research', 'energy storage'], products: ['palmsens4', 'multipalmsens4'], summary: 'Develops layered oxide cathodes for sodium-ion batteries and studies their degradation with impedance spectroscopy and long-term cycling.' },
  { topics: ['electrochemical biosensors', 'screen-printed electrodes', 'glucose sensing'], areas: ['biosensors', 'point-of-care diagnostics'], products: ['emstat4s', 'palmsens4'], summary: 'Builds low-cost screen-printed biosensors for glucose and lactate, aimed at point-of-care diagnostics.' },
  { topics: ['corrosion', 'protective coatings', 'steel in concrete'], areas: ['corrosion', 'coatings'], products: ['palmsens4'], summary: 'Studies corrosion of reinforcing steel and evaluates protective coatings with polarisation and EIS measurements.' },
  { topics: ['supercapacitors', 'carbon nanomaterials', 'cyclic voltammetry'], areas: ['supercapacitors', 'energy storage'], products: ['palmsens4', 'emstat4s'], summary: 'Synthesises porous carbon electrodes for supercapacitors and measures capacitance and rate performance.' },
  { topics: ['electrocatalysis', 'hydrogen evolution', 'water splitting'], areas: ['electrocatalysis', 'green hydrogen'], products: ['palmsens4', 'multipalmsens4'], summary: 'Designs transition-metal electrocatalysts for hydrogen and oxygen evolution in alkaline water splitting.' },
  { topics: ['fuel cells', 'proton exchange membranes'], areas: ['fuel cells', 'energy conversion'], products: ['palmsens4'], summary: 'Works on membrane-electrode assemblies for proton-exchange-membrane fuel cells and their durability.' },
];
const SCORE_NOTES = ['Strong fit: active electrochemistry group with recent impedance work and new funding.', 'Good fit: uses cyclic voltammetry routinely; no potentiostat brand seen in papers.', 'Moderate fit: electrochemistry is one technique among several in the group.', 'Strong fit: corrosion lab with heavy EIS use and an ageing competitor instrument.'];

const people = new Set<string>();
function person() {
  for (;;) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    if (people.has(name)) continue;
    people.add(name);
    const [f, l] = name.toLowerCase().split(' ');
    return { name, email: `${f}.${l}@example.edu` };
  }
}

// --- Team (copied users + fictional executives) ---------------------------------------------------------
const OWNER_EMAIL = 'saiethihaschanda@gmail.com';
const EXECS = [
  { uid: 'demo-priya', email: 'priya.nair@example.edu', name: 'Priya Nair', role: 'sales' },
  { uid: 'demo-arjun', email: 'arjun.mehta@example.edu', name: 'Arjun Mehta', role: 'sales' },
  { uid: 'demo-rahul', email: 'rahul.verma@example.edu', name: 'Rahul Verma', role: 'sales' },
  { uid: 'demo-kavitha', email: 'kavitha.s@example.edu', name: 'Kavitha S', role: 'viewer' },
] as const;

async function main() {
  await mongoose.connect(env.MONGO_URI, { dbName: env.MONGO_DB_NAME });
  const demo = mongoose.connection.db!;
  const live = mongoose.connection.getClient().db('classone_automation');

  console.log('Clearing the demo database…');
  for (const c of await demo.listCollections().toArray()) await demo.collection(c.name).deleteMany({});

  // Public / own data from live: catalog, settings, the team's real accounts (their own), pipeline settings.
  const products = await live.collection('product_catalog').find({ isActive: true }).toArray();
  if (products.length) await demo.collection('product_catalog').insertMany(products);
  for (const name of ['app_settings', 'pipeline_settings']) {
    const docs = await live.collection(name).find().toArray();
    if (docs.length) await demo.collection(name).insertMany(docs);
  }
  const owners = await live.collection('users').find({ role: { $in: ['admin', 'sales'] } }).toArray();
  if (owners.length) await demo.collection('users').insertMany(owners);
  const owner = (owners.find((u) => String(u.email).toLowerCase() === OWNER_EMAIL) ?? owners[0]) as unknown as { email: string; name?: string } | undefined;
  const me = { email: owner?.email ?? OWNER_EMAIL, name: owner?.name ?? 'Sai Ethihas Chanda' };
  await AppUserModel.insertMany(EXECS.map((e) => ({ ...e })));
  if (!(await PipelineSettingsModel.exists({}))) await PipelineSettingsModel.create({ mode: 'manual', threshold: 40 });
  const productIds = new Set(products.map((p) => String(p.productId)));
  const prodName = (id: string) => String(products.find((p) => p.productId === id)?.name ?? id);
  const recommend = (ids: string[]) => ids.filter((id) => productIds.has(id));

  // --- Leads ------------------------------------------------------------------------------------------
  console.log('Leads…');
  type L = { id: string; name: string; email: string; inst: string; dept: string; title: string; topic: (typeof TOPICS)[number]; score: number; status: string };
  const leads: L[] = [];
  const titles = ['Professor', 'Associate Professor', 'Assistant Professor', 'Senior Scientist', 'Principal Scientist'];
  const statusPlan = [...Array(9).fill('pending_review'), ...Array(34).fill('approved'), ...Array(6).fill('customer'), ...Array(4).fill('rejected')];
  for (let i = 0; i < statusPlan.length; i++) {
    const p = person();
    const inst = INSTITUTES[i % INSTITUTES.length]!;
    const topic = TOPICS[i % TOPICS.length]!;
    const score = statusPlan[i] === 'rejected' ? int(18, 35) : int(52, 96);
    const title = pick(titles);
    const created = ago(int(1, 60) * D + int(0, 20) * H);
    const competitor = rand() < 0.35;
    const ours = !competitor && rand() < 0.25;
    const doc = await LeadModel.create({
      status: statusPlan[i],
      source: { type: i % 9 === 0 ? 'inbound_email' : i % 13 === 0 ? 'website_enquiry' : 'faculty_roster', discoveredAt: created },
      person: { name: `${title.includes('Professor') ? 'Prof.' : 'Dr.'} ${p.name}`, normalizedNameKey: normalizeNameKey(p.name), email: p.email, title, phone: rand() < 0.4 ? `+91 9${int(100000000, 999999999)}` : undefined, profileUrl: 'https://example.edu/faculty' },
      institution: {
        name: inst.name,
        normalizedNameKey: normalizeInstitutionKey(inst.name),
        department: pick(DEPTS),
        country: 'IN',
        affiliation: { status: rand() < 0.85 ? 'current' : 'unverified', verifiedAt: ago(int(2, 40) * D), source: 'orcid', lastSeenYear: 2026, directoryListed: rand() < 0.8, evidence: [{ source: 'orcid', institution: inst.name, current: true, detail: 'Employment listed as current on ORCID' }, { source: 'openalex', institution: inst.name, current: true, detail: 'Latest paper (2026) lists this institution' }] },
      },
      research: {
        summary: topic.summary,
        summaryGeneratedAt: created,
        topics: topic.topics,
        applicationAreas: topic.areas,
        recentPublications: [
          { title: `${topic.topics[0]![0]!.toUpperCase()}${topic.topics[0]!.slice(1)}: mechanisms and performance at practical loadings`, year: 2026 },
          { title: `In situ impedance study of ${topic.topics[1]}`, year: 2025 },
          { title: `A scalable route to ${topic.areas[0]} electrodes`, year: 2025 },
        ],
        recentGrants: [],
        instruments: competitor
          ? [{ brandKey: 'metrohm', brand: 'Metrohm Autolab', vendor: 'competitor', model: 'PGSTAT302N', evidence: 'Measurements were performed on a Metrohm Autolab PGSTAT302N potentiostat.', matchedVia: 'fulltext_search' }]
          : ours
            ? [{ brandKey: 'palmsens', brand: 'PalmSens', vendor: 'classone', model: 'PalmSens4', evidence: 'Electrochemical measurements used a PalmSens4 (PalmSens BV).', matchedVia: 'fulltext_search' }]
            : [],
        funding: rand() < 0.6 ? [{ agency: pick(['serb', 'anrf', 'dst', 'dbt'] as const), funder: pick(['Science and Engineering Research Board', 'Anusandhan National Research Foundation', 'Department of Science and Technology']), awardId: `CRG/202${int(4, 6)}/00${int(1000, 9999)}`, scheme: 'Core Research Grant', year: 2000 + int(24, 26), papers: int(1, 4), workTitle: 'A recent paper acknowledging this grant', workYear: 2026 }] : undefined,
        fundingCheckedAt: ago(5 * D),
      },
      aiScoring: {
        relevanceScore: score,
        relevanceReasoning: pick(SCORE_NOTES),
        qualificationSignals: { productRelevance: int(55, 98), institutionalStrength: int(60, 99), recency: int(50, 99), engagementPotential: int(40, 95) },
        recommendedProductIds: recommend(topic.products),
        recommendedProductNotes: `${prodName(topic.products[0]!)} suits their ${topic.areas[0]} work; ${topic.products[1] ? `${prodName(topic.products[1])} for multi-channel testing.` : ''}`,
        scoredAt: created,
        scoringModel: 'gemini-2.5-flash',
      },
      review: statusPlan[i] === 'pending_review' ? {} : { reviewedBy: pick([me.email, EXECS[0].email, EXECS[1].email]), reviewedAt: new Date(created.getTime() + int(1, 48) * H), decision: statusPlan[i] === 'rejected' ? 'rejected' : 'approved', rejectionReason: statusPlan[i] === 'rejected' ? 'Theoretical group — no experimental electrochemistry' : undefined },
      followUpStatusSummary: 'not_started',
      tags: i % 9 === 0 ? ['inbound-enquiry'] : i % 13 === 0 ? ['inbound-enquiry', 'website-enquiry'] : [],
      createdAt: created,
    });
    leads.push({ id: String(doc._id), name: doc.person!.name, email: p.email, inst: inst.name, dept: doc.institution!.department ?? '', title, topic, score, status: statusPlan[i]! });
  }
  const approved = leads.filter((l) => l.status === 'approved' || l.status === 'customer');

  // --- Prospects conveyor (faculty) -------------------------------------------------------------------
  console.log('Prospects…');
  const flowPlan: Array<[string, string, number]> = [
    ['verify', 'idle', 9], ['verify', 'processing', 2], ['score', 'idle', 7], ['score', 'review', 2], ['promote', 'idle', 6], ['promote', 'failed', 1], ['fill', 'idle', 3], ['fill', 'processing', 1],
  ];
  for (const [stage, state, n] of flowPlan) {
    for (let k = 0; k < n; k++) {
      const p = person();
      const inst = pick(INSTITUTES);
      const topic = pick(TOPICS);
      const scored = stage === 'promote' || stage === 'fill';
      await FacultyMemberModel.create({
        status: 'eligible',
        person: { name: p.name, normalizedNameKey: normalizeNameKey(p.name), email: stage === 'fill' ? undefined : rand() < 0.5 ? p.email : undefined, title: pick(titles) },
        role: { category: pick(['professor', 'scientist'] as const), rawTitle: pick(titles), basis: 'Title on the faculty page' },
        department: { name: pick(DEPTS), domain: pick(['chemistry', 'chemical_engineering', 'materials', 'energy'] as const) },
        institution: { name: inst.name, normalizedNameKey: normalizeInstitutionKey(inst.name), country: 'IN', affiliation: stage === 'verify' ? undefined : { status: 'current', verifiedAt: ago(2 * D), source: 'orcid' } },
        sources: [{ type: 'faculty_page', recordId: randomUUID(), url: 'https://example.edu/faculty', title: 'Faculty directory', seenAt: ago(3 * D) }],
        research: { topics: topic.topics, worksCount: int(20, 140), hIndex: int(8, 45), lastPublicationYear: 2026, applicationAreas: scored ? topic.areas : undefined },
        relevance: scored || state === 'review' ? { score: state === 'review' ? int(38, 45) : int(45, 92), reasoning: pick(SCORE_NOTES), recommendedProductIds: recommend(topic.products), scoredAt: ago(D), scoringModel: 'gemini-2.5-flash' } : undefined,
        flow: { stage, state, attempts: state === 'failed' ? 3 : 0, lastError: state === 'failed' ? 'No email address found after three tries' : undefined, note: state === 'review' ? 'Score close to the threshold — check before promoting' : undefined, updatedAt: ago(int(1, 30) * H) },
        tags: [],
      });
    }
  }
  for (const l of leads.slice(0, 18)) {
    await FacultyMemberModel.create({
      status: 'promoted',
      person: { name: l.name.replace(/^(Prof\.|Dr\.) /, ''), normalizedNameKey: normalizeNameKey(l.name), email: l.email, title: l.title },
      role: { category: 'professor', rawTitle: l.title },
      department: { name: l.dept, domain: 'chemistry' },
      institution: { name: l.inst, normalizedNameKey: normalizeInstitutionKey(l.inst), country: 'IN', affiliation: { status: 'current', verifiedAt: ago(10 * D), source: 'orcid' } },
      sources: [{ type: 'faculty_page', recordId: randomUUID(), url: 'https://example.edu/faculty', seenAt: ago(20 * D) }],
      research: { topics: l.topic.topics, applicationAreas: l.topic.areas },
      relevance: { score: l.score, reasoning: pick(SCORE_NOTES), recommendedProductIds: recommend(l.topic.products), scoredAt: ago(15 * D) },
      leadId: l.id,
      promotedAt: ago(14 * D),
      flow: { stage: 'done', state: 'idle', updatedAt: ago(14 * D) },
    });
  }
  for (let k = 0; k < 5; k++) {
    const p = person();
    const inst = pick(INSTITUTES);
    await FacultyMemberModel.create({ status: 'excluded', exclusionReason: pick(['Retired', 'Administrative role', 'Department outside the target areas', 'Moved abroad']), person: { name: p.name, normalizedNameKey: normalizeNameKey(p.name) }, role: { category: 'excluded', rawTitle: 'Registrar' }, department: { name: 'Administration', domain: 'other' }, institution: { name: inst.name, country: 'IN' }, flow: { stage: 'verify', state: 'idle' } });
  }
  const runs = [
    { kind: 'pipeline', status: 'done', startedAt: ago(2 * D + 3 * H), finishedAt: ago(2 * D), counters: { found: 64, verified: 58, scored: 52, promoted: 21, filled: 18 }, options: { institutes: ['Indian Institute of Technology Madras', 'Anna University'], label: 'Chennai institutes' } },
    { kind: 'pipeline', status: 'done', startedAt: ago(9 * D + 5 * H), finishedAt: ago(9 * D), counters: { found: 112, verified: 101, scored: 96, promoted: 34, filled: 30 }, options: { institutes: ['Indian Institute of Science', 'Indian Institute of Technology Bombay'], label: 'Weekly sweep' } },
    { kind: 'pipeline', status: 'running', stage: 'score', progress: 0.62, startedAt: ago(40 * 60_000), counters: { found: 23, verified: 21, scored: 13 }, options: { institutes: ['Indian Institute of Technology Hyderabad'], label: 'IIT Hyderabad' } },
  ];
  for (const r of runs) await RosterRunModel.create({ _id: randomUUID(), ...r, notification: r.status === 'done' ? { to: me.email, sentAt: r.finishedAt } : undefined });
  await PipelineScheduleModel.create({ name: 'Weekly sweep — top institutes', type: 'recurring', weekdays: [1], time: '06:00', enabled: true, nextRunAt: dayAt(((8 - new Date().getDay()) % 7) || 7, 6), lastRunAt: ago(9 * D), config: { institutes: ['Indian Institute of Science', 'Indian Institute of Technology Bombay'] }, createdBy: me.email });

  // --- Conversations ------------------------------------------------------------------------------------
  console.log('Conversations…');
  const thread = async (l: L, t: Record<string, unknown>) => {
    const doc = await EmailThreadModel.create({ leadId: l.id, contactEmail: l.email, contactName: l.name, leadEmailSnapshot: l.email, provider: 'gmail', providerThreadId: `demo-${randomUUID()}`, followUp: { attemptsSent: 0, maxAttempts: 2, replyDetected: false }, ...t });
    await ContactModel.updateOne({ email: l.email }, { $set: { name: l.name, institution: l.inst, leadId: l.id, lastMessageAt: ago(H) } }, { upsert: true });
    return String(doc._id);
  };
  const msg = (dir: 'outbound' | 'inbound', type: string, subject: string, body: string, at: Date, extra: Record<string, unknown> = {}) => ({ messageId: `demo-${randomUUID()}`, direction: dir, type, subject, bodyText: body, sentAt: at, rfcMessageId: `<${randomUUID()}@demo>`, ...(dir === 'inbound' ? { readAt: extra.unread ? undefined : at } : {}), ...extra });
  const [qL, sL, fL, cL, rL, nL, wL, mL, oL, uL, hL] = approved;
  const sales = [me.email, EXECS[0].email, EXECS[1].email];
  const outreach = (l: L, at: Date, by = me.email) => msg('outbound', 'initial_outreach', `Electrochemical instrumentation for ${l.inst}`, `Dear ${l.name.split(' ').slice(0, 2).join(' ')},\n\nI came across your recent work on ${l.topic.topics[0]} and thought ${prodName(l.topic.products[0]!)} could support your measurements…\n\nTeam Class One Systems`, at, { sentBy: by, draftedBy: 'ai' });

  // a) Quote request — reply drafted, waiting 5 h.
  await thread(qL!, { subjectLine: `Quotation request – ${prodName('emstat4s')}`, status: 'draft', awaitingReplySince: ago(5 * H), messages: [msg('inbound', 'reply', `Quotation request – ${prodName('emstat4s')}`, `Hello Class One team,\n\nPlease send a quotation for 2 units of ${prodName('emstat4s')} with the standard electrode cable and a set of screen-printed electrodes, delivered to ${qL!.inst}. We need this for a grant purchase before 31 March.\n\nThanks,\n${qL!.name}`, ago(5 * H), { intent: 'quote_request', summary: 'Wants a quotation for 2 EmStat4S units with cables and electrodes, for a grant purchase before 31 March.', unread: true })], draftType: 'response', draftSubject: `Re: Quotation request – ${prodName('emstat4s')}`, draftBody: `Dear ${qL!.name.split(' ').slice(0, 2).join(' ')},\n\nThank you for your request. We will send a formal quotation for two ${prodName('emstat4s')} units with the standard electrode cable and a set of screen-printed electrodes, delivered to ${qL!.inst}, within one working day.\n\nCould you confirm the billing address and whether you need the quotation in the name of the institute or the project?\n\nTeam Class One Systems`, draftModel: 'gemini-2.5-flash', draftCreatedAt: ago(5 * H), draftIntent: 'quote_request' });
  // b) Support request — overdue 3 days, holding reply sent.
  await ContactModel.updateOne({ email: sL!.email }, { $set: { autoReply: true } }, { upsert: true });
  await thread(sL!, { subjectLine: 'PalmSens4 not connecting', status: 'draft', awaitingReplySince: ago(3 * D + 2 * H), autoReplySentAt: ago(3 * D), messages: [msg('inbound', 'reply', 'PalmSens4 not connecting', 'Hi,\n\nOur PalmSens4 stopped connecting to PSTrace after a Windows update. The device shows up in Device Manager but PSTrace says "no instrument found". Can you help?', ago(3 * D + 2 * H), { intent: 'support_request', summary: 'PalmSens4 not detected by PSTrace after a Windows update.' }), msg('outbound', 'response', 'Re: PalmSens4 not connecting', `Dear ${sL!.name.split(' ').slice(0, 2).join(' ')},\n\nThank you for your message — we have it and a member of the team will get back to you shortly.\n\nTeam Class One Systems`, ago(3 * D), { sentBy: 'auto-reply', draftedBy: 'ai', holding: true })], draftType: 'response', draftSubject: 'Re: PalmSens4 not connecting', draftBody: 'Dear …,\n\nThis is usually the USB driver being replaced by the update. Please reinstall the PalmSens driver from PSTrace → Help → Install drivers, then reconnect the instrument…\n\nTeam Class One Systems', draftModel: 'gemini-2.5-flash', draftCreatedAt: ago(3 * D), draftIntent: 'support_request' });
  // c) Follow-up 1 drafted.
  await thread(fL!, { subjectLine: `Electrochemical instrumentation for ${fL!.inst}`, status: 'draft', messages: [outreach(fL!, ago(7 * D))], followUp: { attemptsSent: 0, maxAttempts: 2, replyDetected: false, lastOutboundAt: ago(7 * D) }, draftType: 'follow_up_1', draftSubject: `Re: Electrochemical instrumentation for ${fL!.inst}`, draftBody: `Dear ${fL!.name.split(' ').slice(0, 2).join(' ')},\n\nFollowing up on my note last week — happy to share application notes on ${fL!.topic.topics[0]} measurements, or arrange a short online demo.\n\nTeam Class One Systems`, draftModel: 'gemini-2.5-flash', draftCreatedAt: ago(2 * H) });
  // d) Check-in drafted (quiet 120 days).
  await thread(cL!, { subjectLine: 'Re: Impedance setup for coin cells', status: 'draft', messages: [outreach(cL!, ago(128 * D)), msg('inbound', 'reply', 'Re: Impedance setup for coin cells', 'Thanks — we will revisit this after our budget review next year.', ago(120 * D), { intent: 'other', summary: 'Will revisit after next year’s budget review.' })], draftType: 'check_in', draftSubject: 'Re: Re: Impedance setup for coin cells', draftBody: `Dear ${cL!.name.split(' ').slice(0, 2).join(' ')},\n\nWhen we last spoke you mentioned revisiting your coin-cell impedance setup after the budget review. Since then we have added a new multi-channel option that runs several cells in parallel. Have your plans for the coming months taken shape?\n\nTeam Class One Systems`, draftModel: 'gemini-2.5-flash', draftCreatedAt: ago(4 * H) });
  await LeadModel.updateOne({ _id: cL!.id }, { $set: { lastCheckInAt: ago(4 * H) } });
  // e) Replied and answered.
  await thread(rL!, { subjectLine: `Electrochemical instrumentation for ${rL!.inst}`, status: 'replied', messages: [outreach(rL!, ago(12 * D)), msg('inbound', 'reply', `Re: Electrochemical instrumentation for ${rL!.inst}`, 'This looks relevant — can you share the specifications and an indicative price?', ago(10 * D), { intent: 'product_enquiry', summary: 'Asks for specifications and an indicative price.' }), msg('outbound', 'response', `Re: Electrochemical instrumentation for ${rL!.inst}`, 'Dear …, please find the specifications attached…', ago(10 * D - 3 * H), { sentBy: EXECS[0].email, draftedBy: 'ai' })], followUp: { attemptsSent: 0, maxAttempts: 2, replyDetected: true } });
  // f) Not interested → closed.
  await thread(nL!, { subjectLine: `Electrochemical instrumentation for ${nL!.inst}`, status: 'closed', closedReason: 'replied', messages: [outreach(nL!, ago(20 * D)), msg('inbound', 'reply', 'Re: Electrochemical instrumentation', 'Thank you, but we are fully equipped at the moment.', ago(18 * D), { intent: 'not_interested', summary: 'Not interested — fully equipped.' }), msg('outbound', 'response', 'Re: Electrochemical instrumentation', 'Thank you for letting us know…', ago(18 * D - 2 * H), { sentBy: me.email, draftedBy: 'ai' })] });
  // g) Website enquiry → new lead, reply drafted.
  await thread(wL!, { subjectLine: 'Website enquiry: Bio Sensing, Point of Care', status: 'draft', awaitingReplySince: ago(2 * H), messages: [msg('inbound', 'reply', 'Website enquiry: Bio Sensing, Point of Care', `Sent through the enquiry form on classonesystems.in.\n\nName: ${wL!.name}\nEmail: ${wL!.email}\nInstitute: ${wL!.inst}\nRequirement: A portable potentiostat for a glucose biosensor project\nInterested in: Bio Sensing, Point of Care`, ago(2 * H), { intent: 'product_enquiry', summary: 'Website form: wants a portable potentiostat for a glucose biosensor project.', unread: true })], draftType: 'response', draftSubject: 'Re: Website enquiry: Bio Sensing, Point of Care', draftBody: 'Dear …,\n\nThank you for your enquiry through our website. For a glucose biosensor project, the EmStat4S is a compact choice…\n\nTeam Class One Systems', draftModel: 'gemini-2.5-flash', draftCreatedAt: ago(2 * H), draftIntent: 'product_enquiry' });
  await InboundEmailModel.create({ gmailId: `enquiry:demo-${randomUUID()}`, from: wL!.email, fromName: wL!.name, subject: 'Website enquiry: Bio Sensing, Point of Care', receivedAt: ago(2 * H), leadId: wL!.id, matchedBy: 'new_lead', intent: 'product_enquiry', action: 'Reply drafted — ready in Conversations', status: 'processed' });
  // h) Meeting request → demo booked.
  await thread(mL!, { subjectLine: 'Demo request', status: 'replied', messages: [msg('inbound', 'reply', 'Demo request', 'Could we see a demo of PalmSens4 for our battery group next week?', ago(3 * D), { intent: 'meeting_request', summary: 'Asks for a PalmSens4 demo next week.' }), msg('outbound', 'response', 'Re: Demo request', 'Happy to — here is our booking page: …', ago(3 * D - 4 * H), { sentBy: EXECS[1].email, draftedBy: 'ai' })], followUp: { attemptsSent: 0, maxAttempts: 2, replyDetected: true } });
  // i) Out of office → follow-up moved.
  await thread(oL!, { subjectLine: `Electrochemical instrumentation for ${oL!.inst}`, status: 'open', messages: [outreach(oL!, ago(6 * D)), msg('inbound', 'reply', 'Automatic reply: Out of office', 'I am away until the 10th with limited access to email.', ago(6 * D - H), { intent: 'out_of_office', summary: 'Away until the 10th.' })], followUp: { attemptsSent: 0, maxAttempts: 2, replyDetected: false, nextCheckAt: ahead(5 * D) } });
  // j) Unsubscribe.
  await LeadModel.updateOne({ _id: uL!.id }, { $set: { doNotContact: true } });
  await ContactModel.updateOne({ email: uL!.email }, { $set: { doNotContact: true } }, { upsert: true });
  await thread(uL!, { subjectLine: 'Please remove me', status: 'closed', closedReason: 'replied', messages: [outreach(uL!, ago(9 * D)), msg('inbound', 'reply', 'Please remove me', 'Please remove me from your mailing list.', ago(8 * D), { intent: 'unsubscribe', summary: 'Asked to be removed from the mailing list.' })] });
  // k) Follow-up sent automatically.
  await thread(hL!, { subjectLine: `Electrochemical instrumentation for ${hL!.inst}`, status: 'open', messages: [outreach(hL!, ago(14 * D)), msg('outbound', 'follow_up_1', `Re: Electrochemical instrumentation for ${hL!.inst}`, 'Following up on my earlier note…', ago(7 * D), { sentBy: 'auto-followup', draftedBy: 'ai' })], followUp: { attemptsSent: 1, maxAttempts: 2, replyDetected: false, lastOutboundAt: ago(7 * D), nextCheckAt: ahead(D) } });

  // Spread outreach over the last month for the dashboard trend: AI drafts approved, hand-written, automatic.
  for (const l of approved.slice(11, 34)) {
    const at = ago(int(1, 29) * D + int(9, 17) * H);
    const by = pick(sales);
    const kind = rand();
    const replied = rand() < 0.3;
    await thread(l, {
      subjectLine: `Electrochemical instrumentation for ${l.inst}`,
      status: replied ? 'replied' : 'open',
      messages: [
        msg('outbound', 'initial_outreach', `Electrochemical instrumentation for ${l.inst}`, 'Dear …', at, { sentBy: by, draftedBy: kind < 0.7 ? 'ai' : 'human' }),
        ...(replied ? [msg('inbound', 'reply', `Re: Electrochemical instrumentation for ${l.inst}`, 'Thanks, please share more details.', new Date(at.getTime() + int(4, 60) * H), { intent: 'product_enquiry', summary: 'Asks for more details.' }), msg('outbound', 'response', 'Re: …', 'Dear …, details below…', new Date(at.getTime() + int(62, 90) * H), { sentBy: by, draftedBy: 'ai' })] : []),
      ],
      followUp: { attemptsSent: 0, maxAttempts: 2, replyDetected: replied, nextCheckAt: replied ? undefined : ahead(int(1, 6) * D) },
    });
  }

  // --- Campaigns ---------------------------------------------------------------------------------------
  console.log('Campaigns…');
  const book = 'https://classone-discovery.web.app/book';
  const webinar = await CampaignModel.create({
    name: 'EIS webinar invitation — December',
    subject: '{first_name}, join our free EIS webinar on 12 December',
    preheader: 'One hour, live, with Q&A — impedance spectroscopy for battery and corrosion research',
    status: 'done',
    createdBy: me.email,
    startedAt: ago(9 * D),
    finishedAt: ago(9 * D - 2 * H),
    lastSentAt: ago(9 * D - 2 * H),
    paceSeconds: 30,
    audience: { statuses: ['approved', 'customer'], applicationAreas: ['battery research', 'corrosion', 'energy storage'] },
    blocks: [
      { id: 'h', type: 'heading', text: 'Impedance spectroscopy, explained in one hour' },
      { id: 't', type: 'text', text: 'Dear {title|Dr.} {last_name|},\n\nJoin our application scientists for a free live webinar on electrochemical impedance spectroscopy — from setting up a measurement to fitting equivalent circuits — with examples from battery and corrosion research.' },
      { id: 'p', type: 'product', productId: 'palmsens4' },
      { id: 'b', type: 'button', label: 'Book a demo instead', url: book },
    ],
  });
  const wid = String(webinar._id);
  const recips = approved.slice(0, 32);
  let r = 0;
  for (const l of recips) {
    const sentAt = new Date(now - 9 * D + r * 30_000);
    const opened = r < 22;
    const clickedProduct = r < 13;
    const clickedBook = r >= 4 && r < 12;
    const booked = r >= 4 && r < 8;
    const tid = await thread(l, { subjectLine: `${l.name.split(' ')[1]}, join our free EIS webinar on 12 December`, status: r % 7 === 0 ? 'replied' : 'open', messages: [msg('outbound', 'campaign', 'Join our free EIS webinar on 12 December', '…', sentAt, { sentBy: me.email, draftedBy: 'human' }), ...(r % 7 === 0 ? [msg('inbound', 'reply', 'Re: EIS webinar', 'Registered — will the recording be shared?', new Date(sentAt.getTime() + 20 * H), { intent: 'other', summary: 'Asks whether the recording will be shared.' })] : [])], followUp: { attemptsSent: 0, maxAttempts: 0, replyDetected: r % 7 === 0 } });
    const clicks = [...(clickedProduct ? [{ url: 'https://classonesystems.in/product/palmsens4', at: new Date(sentAt.getTime() + 2 * H) }] : []), ...(clickedBook ? [{ url: book, at: new Date(sentAt.getTime() + 3 * H) }] : [])];
    await CampaignRecipientModel.create({ campaignId: wid, leadId: l.id, email: l.email, name: l.name, status: 'sent', sentAt, threadId: tid, ...(opened || clicks.length ? { openedAt: new Date(sentAt.getTime() + H), opens: int(1, 4) } : {}), ...(clicks.length ? { clicks: clicks.length, clickedAt: clicks[0]!.at, clickLog: clicks } : {}) });
    if (booked) await ScheduleEventModel.create({ title: `Online demo — ${l.name}`, type: 'demo', start: dayAt(int(1, 6), pick([10, 11, 14, 15])), end: new Date(dayAt(1, 10).getTime() + 30 * 60_000), leadId: l.id, contactEmail: l.email, contactName: l.name, institution: l.inst, mode: 'online', assignee: EXECS[0].email, assigneeName: EXECS[0].name, source: 'booking', booking: { name: l.name, email: l.email, institution: l.inst, message: 'Interested in EIS for coin cells' }, createdAt: new Date(sentAt.getTime() + 4 * H) });
    r += 1;
  }
  // Fix booked demo end times (start + 30 min).
  for (const e of await ScheduleEventModel.find({ source: 'booking' })) await ScheduleEventModel.updateOne({ _id: e._id }, { $set: { end: new Date(e.start.getTime() + 30 * 60_000) } });
  await CampaignRecipientModel.create({ campaignId: wid, email: 'no.email@example.edu', name: 'Optout example', status: 'skipped', error: 'Asked not to be contacted' });

  // New-product launch (Auto: scheduled after the 24 h review window).
  const launchProduct = products.find((p) => /pico/i.test(String(p.name))) ?? products[0];
  const launchName = String(launchProduct?.name ?? 'EmStat Pico Module');
  const launch = await CampaignModel.create({
    name: `New product: ${launchName}`,
    kind: 'product_launch',
    productId: launchProduct?.productId,
    subject: `Introducing ${launchName} from Class One Systems`,
    preheader: 'A compact module for embedding electrochemistry into your own devices',
    status: 'scheduled',
    sendAt: ahead(19 * H),
    reviewUntil: ahead(19 * H),
    createdBy: 'product-launch',
    paceSeconds: 30,
    audience: { statuses: ['approved', 'customer'], leadIds: approved.slice(0, 26).map((l) => l.id) },
    blocks: [
      { id: 'h', type: 'heading', text: launchName },
      { id: 't', type: 'text', text: `Dear {title|Dr.} {last_name|},\n\nWe have added ${launchName} to our range — a compact module for building electrochemical measurements into your own devices and sensors.` },
      { id: 'p', type: 'product', productId: String(launchProduct?.productId ?? '') },
      { id: 'b', type: 'button', label: 'See the product', url: `https://classonesystems.in/product/${launchProduct?.productId ?? ''}` },
    ],
  });
  for (const l of approved.slice(0, 26)) await CampaignRecipientModel.create({ campaignId: String(launch._id), leadId: l.id, email: l.email, name: l.name, status: 'queued' });
  await ProductLaunchModel.create({ productId: String(launchProduct?.productId ?? 'demo'), productName: launchName, detectedAt: ago(5 * H), status: 'ready', campaignId: String(launch._id), recipients: 26 });
  await CampaignModel.create({ name: 'Corrosion workstation offer — Q1', subject: 'Corrosion testing, made simpler', status: 'draft', createdBy: EXECS[1].email, paceSeconds: 30, audience: { statuses: ['approved'], applicationAreas: ['corrosion'] }, blocks: [{ id: 'h', type: 'heading', text: 'Corrosion testing, made simpler' }, { id: 't', type: 'text', text: 'Dear {title|Dr.} {last_name|},\n\nDraft — offer details to follow.' }] });
  await setState('launchSettings', { mode: 'auto', minRelevance: 60, maxRecipients: 200 });
  await setState('websiteCatalogLastSync', { at: ago(12 * 60_000).toISOString(), seen: products.length, added: 1, failed: 0 });
  await setState('websiteCatalogBaseline', true);

  // --- Schedules -----------------------------------------------------------------------------------------
  console.log('Schedules…');
  const [priya, arjun, rahul] = EXECS;
  const ev = (e: Record<string, unknown>) => ScheduleEventModel.create({ mode: 'in_person', source: 'app', createdBy: me.email, ...e });
  const v1 = leads[2]!;
  const v2 = leads[5]!;
  const v3 = leads[7]!;
  await ev({ title: `Visit — ${v1.name}`, type: 'visit', start: today(10, 30), end: today(11, 30), leadId: v1.id, contactName: v1.name, contactEmail: v1.email, institution: v1.inst, address: `${v1.dept}, ${v1.inst}`, assignee: priya.email, assigneeName: priya.name, status: 'done', onTheWay: { at: today(9, 50), lat: 13.0067, lng: 80.2206 }, checkIn: { at: today(10, 34), lat: 12.9915, lng: 80.2337, accuracy: 18 }, checkOut: { at: today(11, 41), lat: 12.9916, lng: 80.2335 }, outcome: 'Demoed PalmSens4 to the group; they want a quote for two units and a training session in January.', notes: 'Bring the PalmSens4 demo kit and coin-cell holder.' });
  await ev({ title: `Visit — ${v2.name}`, type: 'visit', start: today(14, 0), end: today(15, 0), leadId: v2.id, contactName: v2.name, contactEmail: v2.email, institution: v2.inst, address: `${v2.dept}, ${v2.inst}`, assignee: priya.email, assigneeName: priya.name, status: 'checked_in', onTheWay: { at: today(13, 25), lat: 12.99, lng: 80.23 }, checkIn: { at: today(13, 58), lat: 12.9718, lng: 80.2337, accuracy: 22 }, notes: 'Follow up on the corrosion cell question from last month.' });
  await ev({ title: `Visit — ${v3.name}`, type: 'visit', start: today(15, 30), end: today(16, 30), leadId: v3.id, contactName: v3.name, contactEmail: v3.email, institution: v3.inst, address: `${v3.dept}, ${v3.inst}`, assignee: arjun.email, assigneeName: arjun.name, status: 'on_the_way', onTheWay: { at: today(14, 50), lat: 19.1334, lng: 72.9133 } });
  await ev({ title: 'Installation & training — CSIR-CECRI', type: 'visit', start: today(11, 0), end: today(13, 0), contactName: 'Battery lab', institution: 'CSIR-Central Electrochemical Research Institute', address: 'CSIR-CECRI, Karaikudi', assignee: rahul.email, assigneeName: rahul.name, status: 'done', checkIn: { at: today(11, 4), lat: 10.0717, lng: 78.7823 }, checkOut: { at: today(13, 15), lat: 10.0716, lng: 78.7825 }, outcome: 'Installed MultiPalmSens4; trained 4 students.' });
  await ev({ title: `Visit — ${leads[9]!.name}`, type: 'visit', start: dayAt(-1, 15), end: dayAt(-1, 16), leadId: leads[9]!.id, contactName: leads[9]!.name, institution: leads[9]!.inst, address: leads[9]!.inst, assignee: arjun.email, assigneeName: arjun.name, status: 'scheduled' });
  await ev({ title: 'Team review — weekly pipeline', type: 'meeting', start: dayAt(1, 9, 30), end: dayAt(1, 10, 15), mode: 'online', meetingLink: 'https://meet.google.com/abc-defg-hij', notes: 'Look at the Field board and the campaign results.' });
  await ev({ title: `Call — ${leads[11]!.name}`, type: 'call', start: dayAt(2, 16), end: dayAt(2, 16, 30), leadId: leads[11]!.id, contactName: leads[11]!.name, institution: leads[11]!.inst, mode: 'online', assignee: me.email, assigneeName: me.name });
  await ev({ title: `Visit — ${leads[13]!.name}`, type: 'visit', start: dayAt(3, 11), end: dayAt(3, 12), leadId: leads[13]!.id, contactName: leads[13]!.name, institution: leads[13]!.inst, address: leads[13]!.inst, assignee: rahul.email, assigneeName: rahul.name });
  await ev({ title: 'Trade show — Electrochem India', type: 'other', start: dayAt(8, 9), end: dayAt(9, 18), address: 'Bengaluru International Exhibition Centre', assignee: arjun.email, assigneeName: arjun.name });
  await ev({ title: 'Leave', type: 'blocked', start: dayAt(5, 9), end: dayAt(5, 18), assignee: priya.email, assigneeName: priya.name });
  await setState('bookingSettings', { enabled: true, title: 'Product demo with Class One Systems', days: [1, 2, 3, 4, 5], startTime: '10:00', endTime: '17:00', durationMinutes: 30, bufferMinutes: 15, horizonDays: 21, noticeHours: 18, mode: 'online', assignee: priya.email, intro: 'Pick a time for a short online demo of our electrochemical instruments. We will email you the meeting link.' });

  // --- Activity log ----------------------------------------------------------------------------------------
  console.log('Activity…');
  const acts: Array<[number, string, string | null, string, string?]> = [
    [5, 'reply_detected', null, `${qL!.name} wrote: Wants a quotation for 2 EmStat4S units (quote request)`, qL!.id],
    [2, 'reply_detected', null, `${wL!.name} wrote: Website form — portable potentiostat for a glucose biosensor (product enquiry) — new lead created`, wL!.id],
    [3, 'visit_checked_in', priya.email, `${priya.name} checked in at Visit — ${v2.name}`, v2.id],
    [6, 'visit_checked_out', priya.email, `${priya.name} finished Visit — ${v1.name}: Demoed PalmSens4; they want a quote for two units`, v1.id],
    [8, 'booking_created', null, `${leads[5]!.name} booked a demo for next Tuesday, 11:00`, leads[5]!.id],
    [10, 'user_action', me.email, `Approved a lead — ${leads[14]!.name}, ${leads[14]!.inst}`, leads[14]!.id],
    [11, 'email_sent', EXECS[0].email, `Reply sent to ${rL!.name}`, rL!.id],
    [14, 'follow_up_sent', null, `Follow-up sent automatically to ${hL!.name}`, hL!.id],
    [20, 'outreach_batch_completed', null, `New product ${launchName}: outreach to 26 matched people scheduled`],
    [26, 'user_action', EXECS[1].email, 'Created a campaign'],
    [30, 'discovery_run_completed', null, 'Prospects run finished — 21 new leads from 64 people (Chennai institutes)'],
    [40, 'user_action', me.email, 'Set follow-ups to Manual'],
    [52, 'user_action', me.email, "Changed a user's role to sales"],
  ];
  for (const [hoursAgo, type, actor, message, leadId] of acts) {
    const name = actor ? (EXECS.find((e) => e.email === actor)?.name ?? me.name) : undefined;
    await ActivityLogModel.create({ type, severity: 'info', message, relatedLeadId: leadId, actor: actor ?? undefined, actorName: name, createdAt: ago(hoursAgo * H) });
  }

  await setState('followUpMode', 'manual');
  await setState('reengageSettings', { enabled: true, quietDays: 90, dailyMax: 10 });
  await setState('reengageLastDay', new Date(now + 330 * 60_000).toISOString().slice(0, 10));
  await setState('weeklySummaryWeek', '2000-01-03');
  await setState('websiteEnquiriesBaseline', true);
  console.log(`Done: ${leads.length} leads, ${await FacultyMemberModel.countDocuments()} prospects, ${await EmailThreadModel.countDocuments()} conversations, ${await CampaignModel.countDocuments()} campaigns, ${await ScheduleEventModel.countDocuments()} events.`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
