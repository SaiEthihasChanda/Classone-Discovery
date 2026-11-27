/**
 * Who is acting, for the length of one API request.
 *
 * `authorize` runs the rest of the request inside `requestContext`, so anything that logs activity
 * (services/activity) can record the signed-in person without every call passing them along. The
 * audit trail (auditTrail below) then records each change a person makes — once per request: when
 * a service has already logged the action in its own words, the generic entry is skipped.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import type { AuthUser } from './auth.js';

interface Ctx {
  user?: AuthUser;
  /** Set when a service logged this request's action itself. */
  logged?: boolean;
}

export const requestContext = new AsyncLocalStorage<Ctx>();

/** The person behind the current request, if any (background jobs have none). */
export function currentActor(): { actor: string; actorName?: string } | null {
  const u = requestContext.getStore()?.user;
  if (!u || u.uid === 'internal') return null;
  return { actor: u.email, actorName: u.name };
}

export function markLogged(): void {
  const s = requestContext.getStore();
  if (s) s.logged = true;
}

export function runWithUser(req: Request, _res: Response, next: NextFunction): void {
  requestContext.run({ user: req.user }, next);
}

// --- Audit trail --------------------------------------------------------------------------------------

type Describe = (p: Record<string, string>, body: Record<string, any>) => string | null;

/** Requests that change nothing worth recording (previews, AI suggestions, marking read). */
const QUIET = [
  /^POST \/campaigns\/(audience\/)?preview$/,
  /^POST \/campaigns\/ai-text$/,
  /^POST \/conversations\/threads\/[^/]+\/(read|ai-draft)$/,
  /^POST \/roster\/pipeline\/estimate$/,
  /^POST \/schedules\/availability$/,
];

/** Method + path pattern → a sentence. `:name` segments arrive in `p`. */
const ROUTES: Array<[string, string, Describe]> = [
  ['POST', '/leads', () => 'Added a lead'],
  ['PATCH', '/leads/:id', () => 'Edited a lead'],
  ['DELETE', '/leads/:id', () => 'Deleted a lead'],
  ['POST', '/leads/:id/review', (_p, b) => (b.decision === 'approve' || b.status === 'approved' ? 'Approved a lead' : b.decision === 'reject' || b.status === 'rejected' ? 'Rejected a lead' : 'Reviewed a lead')],
  ['POST', '/leads/review-bulk', (_p, b) => `Reviewed ${Array.isArray(b.ids) ? b.ids.length : 'several'} leads at once`],
  ['POST', '/leads/:id/draft-outreach', () => 'Asked the AI for an outreach draft'],
  ['POST', '/leads/:id/enrich-web', () => 'Looked up missing details for a lead'],
  ['POST', '/leads/:id/verify-affiliation', () => "Checked a lead's affiliation"],
  ['POST', '/leads/:id/scan-instruments', () => "Scanned a lead's papers for instruments"],
  ['POST', '/threads/:id/approve-send', () => 'Approved and sent a draft'],
  ['POST', '/threads/:id/reject-draft', () => 'Discarded a draft'],
  ['POST', '/threads/:id/mark-replied', () => 'Marked a conversation as replied'],
  ['POST', '/conversations/threads/:id/reply', () => 'Replied in a conversation'],
  ['POST', '/conversations/threads/:id/send-draft', () => 'Sent an AI draft'],
  ['POST', '/conversations/threads/:id/discard-draft', () => 'Discarded a draft'],
  ['POST', '/conversations/threads/:id/handled', () => 'Marked a conversation as needing no reply'],
  ['POST', '/conversations/compose', (_p, b) => `Wrote a new message to ${b.to ?? 'someone'}`],
  ['POST', '/conversations/people/:email/to-lead', (p) => `Added ${p.email} to the CRM`],
  ['PUT', '/conversations/people/:email/do-not-contact', (p, b) => `${b.value === false ? 'Allowed emails to' : 'Marked do-not-contact:'} ${p.email}`],
  ['PUT', '/conversations/people/:email/auto-reply', (p, b) => `${b.value ? 'Turned on' : 'Turned off'} holding replies for ${p.email}`],
  ['PUT', '/conversations/people/:email/follow-up-mode', (p, b) => `Set follow-ups for ${p.email} to ${b.value ?? 'default'}`],
  ['PUT', '/conversations/settings', (_p, b) => `Set follow-ups to ${b.followUpMode === 'auto' ? 'Auto' : 'Manual'}`],
  ['PUT', '/conversations/check-ins', (_p, b) => (b.enabled === undefined ? 'Changed check-in settings' : `Turned check-ins ${b.enabled ? 'on' : 'off'}`)],
  ['POST', '/campaigns', () => 'Created a campaign'],
  ['PUT', '/campaigns/:id', () => 'Edited a campaign'],
  ['DELETE', '/campaigns/:id', () => 'Deleted a campaign'],
  ['POST', '/campaigns/:id/duplicate', () => 'Duplicated a campaign'],
  ['POST', '/campaigns/:id/test', () => 'Sent a campaign test email'],
  ['POST', '/campaigns/:id/start', (_p, b) => (b.sendAt ? 'Scheduled a campaign' : 'Started sending a campaign')],
  ['POST', '/campaigns/:id/pause', () => 'Paused a campaign'],
  ['POST', '/campaigns/:id/nudge-non-bookers', () => "Drafted follow-ups for people who didn't book"],
  ['POST', '/campaigns/:id/cancel', () => 'Cancelled a campaign'],
  ['POST', '/campaigns/assets', () => 'Uploaded a campaign image'],
  ['PUT', '/campaigns/launches/settings', (_p, b) => (b.mode ? `Set new-product announcements to ${b.mode === 'auto' ? 'Auto' : 'Manual'}` : 'Changed new-product announcement settings')],
  ['POST', '/campaigns/launches/check', () => 'Checked the website for new products'],
  ['POST', '/catalog', () => 'Added a catalog product'],
  ['PATCH', '/catalog/:id', () => 'Edited a catalog product'],
  ['DELETE', '/catalog/:id', () => 'Removed a catalog product'],
  ['PATCH', '/settings', () => 'Changed discovery settings'],
  ['POST', '/settings/targets', () => 'Added a scrape source'],
  ['DELETE', '/settings/targets/:id', () => 'Removed a scrape source'],
  ['POST', '/settings/reset', () => 'Reset settings to defaults'],
  ['POST', '/settings/mailbox-import', (_p, b) => `Imported mailbox history (${b.from ?? '?'} to ${b.to ?? '?'})`],
  ['PATCH', '/users/:uid', (_p, b) => (b.role ? `Changed a user's role to ${b.role}` : 'Edited a user')],
  ['POST', '/admin/wipe-crm', () => 'Wiped the CRM'],
  ['POST', '/discovery/run', () => 'Started a discovery run'],
  ['POST', '/discovery/by-name', () => 'Looked up a researcher by name'],
  ['POST', '/discovery/by-names', () => 'Looked up researchers by name'],
  ['POST', '/pipeline/runs', () => 'Started a Prospects run'],
  ['PUT', '/pipeline/settings', (_p, b) => (b.mode ? `Set Prospects to ${b.mode}` : 'Changed Prospects settings')],
  ['POST', '/pipeline/stages/:stage/run', (p) => `Ran the ${p.stage} stage`],
  ['POST', '/pipeline/members/:id/action', (_p, b) => `${b.action ? String(b.action).replace(/_/g, ' ') : 'Acted on'} a prospect`],
  ['POST', '/pipeline/schedules', () => 'Scheduled a Prospects run'],
  ['PUT', '/pipeline/schedules/:id', () => 'Changed a scheduled run'],
  ['DELETE', '/pipeline/schedules/:id', () => 'Removed a scheduled run'],
  ['POST', '/roster/import', () => 'Imported a faculty roster'],
  ['POST', '/roster/promote', () => 'Promoted roster people to leads'],
  ['DELETE', '/roster', () => 'Cleared roster entries'],
  ['POST', '/dashboard/weekly-summary', () => 'Emailed the weekly summary'],
  ['POST', '/funding/check', () => 'Checked leads for new funding'],
  ['POST', '/funding/signals/:id/dismiss', () => 'Dismissed a new-funding alert'],
  ['POST', '/schedules/events', (_p, b) => `Added "${b.title ?? 'an event'}" to the calendar`],
  ['PUT', '/schedules/events/:id', () => 'Changed a calendar event'],
  ['DELETE', '/schedules/events/:id', () => 'Removed a calendar event'],
  ['POST', '/schedules/events/:id/check-in', () => 'Checked in at a visit'],
  ['POST', '/schedules/events/:id/check-out', () => 'Checked out of a visit'],
  ['PUT', '/schedules/booking', () => 'Changed demo booking settings'],
];

