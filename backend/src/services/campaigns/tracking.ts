/**
 * Campaign open and click tracking.
 *
 * Each campaign email carries a 1×1 image (an open) and has its links routed through
 * /api/public/t/c (a click), both naming the recipient row with an HMAC-signed token so nobody can
 * forge events or use the redirect for other sites. Only links that were in the email can be followed:
 * the URL is part of the signature.
 *
 * Opens are an estimate: some mail apps load images for privacy (Apple Mail) or block them (many
 * corporate clients). Link scanners sometimes "click" within seconds of delivery, so events in the
 * first few seconds after sending are ignored.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { CampaignRecipientModel } from '../../models/campaign.model.js';

const secret = () => env.ACTION_LINK_SECRET ?? env.INTERNAL_API_TOKEN ?? '';
const sign = (s: string) => createHmac('sha256', secret()).update(s).digest().subarray(0, 12).toString('base64url');
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Where public tracking links point: the deployed app's /api. */
export const publicApiBase = () => `${env.appUrl}/api`;

/** Events this soon after sending are mail scanners, not people. */
const SCANNER_WINDOW_MS = 5_000;
const MAX_CLICK_LOG = 50;

export function openToken(recipientId: string): string {
  return `${recipientId}.${sign(`o:${recipientId}`)}`;
}
export function readOpenToken(token: string): string | null {
  const [rid, sig] = token.replace(/\.gif$/, '').split('.');
  return rid && sig && /^[a-f\d]{24}$/i.test(rid) && same(sig, sign(`o:${rid}`)) ? rid : null;
}
export function clickSig(recipientId: string, url: string): string {
  return sign(`c:${recipientId}|${url}`);
}

/**
 * Adds tracking to one recipient's HTML: every http(s) link goes through the click route and the open
 * image is appended. mailto: and in-page links are left alone.
 */
export function addTracking(html: string, recipientId: string, base = publicApiBase()): string {
  if (!secret()) return html;
  const tracked = html.replace(/href="(https?:\/\/[^"]+)"/g, (_m, raw: string) => {
    const url = raw.replace(/&amp;/g, '&');
    const href = `${base}/public/t/c/${recipientId}?u=${encodeURIComponent(url)}&s=${clickSig(recipientId, url)}`;
    return `href="${href.replace(/&/g, '&amp;')}"`;
  });
  const pixel = `<img src="${base}/public/t/o/${openToken(recipientId)}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`;
  return tracked.includes('</body>') ? tracked.replace('</body>', `${pixel}</body>`) : tracked + pixel;
}

const fresh = (sentAt: Date | undefined, now: Date) => !sentAt || now.getTime() - new Date(sentAt).getTime() >= SCANNER_WINDOW_MS;

export async function recordOpen(recipientId: string, now = new Date()): Promise<void> {
  const r = (await CampaignRecipientModel.findById(recipientId, { sentAt: 1 }).lean()) as { sentAt?: Date } | null;
  if (!r || !fresh(r.sentAt, now)) return;
  await CampaignRecipientModel.updateOne({ _id: recipientId }, { $inc: { opens: 1 }, $min: { openedAt: now } });
}

/** Records a click and returns where to send the browser — or null when the link was not ours. */
export async function recordClick(recipientId: string, url: string, sig: string, now = new Date()): Promise<string | null> {
  if (!/^[a-f\d]{24}$/i.test(recipientId) || !/^https?:\/\//i.test(url) || !secret() || !same(sig, clickSig(recipientId, url))) return null;
  const r = (await CampaignRecipientModel.findById(recipientId, { sentAt: 1 }).lean()) as { sentAt?: Date } | null;
  if (r && fresh(r.sentAt, now)) {
    // A click means the email was opened too, even when images were blocked.
    await CampaignRecipientModel.updateOne(
      { _id: recipientId },
      { $inc: { clicks: 1 }, $min: { clickedAt: now, openedAt: now }, $push: { clickLog: { $each: [{ url, at: now }], $slice: -MAX_CLICK_LOG } } },
    );
  }
  return url;
}

/** Opens, clicks and the most-clicked links for a set of campaigns. */
export async function engagementByCampaign(ids: string[]): Promise<Map<string, { opened: number; clicked: number; topLinks: Array<{ url: string; clicks: number }> }>> {
  const out = new Map<string, { opened: number; clicked: number; topLinks: Array<{ url: string; clicks: number }> }>();
  if (!ids.length) return out;
  const counts = (await CampaignRecipientModel.aggregate([
    { $match: { campaignId: { $in: ids }, status: 'sent' } },
    { $group: { _id: '$campaignId', opened: { $sum: { $cond: [{ $ifNull: ['$openedAt', false] }, 1, 0] } }, clicked: { $sum: { $cond: [{ $ifNull: ['$clickedAt', false] }, 1, 0] } } } },
  ])) as Array<{ _id: string; opened: number; clicked: number }>;
  const links = (await CampaignRecipientModel.aggregate([
    { $match: { campaignId: { $in: ids }, 'clickLog.0': { $exists: true } } },
    { $unwind: '$clickLog' },
    { $group: { _id: { c: '$campaignId', u: '$clickLog.url' }, clicks: { $sum: 1 } } },
    { $sort: { clicks: -1 } },
  ])) as Array<{ _id: { c: string; u: string }; clicks: number }>;
  for (const id of ids) {
    const c = counts.find((x) => x._id === id);
    out.set(id, {
      opened: c?.opened ?? 0,
      clicked: c?.clicked ?? 0,
      topLinks: links.filter((l) => l._id.c === id).slice(0, 5).map((l) => ({ url: l._id.u, clicks: l.clicks })),
    });
  }
  return out;
}
