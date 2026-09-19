import type { ReactNode } from 'react';
import type { LeadStatus } from '../types';

const STATUS_LABELS: Record<LeadStatus, string> = {
  pending_review: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
  customer: 'Customer',
};

const STATUS_CLASS: Record<LeadStatus, string> = {
  pending_review: 'badge-pending',
  approved: 'badge-approved',
  rejected: 'badge-rejected',
  customer: 'badge-customer',
};

export function StatusBadge({ status }: { status: LeadStatus }) {
  return <span className={`badge ${STATUS_CLASS[status]}`}>{STATUS_LABELS[status]}</span>;
}

export function SourceBadge({ source }: { source: string }) {
  return <span className="badge badge-neutral">{source.replace(/_/g, ' ')}</span>;
}

/**
 * Marks an instrument sighting by what it means for sales: a Class One brand
 * (PalmSens/CorrTest — existing user) or a competitor's unit (proven buyer).
 */
export function InstrumentBadge({
  vendor,
  brand,
  model,
}: {
  vendor: 'classone' | 'competitor';
  /** Brand name; omitted only for the generic "user of ours / competitor" pill. */
  brand?: string;
  /** Specific model when identified; the badge shows the brand alone otherwise. */
  model?: string;
}) {
  const isOwn = vendor === 'classone';
  const who = isOwn ? 'Class One brand' : 'competitor';
  return (
    <span
      className={`badge ${isOwn ? 'badge-approved' : 'badge-customer'}`}
      title={
        brand
          ? `${brand}${model ? ` ${model}` : ' (model not identified)'} — ${who}`
          : isOwn
            ? 'Already uses a Class One brand'
            : 'Uses competitor equipment'
      }
    >
      {brand ? (
        <>
          {brand}
          {model && <> · <strong>{model}</strong></>}
        </>
      ) : isOwn ? (
        'Class One brand user'
      ) : (
        'Competitor user'
      )}
    </span>
  );
}

/**
 * Where the person is, as last checked. Nothing is rendered for a confirmed
 * current affiliation — the institute name already says it — only for the
 * cases a salesperson must not miss: moved, or nowhere we can confirm.
 */
export function AffiliationNote({
  affiliation,
  institutionName,
}: {
  affiliation?: { status: string; previousInstitution?: string; directoryListed?: boolean; verifiedAt?: string; note?: string };
  institutionName?: string;
}) {
  if (!affiliation) return null;
  const title = affiliation.note ?? '';
  if (affiliation.status === 'moved') {
    return (
      <span className="badge badge-pending" title={title}>
        moved{affiliation.previousInstitution ? ` from ${shortInstitute(affiliation.previousInstitution)}` : ''}
      </span>
    );
  }
  if (affiliation.status === 'unknown') {
    return (
      <span className="badge badge-rejected" title={title}>
        left{affiliation.previousInstitution ? ` ${shortInstitute(affiliation.previousInstitution)}` : ''} · current unknown
      </span>
    );
  }
  if (affiliation.directoryListed === false && institutionName) {
    return (
      <span className="badge badge-pending" title={title}>
        not in directory
      </span>
    );
  }
  return null;
}

/** "Indian Institute of Technology Bombay" → "IIT Bombay", for a badge. */
export function shortInstitute(name: string): string {
  return name
    .replace(/^Indian Institute of Information Technology\b/i, 'IIIT')
    .replace(/^Indian Institute of Technology\b/i, 'IIT')
    .replace(/^National Institute of Technology\b/i, 'NIT')
    .replace(/^Indian Institute of Science\b/i, 'IISc');
}

export function ErrorBanner({ message }: { message: string }) {
  return <div className="alert alert-error">{message}</div>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="empty">{label}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Renders a timestamp as "5h ago", matching the proposal's activity feed. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';

  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;

  return new Date(iso).toLocaleDateString();
}

export function formatDate(iso?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

/** Colour-codes the AI relevance score so a reviewer can scan the queue quickly. */
export function ScorePill({ score }: { score?: number }) {
  if (score === undefined || score === null) return <span className="muted">—</span>;

  const cls = score >= 70 ? 'badge-approved' : score >= 40 ? 'badge-pending' : 'badge-neutral';
  return <span className={`badge ${cls}`}>{score}</span>;
}
