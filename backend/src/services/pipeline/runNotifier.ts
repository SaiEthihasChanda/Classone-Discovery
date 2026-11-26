/**
 * "Your run has finished" emails.
 *
 * A conveyor run is finished once its build has stopped finding people and
 * none of its people is still moving (pipelineRuns.peopleByRun — in Auto that
 * includes anyone waiting in a column). The person who started it — or who
 * made the schedule that started it (options.notifyEmail) — then gets one
 * email: what was found, how many reached Leads, the best new leads, who needs
 * a person, and links to the run's log and to Leads → To review.
 *
 * Checked every 30 s. Each run is claimed before sending (notification.sentAt),
 * so two ticks or two server instances never send it twice; a failed send is
 * retried on later ticks, up to MAX_ATTEMPTS, and the error kept on the run.
 */
import { env } from '../../config/env.js';
import { INDIAN_INSTITUTIONS } from '../../data/indianInstitutions.js';
import { FacultyMemberModel } from '../../models/facultyMember.model.js';
import { RosterRunModel } from '../../models/rosterRun.model.js';
import { getEmailTransport, type EmailMessage, type EmailTransport } from '../email/transports/index.js';
import { getPipelineSettings } from './flowEngine.js';
import { peopleByRun, type RunPeople } from './pipelineRuns.js';

const MAX_ATTEMPTS = 3;
const TOP_LEADS = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface RunDoc {
  _id: string;
  status: string;
  error?: string;
  startedAt: Date;
  finishedAt?: Date;
  options?: { label?: string; institutionIds?: string[]; triggeredBy?: string; notifyEmail?: string; late?: boolean; threshold?: number };
  notification?: { attempts?: number };
}

interface TopLead {
  name: string;
  institute?: string;
  score?: number;
}

const instituteName = (id: string) => INDIAN_INSTITUTIONS.find((i) => i.openAlexId === id)?.name ?? id;

const ist = (d: Date) => d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST';

