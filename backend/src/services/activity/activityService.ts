/**
 * Activity logging.
 *
 * Two rules this module exists to enforce:
 *
 * 1. The display string is composed HERE, at write time, with the lead and
 *    institution names baked in. The dashboard feed then renders straight from
 *    the collection with no lookups.
 * 2. Logging never breaks the operation it describes. A failed log is reported
 *    to the console and swallowed — losing a feed entry must not fail an email
 *    send or a lead approval.
 */
import { repositories } from '../../repositories/index.js';
import { currentActor, markLogged } from '../../middleware/requestContext.js';
import { EmailThreadModel } from '../../models/emailThread.model.js';
import { LeadModel } from '../../models/lead.model.js';
import type {
  ActivitySeverity,
  ActivityType,
  ActivityLogEntry,
  Lead,
} from '../../types/domain.js';

interface LogParams {
  type: ActivityType;
  message: string;
  severity?: ActivitySeverity;
  relatedLeadId?: string;
  relatedThreadId?: string;
  metadata?: Record<string, unknown>;
}

export async function logActivity(params: LogParams): Promise<ActivityLogEntry | null> {
  try {
    // Inside a signed-in request the person is recorded too, and the request's generic audit entry is skipped.
    const who = currentActor();
    if (who) markLogged();
    return await repositories.activity.create({
      type: params.type,
      severity: params.severity ?? 'info',
      message: params.message,
      relatedLeadId: params.relatedLeadId,
      relatedThreadId: params.relatedThreadId,
      metadata: params.metadata,
      ...(who ?? {}),
    });
  } catch (error) {
    console.error('[activity] failed to write log entry:', error);
    return null;
  }
}

/**
 * One change a person made through the app (middleware/requestContext.ts auditTrail), named in plain
 * words, with the lead or conversation it touched where the path says so.
 */
export async function recordUserAction(a: { message: string; actor: string; actorName?: string; path: string; method: string; params: Record<string, string> }): Promise<void> {
  try {
    let relatedLeadId: string | undefined;
    let relatedThreadId: string | undefined;
    let about = '';
    const id = a.params.id;
    if (id && /^[a-f\d]{24}$/i.test(id) && a.path.startsWith('/leads/')) {
      relatedLeadId = id;
      const l = (await LeadModel.findById(id, { person: 1, institution: 1 }).lean()) as { person?: { name?: string }; institution?: { name?: string } } | null;
      if (l?.person?.name) about = ` — ${l.person.name}${l.institution?.name ? `, ${l.institution.name}` : ''}`;
    } else if (id && /^[a-f\d]{24}$/i.test(id) && /^\/(threads|conversations\/threads)\//.test(a.path)) {
      relatedThreadId = id;
      const t = (await EmailThreadModel.findById(id, { contactName: 1, contactEmail: 1, leadEmailSnapshot: 1, leadId: 1 }).lean()) as { contactName?: string; contactEmail?: string; leadEmailSnapshot?: string; leadId?: string } | null;
      relatedLeadId = t?.leadId;
      const who = t?.contactName ?? t?.contactEmail ?? t?.leadEmailSnapshot;
      if (who) about = ` — ${who}`;
    }
    await repositories.activity.create({
      type: 'user_action',
      severity: a.method === 'DELETE' ? 'warning' : 'info',
      message: `${a.message}${about}`,
      relatedLeadId,
      relatedThreadId,
      metadata: { method: a.method, path: a.path },
      actor: a.actor,
      actorName: a.actorName,
    });
  } catch (error) {
    console.error('[activity] failed to record a user action:', error);
  }
}

/** "Dr. L. Chen, MIT" — the standard way a lead is named in the feed. */
export function describeLead(lead: Pick<Lead, 'person' | 'institution'>): string {
  const institution = lead.institution?.name;
  return institution ? `${lead.person.name}, ${institution}` : lead.person.name;
}

/**
 * Records the outcome of a discovery run as ONE entry, not one per lead.
 *
 * A 500-lead weekly run logged individually would bury everything else in the
 * feed. Individual `lead_discovered` entries are reserved for leads that clear
 * a score threshold and are genuinely worth surfacing.
 */
export async function logDiscoveryRun(params: {
  sourcesRun: string[];
  candidatesFound: number;
  leadsCreated: number;
  duplicatesSkipped: number;
  errors: number;
  durationMs: number;
}): Promise<void> {
  const summary =
    `Discovery run complete — ${params.leadsCreated} new leads from ` +
    `${params.candidatesFound} candidates (${params.duplicatesSkipped} duplicates skipped)`;

  await logActivity({
    type: 'discovery_run_completed',
    severity: params.errors > 0 ? 'warning' : 'info',
    message: params.errors > 0 ? `${summary}, ${params.errors} source errors` : summary,
    metadata: { ...params },
  });
}
