/**
 * The weekly summary email: every Monday from 09:00 IST, the team gets last week in one email —
 * headline numbers against the week before, what needs attention, campaign results, the team's
 * activity, and new website enquiries and products. Built from the dashboard's own numbers
 * (services/dashboard), no AI. Sent once per week; "Send now" (POST /api/dashboard/weekly-summary)
 * sends it on demand.
 */
import { InboundEmailModel } from '../../models/inboundEmail.model.js';
import { getState, setState } from '../../models/systemState.model.js';
import { env } from '../../config/env.js';
import { buildDashboard } from '../dashboard/dashboardService.js';
import { button, esc, NAVY, sendToTeam, shell } from '../email/replyWatch.js';
import { ProductLaunchModel } from '../catalog/catalogWatcher.js';

const DAY = 86_400_000;
const IST = 330 * 60_000;
const SENT_KEY = 'weeklySummaryWeek';

/** The IST Monday (yyyy-mm-dd) that starts the week `now` falls in. */
export function istWeekStart(now: Date): string {
  const ist = new Date(now.getTime() + IST);
  const back = (ist.getUTCDay() + 6) % 7; // days since Monday
  return new Date(ist.getTime() - back * DAY).toISOString().slice(0, 10);
}

/**
 * Due from Monday 09:00 IST in a week it has not gone out yet (so a server that was off on Monday sends it
 * when it is back). The very first check only marks the current week, so turning this on mid-week does
 * not send a summary at once.
 */
export async function weeklySummaryDue(now = new Date()): Promise<boolean> {
  const last = await getState<string>(SENT_KEY);
  if (last === undefined) {
    await setState(SENT_KEY, istWeekStart(now));
    return false;
  }
  const ist = new Date(now.getTime() + IST);
  const isMondayMorningOrLater = ist.getUTCDay() !== 1 || ist.getUTCHours() >= 9;
  return isMondayMorningOrLater && last !== istWeekStart(now);
}

const num = (n: number) => n.toLocaleString('en-IN');
const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n)}%`);
const change = (now: number, prev: number | null | undefined) => {
  if (prev == null) return '';
  const d = now - prev;
  return d === 0 ? '<span style="color:#9aa1ad">same as the week before</span>' : `<span style="color:${d > 0 ? '#15803d' : '#b45309'}">${d > 0 ? '▲' : '▼'} ${num(Math.abs(d))} vs the week before</span>`;
};

export async function buildWeeklySummary(now = new Date()): Promise<{ subject: string; html: string; text: string }> {
  const d = await buildDashboard('7', now);
  const since = new Date(now.getTime() - 7 * DAY);
  const enquiries = await InboundEmailModel.countDocuments({ gmailId: /^enquiry:/, status: 'processed', receivedAt: { $gte: since } });
  const launches = (await ProductLaunchModel.find({ detectedAt: { $gte: since } }, { productName: 1, status: 1, recipients: 1 }).lean()) as Array<{ productName?: string; status: string; recipients?: number }>;
  const h = d.headline;
  const o = d.outreach;
  const link = `${env.appUrl}/home`;

  const tile = (label: string, value: string, sub = '') =>
    `<td style="padding:10px 12px;border:1px solid #e8ebf0;border-radius:10px;vertical-align:top;width:33%"><div style="font-size:12px;color:#6b7280">${esc(label)}</div><div style="font-size:22px;font-weight:700;color:${NAVY}">${value}</div><div style="font-size:12px">${sub}</div></td>`;
  const tiles = `<table role="presentation" cellspacing="6" style="width:100%;border-collapse:separate;margin:0 0 14px"><tr>
