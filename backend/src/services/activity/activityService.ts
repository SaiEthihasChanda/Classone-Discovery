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
    return await repositories.activity.create({
      type: params.type,
      severity: params.severity ?? 'info',
      message: params.message,
      relatedLeadId: params.relatedLeadId,
      relatedThreadId: params.relatedThreadId,
      metadata: params.metadata,
    });
  } catch (error) {
    console.error('[activity] failed to write log entry:', error);
    return null;
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