const compiled = ROUTES.map(([method, pattern, describe]) => {
  const names: string[] = [];
  const rx = new RegExp(`^${pattern.replace(/:(\w+)/g, (_m, n: string) => (names.push(n), '([^/]+)'))}/?$`);
  return { method, rx, names, describe };
});

export function describeRequest(method: string, path: string, body: Record<string, any> = {}): { message: string; params: Record<string, string> } | null {
  const key = `${method} ${path}`;
  if (QUIET.some((q) => q.test(key))) return null;
  for (const r of compiled) {
    if (r.method !== method) continue;
    const m = r.rx.exec(path);
    if (!m) continue;
    const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? '')]));
    const message = r.describe(params, body ?? {});
    return message ? { message, params } : null;
  }
  // Anything not listed is still recorded, plainly.
  const verb = method === 'DELETE' ? 'Deleted' : method === 'POST' ? 'Did' : 'Changed';
  return { message: `${verb} ${path.replace(/\/[a-f\d]{24}/gi, '/…')}`, params: {} };
}

/** Records each successful change a signed-in person makes (mounted after `authorize`). */
export function auditTrail(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const store = requestContext.getStore();
  const path = req.path;
  const body = (req.body ?? {}) as Record<string, any>;
  res.on('finish', () => {
    if (res.statusCode >= 400 || store?.logged) return;
    const actor = store?.user && store.user.uid !== 'internal' ? store.user : null;
    if (!actor) return;
    const d = describeRequest(req.method, path, body);
    if (!d) return;
    void import('../services/activity/activityService.js').then(({ recordUserAction }) =>
      recordUserAction({ message: d.message, actor: actor.email, actorName: actor.name, path, method: req.method, params: d.params }),
    );
  });
  next();
}
