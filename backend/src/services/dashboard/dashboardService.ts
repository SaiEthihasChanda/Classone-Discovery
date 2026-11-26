/**
 * The analytics dashboard (Home): headline numbers, alerts, the funnel, trends,
 * outreach results and team activity — for the last 7 / 30 / 90 days or all time.
 *
 * Email numbers are read from the conversations themselves (every message keeps
 * its direction, type, who sent it and when), so they always agree with what
 * Conversations shows. The volume here is hundreds to low thousands of threads,
 * so they are read once and counted in memory.
 */
import { env } from '../../config/env.js';
import { CampaignModel, CampaignRecipientModel } from '../../models/campaign.model.js';
import { EmailThreadModel } from '../../models/emailThread.model.js';
import { FacultyMemberModel } from '../../models/facultyMember.model.js';
import { LeadModel } from '../../models/lead.model.js';
import { ProductModel } from '../../models/productCatalog.model.js';
import { getState } from '../../models/systemState.model.js';
import { AppUserModel } from '../../models/appUser.model.js';
import { repositories } from '../../repositories/index.js';
import { geminiModelStatus } from '../ai/geminiProvider.js';
import { inboxStatus } from '../email/inboxPoller.js';
import { activePauses } from '../pipeline/flowEngine.js';

export type Range = '7' | '30' | '90' | 'all';
const DAY = 86_400_000;

type Msg = { direction: 'inbound' | 'outbound'; type: string; sentAt: Date; sentBy?: string; draftedBy?: string };
type Thread = { _id: unknown; leadId?: string; status: string; awaitingReplySince?: Date; messages: Msg[] };

