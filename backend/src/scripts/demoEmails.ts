/**
 * Sends one of each email the app produces, from the DEMO database, to the owner's own address —
 * for the feature guide's inbox screenshots. Fictional data only; refuses any database but the demo.
 *
 *   MONGO_DB_NAME=classone_demo APP_URL=https://classone-discovery.web.app npx tsx src/scripts/demoEmails.ts
 */
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { CampaignModel } from '../models/campaign.model.js';
import { EmailThreadModel } from '../models/emailThread.model.js';
import { LeadModel } from '../models/lead.model.js';
import { RosterRunModel } from '../models/rosterRun.model.js';
import { ScheduleEventModel } from '../models/scheduleEvent.model.js';
import { getState, setState } from '../models/systemState.model.js';
import { repositories } from '../repositories/index.js';
import { normalizeInstitutionKey, normalizeNameKey } from '../utils/normalize.js';

if (env.MONGO_DB_NAME !== 'classone_demo') {
  console.error('Demo database only.');
  process.exit(1);
}
const ME = 'saiethihaschanda@gmail.com';
const only = new Set(process.argv.slice(2));
const want = (k: string) => !only.size || only.has(k);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const H = 3_600_000;

await mongoose.connect(env.MONGO_URI, { dbName: env.MONGO_DB_NAME });
const { sendOnNewThread, sendOnThread } = await import('../services/email/outreachService.js');
const { notifyHoldingReply, digestTick } = await import('../services/email/replyWatch.js');
const { notifyAutoFollowUp } = await import('../services/email/followUpScheduler.js');
const { notifyTeam, getLaunchSettings } = await import('../services/campaigns/productLaunch.js');
const { duplicateCampaign, updateCampaign, startCampaign } = await import('../services/campaigns/campaignService.js');
const { sendWeeklySummary } = await import('../services/reports/weeklySummary.js');
const { notifyAssignee, morningDigest, book, getBookingSettings, setBookingSettings, freeSlots, getEvent } = await import('../services/schedules/scheduleService.js');
const { notifyFinishedRuns } = await import('../services/pipeline/runNotifier.js');

// The sample customer whose emails land in the owner's inbox.
let lead = await LeadModel.findOne({ 'person.email': ME }).lean();
if (!lead) {
  lead = (
    await LeadModel.create({
      status: 'approved',
      source: { type: 'faculty_roster', discoveredAt: new Date() },
      person: { name: 'Dr. Meera Krishnan', normalizedNameKey: normalizeNameKey('Meera Krishnan'), email: ME, title: 'Associate Professor' },
      institution: { name: 'Indian Institute of Technology Madras', normalizedNameKey: normalizeInstitutionKey('Indian Institute of Technology Madras'), department: 'Department of Chemistry', country: 'IN' },
      research: { summary: 'Develops sodium-ion battery cathodes and studies their degradation with impedance spectroscopy.', topics: ['sodium-ion batteries', 'impedance spectroscopy'], applicationAreas: ['battery research'], recentPublications: [], recentGrants: [], instruments: [] },
      aiScoring: { relevanceScore: 88, recommendedProductIds: ['palmsens4', 'multipalmsens4'] },
      review: { decision: 'approved', reviewedBy: ME, reviewedAt: new Date() },
      followUpStatusSummary: 'in_progress',
      tags: ['demo'],
    })
  ).toObject();
}
const leadId = String(lead._id);
const sign = 'Team Class One Systems';

