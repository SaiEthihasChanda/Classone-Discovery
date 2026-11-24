import type { ReactNode } from 'react';
import type { FundingAcknowledgement, FundingAgency, LeadStatus } from '../types';

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
  if (affiliation.status === 'conflict') {
    return (
      <span className="badge badge-pending" title={title}>
        needs review · sources disagree
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

// ---------------------------------------------------------------------------
// Funding (from paper acknowledgements)
// ---------------------------------------------------------------------------

/** Agencies the sales team tracks, in display order (mirrors backend services/funding). */
export const FUNDING_AGENCIES: Array<{ key: Exclude<FundingAgency, 'other'>; label: string }> = [
  { key: 'serb', label: 'SERB' },
  { key: 'anrf', label: 'ANRF' },
  { key: 'dst', label: 'DST' },
  { key: 'dbt', label: 'DBT' },
  { key: 'icmr', label: 'ICMR' },
  { key: 'csir', label: 'CSIR' },
  { key: 'birac', label: 'BIRAC' },
];
const AGENCY_LABEL: Record<string, string> = Object.fromEntries(FUNDING_AGENCIES.map((a) => [a.key, a.label]));

/** SERB-PRISM: SERB/ANRF projects by file number (captcha-protected, so a person looks it up). */
export const SERB_PRISM_URL = 'https://prism.serbonline.in/Search';

/** Compact agency chips for a table cell: tracked agencies with their latest grant year. */
export function FundingChips({ funding, checkedAt }: { funding?: FundingAcknowledgement[]; checkedAt?: string }) {
  const tracked = (funding ?? []).filter((f) => f.agency !== 'other');
  if (tracked.length === 0) {
    return <span className="muted small" title={checkedAt ? 'No tracked agency acknowledged on recent papers' : 'Funding not checked yet'}>{checkedAt ? '—' : '·'}</span>;
  }
  const byAgency = new Map<string, number | undefined>();
  for (const f of tracked) {
    const y = f.year ?? undefined;
    const prev = byAgency.get(f.agency);
    byAgency.set(f.agency, prev === undefined ? y : y === undefined ? prev : Math.max(prev, y));
  }
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {FUNDING_AGENCIES.filter((a) => byAgency.has(a.key)).map((a) => {
        const grants = tracked.filter((f) => f.agency === a.key);
        const title = grants.map((g) => [g.scheme, g.year, g.awardId].filter(Boolean).join(' · ') || g.funder).join('\n');
        const y = byAgency.get(a.key);
        return (
          <span key={a.key} className="tag" title={title}>
            {a.label}
            {y ? ` ’${String(y).slice(2)}` : ''}
          </span>
        );
      })}
    </div>
  );
}

/** Full list for a detail page, with the SERB-PRISM lookup for SERB/ANRF grant numbers. */
export function FundingList({ funding, checkedAt }: { funding?: FundingAcknowledgement[]; checkedAt?: string }) {
  if (!checkedAt && !(funding ?? []).length) {
    return <p className="muted small" style={{ margin: 0 }}>Not checked yet — funding is read with the next scoring run or <code>npm --prefix backend run funding:refresh</code>.</p>;
  }
  const items = funding ?? [];
  if (items.length === 0) {
    return <p className="muted small" style={{ margin: 0 }}>No funder acknowledged on recent papers. About half of papers name none, so this is not evidence of no funding.</p>;
  }
  const copyAndOpen = (awardId: string) => {
    void navigator.clipboard?.writeText(awardId).catch(() => undefined);
    window.open(SERB_PRISM_URL, '_blank', 'noreferrer');
  };
  return (
    <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 10 }}>
      {items.map((f, i) => (
        <li key={`${f.agency}-${f.awardId ?? f.funder}-${i}`}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>{f.agency === 'other' ? f.funder : AGENCY_LABEL[f.agency]}</strong>
            {f.scheme && <span className="small">{f.scheme}</span>}
            {f.year && <span className="badge badge-neutral">{f.year}</span>}
            {f.awardId && <code className="small">{f.awardId}</code>}
            {f.awardId && (f.agency === 'serb' || f.agency === 'anrf') && (
              <button type="button" className="btn btn-sm" title="Copies the grant number and opens SERB-PRISM — paste it into the file-number search for the project title, status and sanctioned equipment" onClick={() => copyAndOpen(f.awardId!)}>
                SERB-PRISM →
              </button>
            )}
          </div>
          <div className="muted small" style={{ marginTop: 2 }}>
            {f.agency !== 'other' && f.funder !== AGENCY_LABEL[f.agency] && <>{f.funder} · </>}
            acknowledged on {f.papers} recent paper{f.papers === 1 ? '' : 's'}
            {f.workTitle && (
              <>
                , e.g.{' '}
                {f.workUrl ? (
                  <a href={f.workUrl.startsWith('http') ? f.workUrl : `https://doi.org/${f.workUrl}`} target="_blank" rel="noreferrer">
                    {f.workTitle}
                  </a>
                ) : (
                  f.workTitle
                )}
                {f.workYear ? ` (${f.workYear})` : ''}
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}