/** What kind of send a message was, for the "emails sent" breakdown. */
function sendKind(m: Msg): 'campaign' | 'automatic' | 'ai' | 'manual' {
  if (m.type === 'campaign') return 'campaign';
  if (m.sentBy === 'auto-reply' || m.sentBy === 'auto-followup') return 'automatic';
  if (m.draftedBy === 'ai') return 'ai';
  return 'manual';
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
/** A real person's address (not an automatic sender or a local test login). */
const isPerson = (by?: string) => Boolean(by && by.includes('@') && !by.endsWith('@localhost'));

export async function buildDashboard(range: Range, now = new Date()) {
  const days = range === 'all' ? null : Number(range);
  const from = days ? new Date(now.getTime() - days * DAY) : new Date(0);
  const prevFrom = days ? new Date(from.getTime() - days * DAY) : null;
  const inRange = (d: Date | string | undefined) => Boolean(d) && new Date(d!) >= from && new Date(d!) <= now;
  const inPrev = (d: Date | string | undefined) => Boolean(d && prevFrom) && new Date(d!) >= prevFrom! && new Date(d!) < from;

  const threads = (await EmailThreadModel.find({}, { leadId: 1, status: 1, awaitingReplySince: 1, 'messages.direction': 1, 'messages.type': 1, 'messages.sentAt': 1, 'messages.sentBy': 1, 'messages.draftedBy': 1 }).lean()) as unknown as Thread[];
  const overdueBefore = new Date(now.getTime() - env.OVERDUE_HOURS * 3_600_000);

  // --- Email activity --------------------------------------------------------------------------------
  const sends = { manual: 0, ai: 0, automatic: 0, campaign: 0 };
  let sentNow = 0;
  let sentPrev = 0;
  let received = 0;
  let followUps = { auto: 0, approved: 0 };
  const replyTimes: number[] = []; // their reply after our message, hours
  let contactedThreads = 0;
  let repliedThreads = 0;
  let contactedPrev = 0;
  let repliedPrev = 0;
  const team = new Map<string, { sent: number; approved: number; responseHours: number[]; waiting: number }>();
  const teamRow = (who: string) => team.get(who) ?? (team.set(who, { sent: 0, approved: 0, responseHours: [], waiting: 0 }), team.get(who)!);

  for (const t of threads) {
    const ms = [...t.messages].sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
    let firstOutInRange: Msg | null = null;
    let firstOutInPrev: Msg | null = null;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i]!;
      if (m.direction === 'outbound') {
        if (inRange(m.sentAt)) {
          sentNow += 1;
          sends[sendKind(m)] += 1;
          if (m.type.startsWith('follow_up')) m.sentBy === 'auto-followup' ? (followUps.auto += 1) : (followUps.approved += 1);
          firstOutInRange ??= m;
          const who = isPerson(m.sentBy) ? m.sentBy!.toLowerCase() : sendKind(m) === 'automatic' ? 'Automatic' : null;
          if (who) {
            const row = teamRow(who);
            row.sent += 1;
            if (m.draftedBy === 'ai' && who !== 'Automatic') row.approved += 1;
            // Answering their message: how long they waited.
            const prevIn = [...ms.slice(0, i)].reverse().find((x) => x.direction === 'inbound');
            const prevOut = [...ms.slice(0, i)].reverse().find((x) => x.direction === 'outbound');
            if (prevIn && (!prevOut || new Date(prevOut.sentAt) < new Date(prevIn.sentAt)) && who !== 'Automatic') {
              row.responseHours.push((new Date(m.sentAt).getTime() - new Date(prevIn.sentAt).getTime()) / 3_600_000);
            }
          }
        } else if (inPrev(m.sentAt)) {
          sentPrev += 1;
          firstOutInPrev ??= m;
        }
      } else if (inRange(m.sentAt)) received += 1;
    }
    // Reply rate is about mail we started: conversations where they wrote first are answers, not outreach.
    const weStarted = ms[0]?.direction === 'outbound';
    if (!weStarted) {
      firstOutInRange = null;
      firstOutInPrev = null;
    }
    if (firstOutInRange) {
      contactedThreads += 1;
      const reply = ms.find((x) => x.direction === 'inbound' && new Date(x.sentAt) > new Date(firstOutInRange!.sentAt));
      if (reply) {
        repliedThreads += 1;
        replyTimes.push((new Date(reply.sentAt).getTime() - new Date(firstOutInRange.sentAt).getTime()) / 3_600_000);
      }
    }
    if (firstOutInPrev) {
      contactedPrev += 1;
      if (ms.some((x) => x.direction === 'inbound' && new Date(x.sentAt) > new Date(firstOutInPrev!.sentAt) && new Date(x.sentAt) < from)) repliedPrev += 1;
    }
    // Waiting on the team: attributed to whoever wrote to them last.
    if (t.awaitingReplySince && t.status !== 'closed') {
      const lastOurs = [...ms].reverse().find((x) => x.direction === 'outbound' && isPerson(x.sentBy));
      if (lastOurs) teamRow(lastOurs.sentBy!.toLowerCase()).waiting += 1;
    }
  }

  // --- Trends: buckets of a day (7 d), a week (30 / 90 d) or a month (all time) ------------------------
  const bucketDays = range === '7' ? 1 : range === 'all' ? 30 : 7;
  const firstMsg = threads.flatMap((t) => t.messages.map((m) => new Date(m.sentAt).getTime())).reduce((a, b) => Math.min(a, b), now.getTime());
  const start = days ? from.getTime() : Math.min(firstMsg, now.getTime() - 90 * DAY);
  const nBuckets = Math.max(1, Math.ceil((now.getTime() - start) / (bucketDays * DAY)));
  const buckets = Array.from({ length: nBuckets }, (_, i) => ({ start: new Date(start + i * bucketDays * DAY), newLeads: 0, manual: 0, ai: 0, automatic: 0, campaign: 0, replies: 0 }));
  const bucketOf = (d: Date) => buckets[Math.min(nBuckets - 1, Math.max(0, Math.floor((d.getTime() - start) / (bucketDays * DAY))))]!;
  for (const t of threads)
    for (const m of t.messages) {
      const at = new Date(m.sentAt);
      if (at.getTime() < start || at > now) continue;
      if (m.direction === 'outbound') bucketOf(at)[sendKind(m)] += 1;
      else bucketOf(at).replies += 1;
    }
  for (const l of (await LeadModel.find({ createdAt: { $gte: new Date(start) } }, { createdAt: 1 }).lean()) as Array<{ createdAt: Date }>) bucketOf(new Date(l.createdAt)).newLeads += 1;

  // --- Funnel ----------------------------------------------------------------------------------------------
  const facultyInRange = { createdAt: { $gte: from, $lte: now } };
  const leadsInRange = { createdAt: { $gte: from, $lte: now }, inPipeline: { $ne: true } };
  const leadIdsInRange = ((await LeadModel.find({ ...leadsInRange, status: { $in: ['approved', 'customer'] } }, { _id: 1 }).lean()) as Array<{ _id: unknown }>).map((l) => String(l._id));
  const threadsByLead = new Map<string, Thread[]>();
  for (const t of threads) if (t.leadId) threadsByLead.set(t.leadId, [...(threadsByLead.get(t.leadId) ?? []), t]);
  const contactedLeads = leadIdsInRange.filter((id) => (threadsByLead.get(id) ?? []).some((t) => t.messages.some((m) => m.direction === 'outbound')));
  const repliedLeads = contactedLeads.filter((id) => (threadsByLead.get(id) ?? []).some((t) => t.messages.some((m) => m.direction === 'inbound')));
  const [found, verified, scored, becameLeads, approved] = await Promise.all([
    FacultyMemberModel.countDocuments(facultyInRange),
    FacultyMemberModel.countDocuments({ ...facultyInRange, 'flow.stage': { $in: ['score', 'promote', 'fill', 'done'] } }),
    FacultyMemberModel.countDocuments({ ...facultyInRange, 'relevance.score': { $ne: null } }),
    LeadModel.countDocuments(leadsInRange),
    Promise.resolve(leadIdsInRange.length),
  ]);
  const funnel = [
    { key: 'found', label: 'Found', count: found },
    { key: 'verified', label: 'Verified', count: verified },
    { key: 'scored', label: 'Scored', count: scored },
    { key: 'leads', label: 'Became leads', count: becameLeads },
    { key: 'approved', label: 'Approved', count: approved },
    { key: 'contacted', label: 'Contacted', count: contactedLeads.length },
    { key: 'replied', label: 'Replied', count: repliedLeads.length },
  ];

  // --- Headline numbers ----------------------------------------------------------------------------------
  const [inCrm, awaiting, moving, openConvos, overdue, approvedNow, approvedPrev] = await Promise.all([
    LeadModel.countDocuments({ status: { $in: ['approved', 'customer'] } }),
    LeadModel.countDocuments({ status: 'pending_review', inPipeline: { $ne: true } }),
    FacultyMemberModel.countDocuments({ status: { $in: ['eligible', 'promoted'] }, 'flow.stage': { $nin: ['done', null] }, 'flow.state': { $in: ['queued', 'processing'] } }),
    EmailThreadModel.countDocuments({ status: { $ne: 'closed' }, 'messages.0': { $exists: true } }),
    EmailThreadModel.countDocuments({ status: { $ne: 'closed' }, awaitingReplySince: { $lte: overdueBefore } }),
    LeadModel.countDocuments({ 'review.decision': 'approved', 'review.reviewedAt': { $gte: from, $lte: now } }),
    prevFrom ? LeadModel.countDocuments({ 'review.decision': 'approved', 'review.reviewedAt': { $gte: prevFrom, $lt: from } }) : Promise.resolve(null),
  ]);
  const rate = (r: number, c: number) => (c ? Math.round((r / c) * 1000) / 10 : null);
  const headline = {
    inCrm: { value: inCrm, delta: approvedNow, deltaLabel: 'approved this period', prev: approvedPrev },
    awaitingApproval: { value: awaiting },
    discoveriesInProgress: { value: moving },
    openConversations: { value: openConvos },
    overdueReplies: { value: overdue },
    emailsSent: { value: sentNow, prev: prevFrom ? sentPrev : null },
    replyRate: { value: rate(repliedThreads, contactedThreads), prev: prevFrom ? rate(repliedPrev, contactedPrev) : null, contacted: contactedThreads, replied: repliedThreads },
  };

  // --- Campaigns & products ---------------------------------------------------------------------------------
  const campaigns = (await CampaignModel.find({ $or: [{ startedAt: { $gte: from } }, { status: { $in: ['sending', 'scheduled'] } }] }).sort({ startedAt: -1 }).limit(12).lean()) as Array<Record<string, any>>;
  const campaignRows = await Promise.all(
    campaigns.map(async (c) => {
      const id = String(c._id);
      const recips = (await CampaignRecipientModel.find({ campaignId: id }, { status: 1, threadId: 1, leadId: 1 }).lean()) as Array<{ status: string; threadId?: string; leadId?: string }>;
      const sentRows = recips.filter((r) => r.status === 'sent');
      const tIds = new Set(sentRows.map((r) => r.threadId).filter(Boolean));
      const replied = threads.filter((t) => tIds.has(String(t._id)) && t.messages.some((m) => m.direction === 'inbound')).length;
      const leadIds = sentRows.map((r) => r.leadId).filter((x): x is string => Boolean(x && /^[a-f\d]{24}$/i.test(x)));
      const unsubscribed = leadIds.length ? await LeadModel.countDocuments({ _id: { $in: leadIds }, doNotContact: true }) : 0;
      return { id, name: c.name as string, kind: (c.kind as string) ?? 'manual', status: c.status as string, sent: sentRows.length, replied, unsubscribed, replyRate: rate(replied, sentRows.length) };
    }),
  );

  // Products recommended to the people who wrote back in this period.
  const repliedLeadIds = threads.filter((t) => t.leadId && t.messages.some((m) => m.direction === 'inbound' && inRange(m.sentAt))).map((t) => t.leadId!);
  const productCounts = new Map<string, number>();
  if (repliedLeadIds.length) {
    const ls = (await LeadModel.find({ _id: { $in: repliedLeadIds.filter((id) => /^[a-f\d]{24}$/i.test(id)) } }, { 'aiScoring.recommendedProductIds': 1 }).lean()) as Array<{ aiScoring?: { recommendedProductIds?: string[] } }>;
    for (const l of ls) for (const p of l.aiScoring?.recommendedProductIds ?? []) productCounts.set(p, (productCounts.get(p) ?? 0) + 1);
  }
  const productNames = new Map(((await ProductModel.find({ productId: { $in: [...productCounts.keys()] } }, { productId: 1, name: 1 }).lean()) as Array<{ productId: string; name: string }>).map((p) => [p.productId, p.name]));
  const topProducts = [...productCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => ({ productId: id, name: productNames.get(id) ?? id, repliers: n }));

  // --- Team -----------------------------------------------------------------------------------------------
  const users = new Map(((await AppUserModel.find({}, { email: 1, name: 1 }).lean()) as Array<{ email: string; name?: string }>).map((u) => [u.email.toLowerCase(), u.name ?? u.email]));
  const teamRows = [...team.entries()]
    .map(([who, r]) => ({ who, name: who === 'Automatic' ? 'Automatic (holding replies, follow-ups)' : (users.get(who) ?? who), sent: r.sent, approved: r.approved, medianResponseHours: median(r.responseHours), waiting: r.waiting }))
    .sort((a, b) => Number(a.who === 'Automatic') - Number(b.who === 'Automatic') || b.sent - a.sent);

  return {
    range,
    from: days ? from : null,
    generatedAt: now,
    headline,
    alerts: await buildAlerts(now, overdueBefore),
    todo: {
      toReview: awaiting,
      needsYou: await EmailThreadModel.countDocuments({ status: { $ne: 'closed' }, $or: [{ awaitingReplySince: { $exists: true, $ne: null } }, { status: 'draft', draftType: { $in: ['follow_up_1', 'follow_up_2', 'response'] } }] }),
      conveyorFailed: await FacultyMemberModel.countDocuments({ 'flow.state': 'failed', status: { $ne: 'excluded' } }),
    },
    funnel,
    trends: { bucketDays, buckets },
    outreach: {
      sends,
      received,
      replyRate: rate(repliedThreads, contactedThreads),
      medianReplyHours: median(replyTimes),
      followUps,
      campaigns: campaignRows,
      topProducts,
    },
    team: teamRows,
    activity: await repositories.activity.findRecent(12),
  };
}

