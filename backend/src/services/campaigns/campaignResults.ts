/**
 * Campaign results, person by person: who opened, which links they clicked, who opened the demo
 * booking page, who actually booked, and who replied — and a nudge for the people who looked at the
 * booking page but did not book.
 *
 * - A "booking click" is a click on a link to the app's own /book page.
 * - "Booked" means a demo booked on that page by the same person (same email, or the same lead) after
 *   the campaign reached them.
 * - The nudge drafts a short, friendly follow-up on each such person's campaign conversation; it waits
 *   for approval in Conversations → Needs you like any other draft. Nobody is nudged twice.
 */
import { ApiError } from '../../middleware/errorHandler.js';
import { CampaignModel, CampaignRecipientModel } from '../../models/campaign.model.js';
import { EmailThreadModel } from '../../models/emailThread.model.js';
import { LeadModel } from '../../models/lead.model.js';
import { ScheduleEventModel } from '../../models/scheduleEvent.model.js';

/** Is this a link to the demo booking page? */
export const isBookingLink = (url: string) => {
  try {
    return /^\/book\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

export interface ResultRow {
  id: string;
  leadId?: string;
  name?: string;
  email: string;
  status: string;
  sentAt?: Date;
  openedAt?: Date;
  opens: number;
  clickedAt?: Date;
  clicks: number;
  links: Array<{ url: string; at: Date }>;
  clickedBooking: boolean;
  booked: { eventId: string; start: Date } | null;
  replied: boolean;
  nudged: boolean;
}

export async function campaignResults(campaignId: string): Promise<{ rows: ResultRow[]; summary: Record<string, number> }> {
  const c = await CampaignModel.findById(campaignId, { _id: 1 }).lean();
  if (!c) throw ApiError.notFound('Campaign');
  const recips = (await CampaignRecipientModel.find({ campaignId }).sort({ sentAt: -1 }).limit(5000).lean()) as Array<Record<string, any>>;
  const sent = recips.filter((r) => r.status === 'sent');
  const emails = sent.map((r) => String(r.email).toLowerCase());
  const leadIds = sent.map((r) => r.leadId).filter(Boolean);
  const bookings = (await ScheduleEventModel.find({ source: 'booking', $or: [{ contactEmail: { $in: emails } }, { leadId: { $in: leadIds } }] }, { contactEmail: 1, leadId: 1, start: 1, createdAt: 1 }).lean()) as Array<{ _id: unknown; contactEmail?: string; leadId?: string; start: Date; createdAt: Date }>;
  const threads = new Map(
    ((await EmailThreadModel.find({ _id: { $in: sent.map((r) => r.threadId).filter(Boolean) } }, { messages: 1 }).lean()) as Array<{ _id: unknown; messages: Array<{ direction: string; sentAt: Date }> }>).map((t) => [String(t._id), t]),
  );

  const rows: ResultRow[] = recips.map((r) => {
    const email = String(r.email).toLowerCase();
    const sentAt = r.sentAt ? new Date(r.sentAt) : undefined;
    const links = ((r.clickLog ?? []) as Array<{ url: string; at: Date }>).map((l) => ({ url: l.url, at: l.at }));
    const b = sentAt ? bookings.filter((x) => (x.contactEmail === email || (r.leadId && x.leadId === r.leadId)) && new Date(x.createdAt) >= sentAt).sort((x, y) => new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime())[0] : undefined;
    const t = r.threadId ? threads.get(String(r.threadId)) : undefined;
    return {
      id: String(r._id),
      leadId: r.leadId,
      name: r.name,
      email,
      status: r.status,
      sentAt,
      openedAt: r.openedAt,
      opens: r.opens ?? 0,
      clickedAt: r.clickedAt,
      clicks: r.clicks ?? 0,
      links,
      clickedBooking: links.some((l) => isBookingLink(l.url)),
      booked: b ? { eventId: String(b._id), start: b.start } : null,
      replied: Boolean(sentAt && t?.messages.some((m) => m.direction === 'inbound' && new Date(m.sentAt) > sentAt)),
      nudged: Boolean(r.nudgedAt),
    };
  });
  const s = rows.filter((r) => r.status === 'sent');
  const summary = {
    sent: s.length,
    opened: s.filter((r) => r.openedAt).length,
    clicked: s.filter((r) => r.clicks > 0).length,
    clickedBooking: s.filter((r) => r.clickedBooking).length,
    booked: s.filter((r) => r.booked).length,
    clickedNotBooked: s.filter((r) => r.clickedBooking && !r.booked).length,
    replied: s.filter((r) => r.replied).length,
  };
  return { rows, summary };
}

/**
 * Drafts a gentle follow-up for everyone who opened the booking page from this campaign but has not
 * booked (and has not replied, is reachable, and has not been nudged). Returns how many were drafted.
 */
export async function nudgeNonBookers(campaignId: string): Promise<number> {
  const { rows } = await campaignResults(campaignId);
  const campaign = (await CampaignModel.findById(campaignId, { subject: 1 }).lean()) as { subject?: string } | null;
  let made = 0;
  for (const r of rows.filter((x) => x.status === 'sent' && x.clickedBooking && !x.booked && !x.replied && !x.nudged)) {
    const recip = (await CampaignRecipientModel.findById(r.id, { threadId: 1 }).lean()) as { threadId?: string } | null;
    if (!recip?.threadId) continue;
    const lead = r.leadId ? ((await LeadModel.findById(r.leadId, { person: 1, doNotContact: 1 }).lean()) as { person?: { name?: string; title?: string }; doNotContact?: boolean } | null) : null;
    if (lead?.doNotContact) continue;
    const thread = (await EmailThreadModel.findById(recip.threadId, { status: 1, subjectLine: 1 }).lean()) as { status: string; subjectLine?: string } | null;
    if (!thread || thread.status === 'draft' || thread.status === 'closed') continue;
    const last = (lead?.person?.name ?? r.name ?? '').replace(/^(dr|prof)\.?\s+/i, '').split(/\s+/).pop();
    const greeting = last ? `Dear ${lead?.person?.title?.match(/prof/i) ? 'Prof.' : 'Dr.'} ${last},` : 'Hello,';
    const subject = /^re:/i.test(thread.subjectLine ?? '') ? thread.subjectLine! : `Re: ${campaign?.subject?.replace(/\{[^}]*\}/g, '').trim() || thread.subjectLine || 'Our demo'}`;
    await EmailThreadModel.updateOne(
      { _id: recip.threadId },
      {
        $set: {
          status: 'draft',
          draftType: 'follow_up_1',
          draftSubject: subject,
          draftBody: `${greeting}\n\nIn case none of the demo times suited you, just reply with a day and time that works and we will arrange it around you — or we can simply send a short recorded walkthrough instead.\n\nTeam Class One Systems`,
          draftModel: 'template',
          draftCreatedAt: new Date(),
        },
      },
    );
    await CampaignRecipientModel.updateOne({ _id: r.id }, { $set: { nudgedAt: new Date() } });
    made += 1;
  }
  return made;
}

/** Engagement across all campaign emails sent in a period — for the dashboard. */
export async function engagementSince(from: Date, to: Date = new Date()) {
  const recips = (await CampaignRecipientModel.find({ status: 'sent', sentAt: { $gte: from, $lt: to } }, { email: 1, leadId: 1, sentAt: 1, openedAt: 1, clicks: 1, clickLog: 1 }).lean()) as Array<Record<string, any>>;
  const bookingClickers = recips.filter((r) => ((r.clickLog ?? []) as Array<{ url: string }>).some((l) => isBookingLink(l.url)));
  const bookings = (await ScheduleEventModel.find({ source: 'booking', createdAt: { $gte: from, $lt: to } }, { contactEmail: 1, leadId: 1, createdAt: 1 }).lean()) as Array<{ contactEmail?: string; leadId?: string; createdAt: Date }>;
  const bookedAfterClick = bookingClickers.filter((r) => bookings.some((b) => (b.contactEmail === String(r.email).toLowerCase() || (r.leadId && b.leadId === r.leadId)) && new Date(b.createdAt) >= new Date(r.sentAt))).length;
  return {
    emailed: recips.length,
    opened: recips.filter((r) => r.openedAt).length,
    clicked: recips.filter((r) => (r.clicks ?? 0) > 0).length,
    clickedBooking: bookingClickers.length,
    bookedAfterClick,
    clickedNotBooked: bookingClickers.length - bookedAfterClick,
    bookings: bookings.length,
  };
}