if (want('outreach')) {
  const t = await repositories.threads.create({ leadId, contactEmail: ME, contactName: 'Dr. Meera Krishnan', leadEmailSnapshot: ME, subjectLine: 'Electrochemical instrumentation for IIT Madras', status: 'open', provider: 'gmail', messages: [], followUp: { attemptsSent: 0, maxAttempts: 2, replyDetected: false } });
  const sent = await sendOnNewThread(t, {
    to: ME,
    subject: 'Electrochemical instrumentation for IIT Madras',
    body: `Dear Dr. Krishnan,\n\nI read your recent paper on degradation of layered oxide cathodes in sodium-ion cells — the impedance data across cycling was very clear.\n\nClass One Systems supplies PalmSens potentiostats in India. For long cycling studies like yours, the MultiPalmSens4 runs up to eight cells in parallel, each with its own impedance analyser, so EIS can be recorded at every stage without moving cells between instruments.\n\nWould a short online demo with your own cell setup be useful? I am happy to work around your schedule.\n\n${sign}`,
    type: 'initial_outreach',
    draftedBy: 'ai',
    aiDraftModel: 'gemini-2.5-flash',
    sentBy: ME,
  });
  console.log('outreach sent');
  if (want('followup') || !only.size) {
    await pause(4000);
    await sendOnThread(sent, {
      to: ME,
      subject: 'Re: Electrochemical instrumentation for IIT Madras',
      body: `Dear Dr. Krishnan,\n\nFollowing up on my note last week — if a demo is not convenient right now, I can send two application notes instead: one on EIS during long-term cycling of coin cells, and one on running several cells in parallel.\n\nJust reply "notes" and I will send them over.\n\n${sign}`,
      type: 'follow_up_1',
      draftedBy: 'ai',
      sentBy: 'auto-followup',
      countsAsFollowUp: true,
    });
    const fresh = (await repositories.threads.findById(sent.id))!;
    await notifyAutoFollowUp(fresh, 'Dr. Meera Krishnan', ME, { subject: 'Re: Electrochemical instrumentation for IIT Madras', body: 'Dear Dr. Krishnan,\n\nFollowing up on my note last week — if a demo is not convenient right now, I can send two application notes instead…', number: 1 });
    console.log('follow-up + team notice sent');
  }
}

if (want('reply')) {
  const t = await repositories.threads.create({ leadId, contactEmail: ME, contactName: 'Dr. Meera Krishnan', leadEmailSnapshot: ME, subjectLine: 'Quotation request – MultiPalmSens4', status: 'open', provider: 'gmail', messages: [{ messageId: `demo-in-${Date.now()}`, direction: 'inbound', type: 'reply', subject: 'Quotation request – MultiPalmSens4', bodyText: 'Hello,\n\nPlease send a quotation for one MultiPalmSens4 with 8 channels and EIS on all channels, delivered to IIT Madras.\n\nRegards,\nMeera Krishnan', sentAt: new Date(Date.now() - 50 * H), intent: 'quote_request', summary: 'Wants a quotation for an 8-channel MultiPalmSens4 with EIS.' }], followUp: { attemptsSent: 0, maxAttempts: 2, replyDetected: true } });
  await EmailThreadModel.updateOne({ _id: t.id }, { $set: { awaitingReplySince: new Date(Date.now() - 50 * H) } });
  const lastIn = t.messages[0]!;
  const holding = `Dear Dr. Krishnan,\n\nThank you for your request for a quotation for the MultiPalmSens4 — we have received it, and a member of our team will send it to you shortly.\n\n${sign}`;
  const afterHold = await sendOnNewThread(t, { to: ME, subject: 'Re: Quotation request – MultiPalmSens4', body: holding, type: 'response', draftedBy: 'ai', sentBy: 'auto-reply', holding: true });
  await notifyHoldingReply(afterHold, 'Dr. Meera Krishnan', ME, lastIn, holding);
  console.log('holding reply + team notice sent');
  await pause(4000);
  await sendOnThread(afterHold, {
    to: ME,
    subject: 'Re: Quotation request – MultiPalmSens4',
    body: `Dear Dr. Krishnan,\n\nThank you for your request. We will send a formal quotation for one MultiPalmSens4 with eight channels and impedance (EIS) on every channel, delivered to IIT Madras, within one working day.\n\nTo make sure it is right first time, could you confirm:\n1. whether the quotation should be in the name of the institute or a specific project, and\n2. the billing address and GST number.\n\n${sign}`,
    type: 'response',
    draftedBy: 'ai',
    aiDraftModel: 'gemini-2.5-flash',
    sentBy: ME,
  });
  console.log('reply sent');
}