export interface Alert {
  level: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  to: string;
}

/** What needs attention now, most serious first. Each links to where to act. */
export async function buildAlerts(now = new Date(), overdueBefore = new Date(now.getTime() - env.OVERDUE_HOURS * 3_600_000)): Promise<Alert[]> {
  const out: Alert[] = [];
  const overdue = (await EmailThreadModel.find({ status: { $ne: 'closed' }, awaitingReplySince: { $lte: overdueBefore } }, { awaitingReplySince: 1 }).sort({ awaitingReplySince: 1 }).lean()) as Array<{ awaitingReplySince: Date }>;
  if (overdue.length) {
    const days = Math.floor((now.getTime() - new Date(overdue[0]!.awaitingReplySince).getTime()) / DAY);
    out.push({ level: 'critical', title: `${overdue.length} ${overdue.length === 1 ? 'person has' : 'people have'} waited over ${Math.round(env.OVERDUE_HOURS / 24)} days for a reply`, detail: `The longest has waited ${days} days.`, to: '/conversations' });
  }
  const inbox = inboxStatus();
  if (env.EMAIL_PROVIDER === 'gmail' && (inbox.stoppedReason || (inbox.lastError && (!inbox.lastOkAt || now.getTime() - inbox.lastOkAt.getTime() > 15 * 60_000)))) {
    out.push({ level: 'critical', title: 'The sales inbox is not being read', detail: inbox.stoppedReason ?? `Gmail answered: ${inbox.lastError}. New replies will not appear until this is fixed.`, to: '/admin?tab=settings' });
  }
  const models = geminiModelStatus();
  if (models.length && models.every((m) => m.coolingUntil)) {
    const back = new Date(Math.min(...models.map((m) => m.coolingUntil!.getTime())));
    out.push({ level: 'warning', title: 'The AI is out of quota or busy on every model', detail: `Scoring, drafting and reading mail resume around ${back.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })} IST. A paid key avoids this.`, to: '/admin?tab=settings' });
  }
  const failedSends = await CampaignRecipientModel.countDocuments({ status: 'failed', updatedAt: { $gte: new Date(now.getTime() - 7 * DAY) } });
  if (failedSends) out.push({ level: 'warning', title: `${failedSends} campaign email${failedSends === 1 ? '' : 's'} failed to send this week`, detail: 'Open the campaign to see why.', to: '/campaigns' });
  const failedFlow = await FacultyMemberModel.countDocuments({ 'flow.state': 'failed', status: { $ne: 'excluded' } });
  if (failedFlow) out.push({ level: 'warning', title: `${failedFlow} ${failedFlow === 1 ? 'person is' : 'people are'} stuck on the Prospects conveyor`, detail: 'A step failed after its retries — retry them from View stage.', to: '/prospects' });
  const pauses = Object.entries(activePauses());
  if (pauses.length) out.push({ level: 'info', title: `Prospects ${pauses.map(([s]) => s).join(', ')} paused`, detail: pauses.map(([, p]) => p.reason).join('; '), to: '/prospects' });
  const launches = (await CampaignModel.find({ kind: 'product_launch', status: { $in: ['scheduled', 'draft'] } }, { name: 1, status: 1, sendAt: 1 }).lean()) as Array<{ _id: unknown; name: string; status: string; sendAt?: Date }>;
  for (const l of launches) {
    out.push({
      level: 'info',
      title: l.status === 'scheduled' ? `${l.name} goes out ${new Date(l.sendAt!).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}` : `${l.name} is waiting for review`,
      detail: l.status === 'scheduled' ? 'Review, edit or pause it before then.' : 'Review the email and the people it was picked for, then send it.',
      to: `/campaigns?id=${String(l._id)}`,
    });
  }
  const sync = await getState<{ at: string; failed: number }>('websiteCatalogLastSync');
  if (sync?.failed) out.push({ level: 'warning', title: `${sync.failed} new website product${sync.failed === 1 ? '' : 's'} could not be classified`, detail: 'It is retried every 30 minutes.', to: '/admin?tab=catalog' });
  return out;
}