function duration(from: Date, to: Date): string {
  const mins = Math.round((to.getTime() - from.getTime()) / 60_000);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The email for one finished run. Exported for tests. */
export function buildRunEmail(run: RunDoc, people: RunPeople, top: TopLead[], finishedAt: Date, { mode, threshold }: { mode: 'auto' | 'manual'; threshold: number }): Omit<EmailMessage, 'to'> {
  const o = run.options ?? {};
  const institutes = (o.institutionIds ?? []).map(instituteName);
  const name = o.label || (institutes.length === 1 ? institutes[0]! : `${institutes.length} institutes`);
  const logUrl = `${env.appUrl}/prospects?view=history&run=${encodeURIComponent(run._id)}`;
  const leadsUrl = `${env.appUrl}/leads?status=pending_review`;
  const scheduled = o.triggeredBy?.startsWith('schedule:') ? o.triggeredBy.slice('schedule:'.length) : undefined;

  const outcome =
    run.status === 'failed'
      ? `Finding people stopped with an error: ${run.error ?? 'unknown error'}. Everyone found before that went through the pipeline.`
      : run.status === 'cancelled'
        ? 'Finding people was cancelled. Everyone found before that went through the pipeline.'
        : 'Finished.';

  const facts: Array<[string, string]> = [
    ['Institutes', institutes.join(', ') || '—'],
    ['Started', `${ist(run.startedAt)}${scheduled ? ` — scheduled run "${scheduled}"` : ''}${o.late ? ' (started late: the server was off at the scheduled time)' : ''}`],
    ['Finished', `${ist(finishedAt)} (${duration(new Date(run.startedAt), finishedAt)})`],
  ];
  const numbers: Array<[string, number, string?]> = [
    ['People found', people.total],
    ['New leads in Leads → To review', people.inLeads],
    [`Excluded (score below ${o.threshold ?? threshold})`, people.excluded],
    ['Need a person (review / failed)', people.attention, 'In Prospects → View stage → Needs a person'],
  ];
  if (mode === 'manual' && people.waiting > 0) numbers.push(['Waiting for you to move them on (Manual mode)', people.waiting, 'In Prospects']);

  const subject = `Run finished: ${name} — ${people.inLeads} new lead${people.inLeads === 1 ? '' : 's'}`;

  const text = [
    `${name}: ${outcome}`,
    '',
    ...facts.map(([k, v]) => `${k}: ${v}`),
    '',
    ...numbers.map(([k, v, hint]) => `${k}: ${v.toLocaleString('en-IN')}${hint && v > 0 ? ` (${hint})` : ''}`),
    ...(top.length ? ['', 'Top new leads:', ...top.map((l) => `- ${l.name}${l.institute ? `, ${l.institute}` : ''}${l.score !== undefined ? ` — score ${l.score}` : ''}`)] : []),
    '',
    `Run log: ${logUrl}`,
    `Leads to review: ${leadsUrl}`,
  ].join('\n');

  const row = (k: string, v: string) => `<tr><td style="padding:4px 16px 4px 0;color:#5b6473;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td style="padding:4px 0">${v}</td></tr>`;
  const button = (href: string, label: string, primary: boolean) =>
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 16px;margin:0 8px 8px 0;border-radius:6px;text-decoration:none;font-weight:600;${primary ? 'background:#1f3a68;color:#ffffff' : 'background:#eef1f6;color:#1f3a68'}">${escapeHtml(label)}</a>`;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1d2430;max-width:640px">
<h2 style="margin:0 0 4px;font-size:18px">${escapeHtml(name)}</h2>
<p style="margin:0 0 16px;color:${run.status === 'completed' ? '#2f6b3a' : '#9a5b00'}">${escapeHtml(outcome)}</p>
<table style="border-collapse:collapse;margin-bottom:16px">${facts.map(([k, v]) => row(k, escapeHtml(v))).join('')}</table>
<table style="border-collapse:collapse;margin-bottom:16px">${numbers
    .map(([k, v, hint]) => row(k, `<strong>${v.toLocaleString('en-IN')}</strong>${hint && v > 0 ? ` <span style="color:#5b6473">— ${escapeHtml(hint)}</span>` : ''}`))
    .join('')}</table>
${
  top.length
    ? `<p style="margin:0 0 6px;font-weight:600">Top new leads</p><table style="border-collapse:collapse;margin-bottom:16px">${top
        .map((l) => `<tr><td style="padding:3px 16px 3px 0">${escapeHtml(l.name)}</td><td style="padding:3px 16px 3px 0;color:#5b6473">${escapeHtml(l.institute ?? '')}</td><td style="padding:3px 0">${l.score ?? ''}</td></tr>`)
        .join('')}</table>`
    : ''
}
<p style="margin:16px 0 0">${button(leadsUrl, 'Review new leads', true)}${button(logUrl, 'Open the run log', false)}</p>
<p style="margin:16px 0 0;color:#8a93a3;font-size:12px">You get this because you started this run${scheduled ? ' (you created its schedule)' : ''}.</p>
</div>`;

  return { subject, text, html };
}

/** Sends the email for every run that has just finished. Returns how many were sent. */
export async function notifyFinishedRuns(now = new Date(), transport: EmailTransport = getEmailTransport()): Promise<number> {
  const candidates = (await RosterRunModel.find({
    'options.flow': true,
    'options.notifyEmail': { $exists: true, $ne: null },
    status: { $ne: 'running' },
    'notification.sentAt': { $exists: false },
    $or: [{ 'notification.attempts': { $exists: false } }, { 'notification.attempts': { $lt: MAX_ATTEMPTS } }],
  }).lean()) as unknown as RunDoc[];
  if (!candidates.length) return 0;

  const settings = await getPipelineSettings();
  const { mode } = settings;
  const people = await peopleByRun(candidates.map((r) => r._id), mode);
  let sent = 0;
  for (const run of candidates) {
    const to = run.options?.notifyEmail?.trim() ?? '';
    const p = people.get(run._id) ?? { total: 0, inLeads: 0, excluded: 0, moving: 0, attention: 0, waiting: 0 };
    if (p.moving > 0) continue; // still flowing
    if (!EMAIL.test(to)) {
      await RosterRunModel.updateOne({ _id: run._id }, { $set: { 'notification.attempts': MAX_ATTEMPTS, 'notification.error': `Not an email address: ${to}` } });
      continue;
    }
    // Claim it, so a parallel tick or a second instance does not send it again.
    const claimed = await RosterRunModel.findOneAndUpdate({ _id: run._id, 'notification.sentAt': { $exists: false } }, { $set: { 'notification.sentAt': now, 'notification.to': to } });
    if (!claimed) continue;

    const top = (await FacultyMemberModel.find({ 'flow.runId': run._id, 'flow.stage': 'done', status: 'promoted' }, { person: 1, 'institution.name': 1, 'relevance.score': 1 })
      .sort({ 'relevance.score': -1 })
      .limit(TOP_LEADS)
      .lean()) as Array<{ person: { name: string }; institution?: { name?: string }; relevance?: { score?: number } }>;
    const email = buildRunEmail(run, p, top.map((m) => ({ name: m.person.name, institute: m.institution?.name, score: m.relevance?.score })), now, settings);
    try {
      await transport.send({ to, ...email, internal: true });
      await RosterRunModel.updateOne({ _id: run._id }, { $unset: { 'notification.error': '' } });
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[runs] could not email ${run._id}:`, message);
      await RosterRunModel.updateOne(
        { _id: run._id },
        { $unset: { 'notification.sentAt': '' }, $inc: { 'notification.attempts': 1 }, $set: { 'notification.error': message } },
      );
    }
  }
  return sent;
}

let timer: NodeJS.Timeout | null = null;

export function startRunNotifier(): void {
  const tick = () => void notifyFinishedRuns().catch((e) => console.error('[runs] notify tick failed:', e instanceof Error ? e.message : e));
  timer = setInterval(tick, 30_000);
}

export function stopRunNotifier(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