${tile('Emails sent', num(h.emailsSent.value), change(h.emailsSent.value, h.emailsSent.prev))}
${tile('Reply rate', pct(h.replyRate.value), `${h.replyRate.replied} of ${h.replyRate.contacted} people we wrote to`)}
${tile('Replies received', num(o.received))}
</tr><tr>
${tile('Approved into the CRM', num(h.inCrm.delta), change(h.inCrm.delta, h.inCrm.prev))}
${tile('Website enquiries', num(enquiries))}
${tile('People in the CRM', num(h.inCrm.value))}
</tr></table>`;

  const attention = [
    ...d.alerts.map((a) => `${esc(a.title)}${a.detail ? ` — <span style="color:#6b7280">${esc(a.detail)}</span>` : ''}`),
    ...(d.todo.toReview ? [`${num(d.todo.toReview)} lead${d.todo.toReview === 1 ? '' : 's'} waiting for review`] : []),
    ...(d.todo.needsYou ? [`${num(d.todo.needsYou)} conversation${d.todo.needsYou === 1 ? '' : 's'} need an answer`] : []),
  ];
  const section = (title: string, body: string) => `<h3 style="margin:18px 0 6px;font-size:15px;color:${NAVY}">${esc(title)}</h3>${body}`;
  const list = (items: string[]) => `<ul style="margin:0;padding-left:18px">${items.map((i) => `<li style="margin:2px 0">${i}</li>`).join('')}</ul>`;
  const table = (head: string[], rows: string[][]) =>
    `<table style="width:100%;border-collapse:collapse;font-size:13px"><tr>${head.map((x, i) => `<th style="text-align:${i ? 'right' : 'left'};padding:5px 6px;border-bottom:1px solid #e8ebf0;color:#6b7280;font-weight:600">${esc(x)}</th>`).join('')}</tr>${rows
      .map((r) => `<tr>${r.map((x, i) => `<td style="text-align:${i ? 'right' : 'left'};padding:5px 6px;border-bottom:1px solid #f3f5f9">${x}</td>`).join('')}</tr>`)
      .join('')}</table>`;

  const body = [
    tiles,
    section('Needs attention', attention.length ? list(attention) : '<p style="margin:0;color:#6b7280">Nothing waiting — all caught up.</p>'),
    section(
      'How the emails went out',
      `<p style="margin:0">${num(o.sends.manual)} written by the team · ${num(o.sends.ai)} AI drafts approved · ${num(o.sends.automatic)} automatic · ${num(o.sends.campaign)} in campaigns. Follow-ups: ${num(o.followUps.auto)} automatic, ${num(o.followUps.approved)} approved.${o.medianReplyHours != null ? ` Typical time to their reply: ${Math.round(o.medianReplyHours)} h.` : ''}</p>`,
    ),
    o.campaigns.length
      ? section('Campaigns', table(['Campaign', 'Sent', 'Opened', 'Clicked', 'Replied'], o.campaigns.map((c) => [esc(c.name), num(c.sent), num(c.opened ?? 0), num(c.clicked ?? 0), num(c.replied)])))
      : '',
    launches.length ? section('New products on the website', list(launches.map((l) => `${esc(l.productName ?? 'Product')} — ${l.status === 'ready' ? `announcement for ${l.recipients ?? 0} people` : esc(l.status)}`))) : '',
    d.team.length
      ? section(
          'Team',
          table(
            ['Who', 'Sent', 'Drafts approved', 'Typical answer time'],
            d.team.map((t) => [esc(t.name), num(t.sent), num(t.approved), t.medianResponseHours == null ? '—' : `${Math.round(t.medianResponseHours * 10) / 10} h`]),
          ),
        )
      : '',
    o.topProducts.length ? section('Products the repliers were matched to', list(o.topProducts.map((p) => `${esc(p.name)} — ${p.repliers}`))) : '',
    `<p style="margin:18px 0 0">${button(link, 'Open the dashboard')}</p>`,
  ].join('\n');

  const weekOf = new Date(since.getTime() + IST).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const html = shell(`Last week in sales — from ${weekOf}`, `${num(h.emailsSent.value)} emails sent, ${num(o.received)} replies, ${num(h.inCrm.delta)} people approved into the CRM.`, body);
  const text = [
    `Last week in sales (from ${weekOf})`,
    `Emails sent: ${h.emailsSent.value}${h.emailsSent.prev != null ? ` (week before: ${h.emailsSent.prev})` : ''}`,
    `Reply rate: ${pct(h.replyRate.value)} (${h.replyRate.replied} of ${h.replyRate.contacted})`,
    `Replies received: ${o.received}`,
    `Approved into the CRM: ${h.inCrm.delta}`,
    `Website enquiries: ${enquiries}`,
    '',
    'Needs attention:',
    ...(attention.length ? attention.map((a) => `- ${a.replace(/<[^>]+>/g, '')}`) : ['- Nothing waiting']),
    '',
    `Dashboard: ${link}`,
  ].join('\n');
  return { subject: `Weekly summary: ${num(h.emailsSent.value)} sent, ${num(o.received)} replies, ${num(enquiries)} enquiries`, html, text };
}

export async function sendWeeklySummary(now = new Date()): Promise<void> {
  const s = await buildWeeklySummary(now);
  await sendToTeam(s.subject, s.html, s.text);
  await setState(SENT_KEY, istWeekStart(now));
}

let timer: NodeJS.Timeout | null = null;

export function startWeeklySummary(): void {
  const tick = async () => {
    try {
      if (await weeklySummaryDue()) {
        await sendWeeklySummary();
        console.log('[summary] weekly summary sent to the team');
      }
    } catch (error) {
      console.error('[summary] weekly summary failed:', error instanceof Error ? error.message : error);
    }
  };
  timer = setInterval(() => void tick(), 15 * 60_000);
  setTimeout(() => void tick(), 60_000);
}

export function stopWeeklySummary(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