if (want('checkin')) {
  const t = await repositories.threads.create({ leadId, contactEmail: ME, contactName: 'Dr. Meera Krishnan', leadEmailSnapshot: ME, subjectLine: 'Re: Impedance setup for coin cells', status: 'replied', provider: 'gmail', messages: [], followUp: { attemptsSent: 0, maxAttempts: 2, replyDetected: true } });
  await sendOnNewThread(t, {
    to: ME,
    subject: 'Re: Impedance setup for coin cells',
    body: `Dear Dr. Krishnan,\n\nWhen we last spoke in July you mentioned revisiting your coin-cell impedance setup after the budget review. Since then we have added the EmStat Pico Core, a compact module for building measurements into your own test rigs, alongside the MultiPalmSens4 for running several cells in parallel.\n\nHave your plans for the coming months taken shape? If it helps, I can arrange a short online demo with your own cells.\n\n${sign}`,
    type: 'check_in',
    draftedBy: 'ai',
    aiDraftModel: 'gemini-2.5-flash',
    sentBy: ME,
    noFollowUp: true,
  });
  console.log('check-in sent');
}

// Campaigns: copies of the demo's webinar and launch campaigns, sent for real (tracked) to the sample lead.
if (want('campaign')) {
  const web = await CampaignModel.findOne({ name: /^EIS webinar/ }).lean();
  const launch = await CampaignModel.findOne({ kind: 'product_launch' }).lean();
  for (const src of [web, launch]) {
    if (!src) continue;
    const c = await duplicateCampaign(String(src._id), ME);
    await updateCampaign(c.id, { name: `${src.name} (to the sample lead)`, audience: { statuses: ['approved'], leadIds: [leadId] }, paceSeconds: 10 });
    await startCampaign(c.id);
    console.log('campaign started:', src.name);
  }
}

if (want('digest')) {
  await setState('replyWatchDigestDay', '2000-01-01');
  console.log('digest:', await digestTick(new Date(), true));
}

if (want('launchnotice')) {
  const p = await repositories.products.findByProductId(String((await CampaignModel.findOne({ kind: 'product_launch' }).lean())?.productId ?? 'palmsens4'));
  const c = await CampaignModel.findOne({ kind: 'product_launch', name: { $not: /sample lead/ } }).lean();
  if (p && c) {
    await notifyTeam(
      p,
      { subject: c.subject ?? '', preheader: c.preheader ?? '', heading: p.name, paragraphs: [`Dear {title|Dr.} {last_name|},`, `We have added ${p.name} to our range — a compact module for building electrochemical measurements into your own devices and sensors.`, 'It runs the common techniques (CV, DPV, SWV, EIS) and is controlled from your own software.'], buttonLabel: 'See the product' },
      26,
      [{ name: 'Prof. Varun Narayanan', score: 91 }, { name: 'Dr. Aparna Patil', score: 88 }, { name: 'Prof. Shalini Bhat', score: 84 }, { name: 'Dr. Sanjay Patil', score: 79 }],
      { ...(await getLaunchSettings()), mode: 'auto' },
      { id: String(c._id), sendAt: c.sendAt ? new Date(c.sendAt) : new Date(Date.now() + 19 * H) },
    );
    console.log('launch notice sent');
  }
}

if (want('summary')) {
  await sendWeeklySummary();
  console.log('weekly summary sent');
}

if (want('visit')) {
  const e = await ScheduleEventModel.findOne({ assignee: ME, type: 'visit' }).lean();
  if (e) {
    await notifyAssignee(await getEvent(String(e._id)), 'new');
    console.log('visit assignment sent');
  }
}

if (want('morning')) {
  await setState('scheduleDigestDay', '2000-01-01');
  console.log('morning list to', await morningDigest(new Date(new Date().setHours(8, 0, 0, 0)) > new Date() ? new Date() : new Date()));
}

if (want('booking')) {
  const prev = await getBookingSettings();
  await setBookingSettings({ assignee: ME });
  const slot = (await freeSlots())[3];
  if (slot) {
    await book({ start: slot.start, name: 'Dr. Meera Krishnan', email: ME, institution: 'IIT Madras', phone: '+91 98400 00000', message: 'Would like to see EIS on coin cells with the MultiPalmSens4.' });
    console.log('booking confirmation + assignee notice sent');
  }
  await setBookingSettings({ assignee: prev.assignee ?? '' } as never);
}

if (want('run')) {
  const run = await RosterRunModel.findOne({ status: 'completed' }).sort({ startedAt: -1 });
  if (run) {
    await RosterRunModel.updateOne({ _id: run._id }, { $unset: { notification: '' }, $set: { 'options.notifyEmail': ME } });
    console.log('run notices:', await notifyFinishedRuns());
  }
}

void getState;
await pause(1000);
await mongoose.disconnect();
