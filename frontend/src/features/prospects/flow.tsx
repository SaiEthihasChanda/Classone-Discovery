/**
 * The Prospects conveyor's vocabulary, shared by the board, the record panel
 * and the View stage screen. A column holds the people waiting for (or in)
 * that column's next step.
 */
import type { FlowStage, FlowState, MemberFlow } from '../../types';

export type BoardStage = 'found' | 'verified' | 'scored' | 'filling' | 'crm';

export const COLUMNS: Array<{ board: BoardStage; stage: FlowStage; title: string; next?: string; hint: string }> = [
  { board: 'found', stage: 'verify', title: 'Found', next: 'Verify', hint: 'Waiting to be checked against ORCID / OpenAlex' },
  { board: 'verified', stage: 'score', title: 'Verified', next: 'Score', hint: 'Still at the institute — waiting to be scored' },
  { board: 'scored', stage: 'promote', title: 'Scored', next: 'Move to Leads', hint: 'Scored — strong fits move on to Leads' },
  { board: 'filling', stage: 'fill', title: 'Filling info', next: 'Fill info', hint: 'Finding missing email, title, phone' },
  { board: 'crm', stage: 'done', title: 'In Leads', hint: 'Waiting for approval in Leads' },
];

export const columnOf = (stage?: FlowStage) => COLUMNS.find((c) => c.stage === (stage ?? 'verify')) ?? COLUMNS[0]!;

const STATE_LABEL: Record<FlowState, string> = {
  idle: 'Waiting',
  queued: 'Queued',
  processing: 'In progress',
  review: 'Needs review',
  failed: 'Failed',
};

export function FlowChip({ flow, compact }: { flow?: MemberFlow; compact?: boolean }) {
  const state = flow?.state ?? 'idle';
  if (state === 'idle' && compact) return null;
  const retry = state === 'queued' && flow?.nextAttemptAt && new Date(flow.nextAttemptAt) > new Date();
  return (
    <span className={`flow-chip ${state}`} title={flow?.lastError ?? flow?.note}>
      {retry ? `Retry ${timeFromNow(flow!.nextAttemptAt!)}` : STATE_LABEL[state]}
    </span>
  );
}

export function timeFromNow(iso: string): string {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  return `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function timeSince(iso?: string): string {
  if (!iso) return '';
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** The step a "Redo" re-runs — the one that put the person in their current column. */
export const REDO_LABEL: Record<FlowStage, string> = {
  verify: 'Verify again',
  score: 'Verify again',
  promote: 'Score again',
  fill: 'Fill again',
  done: 'Fill again',
};

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function describeSchedule(s: { type: 'once' | 'recurring'; runAt?: string; weekdays?: number[]; time?: string }): string {
  if (s.type === 'once') return s.runAt ? `Once, ${new Date(s.runAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Once';
  const days = s.weekdays ?? [];
  const label = days.length === 7 ? 'Every day' : days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d)) ? 'Weekdays' : days.map((d) => WEEKDAYS[d]).join(', ');
  return `${label} at ${s.time} IST`;
}
