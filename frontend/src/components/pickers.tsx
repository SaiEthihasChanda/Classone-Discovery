/** Pickers and the live job panel shared by Prospects (board, wizard) and Home. */
import { useState } from 'react';
import { api, openApiFile } from '../api/client';
import { formatDate, shortInstitute } from './common';
import type { RosterJob, RosterJobKind } from '../types';

export const ROLE_LABELS: Record<string, string> = {
  professor: 'Professor',
  scientist: 'Scientist',
  officer: 'Officer / lab in-charge',
  fellow: 'Faculty fellow',
  inferred: 'Likely faculty (inferred)',
  unknown: 'Unknown',
  excluded: 'Excluded',
};

export const STAGE_LABEL: Record<RosterJobKind, string> = {
  roster_build: '1 · Build roster',
  roster_verify: '2 · Verify affiliations',
  roster_score: '3 · Score relevance',
  roster_sweep: '3b · Instrument sweep',
  roster_promote: '4 · Promote to CRM',
  roster_fill: '5 · Fill missing info',
  roster_pipeline: 'Pipeline run',
};

export function InstitutePicker({
  options,
  selected,
  onChange,
}: {
  options: Array<{ id: string; name: string; kind: string }>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [filter, setFilter] = useState('');
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const term = filter.trim().toLowerCase();
  const matching = term ? options.filter((o) => o.name.toLowerCase().includes(term)) : options;
  const label = selected.length === 0 ? 'Choose institutes' : selected.length === 1 ? shortInstitute(options.find((o) => o.id === selected[0])?.name ?? '') : `${selected.length} institutes`;
  const PILOT = ['I162827531', 'I68891433', 'I24676775', 'I145894827', 'I94234084']; // Bombay, Delhi, Madras, Kharagpur, Kanpur

  return (
    <details className="dropdown">
      <summary className={`btn btn-sm${selected.length > 0 ? ' btn-primary' : ''}`}>{label} ▾</summary>
      <div className="dropdown-menu" style={{ minWidth: 380 }}>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name…" style={{ marginBottom: 8 }} />
        <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={() => onChange(PILOT)}>
            Pilot 5 (IIT B/D/M/KGP/K)
          </button>
          {['IIT', 'NIT', 'IIIT'].map((kind) => (
            <button key={kind} className="btn btn-sm" onClick={() => onChange([...new Set([...selected, ...options.filter((o) => o.kind === kind).map((o) => o.id)])])}>
              + all {kind}s
            </button>
          ))}
          <button className="btn btn-sm" onClick={() => onChange(options.map((o) => o.id))}>
            All 72
          </button>
          {selected.length > 0 && (
            <button className="btn btn-sm" onClick={() => onChange([])}>
              Clear
            </button>
          )}
        </div>
        {matching.map((inst) => (
          <label key={inst.id} className="dropdown-option">
            <input type="checkbox" checked={selected.includes(inst.id)} onChange={() => toggle(inst.id)} style={{ width: 'auto' }} />
            <span>
              {inst.name} <span className="muted small">({inst.kind})</span>
            </span>
          </label>
        ))}
      </div>
    </details>
  );
}

/**
 * A checklist in a popover: the filter's label shows what is selected. Nothing
 * ticked means "any". Long lists (institutes) get a text filter inside.
 */
export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  searchable = false,
  title,
}: {
  label: string;
  options: Array<{ value: string; label: string; hint?: string }>;
  selected: string[];
  onChange: (next: string[]) => void;
  searchable?: boolean;
  title?: string;
}) {
  const [filter, setFilter] = useState('');
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const term = filter.trim().toLowerCase();
  const shown = term ? options.filter((o) => o.label.toLowerCase().includes(term)) : options;
  const summary =
    selected.length === 0
      ? label
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${label}: ${selected.length}`;
  return (
    <details className="dropdown" title={title}>
      <summary className={`btn btn-sm${selected.length > 0 ? ' btn-primary' : ''}`}>{summary} ▾</summary>
      <div className="dropdown-menu" style={{ minWidth: 260, maxHeight: 360, overflowY: 'auto' }}>
        {searchable && <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" style={{ marginBottom: 8 }} />}
        {selected.length > 0 && (
          <button className="btn btn-sm" style={{ marginBottom: 6 }} onClick={() => onChange([])}>
            Clear
          </button>
        )}
        {shown.map((o) => (
          <label key={o.value} className="dropdown-option">
            <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} style={{ width: 'auto' }} />
            <span>
              {o.label}
              {o.hint && <span className="muted small"> {o.hint}</span>}
            </span>
          </label>
        ))}
        {shown.length === 0 && <p className="muted small">Nothing matches.</p>}
      </div>
    </details>
  );
}

/** Live view of one job: stage line, progress bar, counters, last log lines. */
export function JobPanel({ job, onCancel }: { job: RosterJob; onCancel: () => void }) {
  const running = job.status === 'running';
  const counters = Object.entries(job.counters);
  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <strong>{STAGE_LABEL[job.kind]}</strong>{' '}
          <span className={`badge ${job.status === 'running' ? 'badge-pending' : job.status === 'completed' ? 'badge-approved' : job.status === 'failed' ? 'badge-rejected' : 'badge-neutral'}`}>{job.status}</span>
          <div className="small muted" style={{ marginTop: 4 }}>
            {job.stage}
            {job.finishedAt ? ` · finished ${formatDate(job.finishedAt)}` : ` · started ${formatDate(job.startedAt)}`}
          </div>
        </div>
        {running && (
          <button className="btn btn-sm btn-danger" onClick={onCancel}>
            Stop after current item
          </button>
        )}
      </div>
      {job.progress !== undefined && (
        <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, marginTop: 10, overflow: 'hidden' }}>
          <div style={{ width: `${Math.round(job.progress * 100)}%`, height: '100%', background: job.status === 'failed' ? 'var(--danger)' : 'var(--accent)', transition: 'width .4s' }} />
        </div>
      )}
      {counters.length > 0 && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
          {counters.map(([k, v]) => (
            <span key={k} className="small">
              <strong>{v}</strong> <span className="muted">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
            </span>
          ))}
        </div>
      )}
      {job.error && <div className="alert alert-error" style={{ marginTop: 10, marginBottom: 0 }}>{job.error}</div>}
      {job.log.length > 0 && (
        <details style={{ marginTop: 10 }} open={running}>
          <summary className="small muted" style={{ cursor: 'pointer' }}>
            Log ({(job.logLineCount ?? job.log.length).toLocaleString()} line{(job.logLineCount ?? job.log.length) === 1 ? '' : 's'} total
            {job.logLineCount && job.logLineCount > job.log.length ? ` — showing the last ${job.log.length}` : ''})
          </summary>
          <div style={{ display: 'flex', gap: 10, margin: '4px 0 6px' }}>
            <button type="button" className="btn btn-sm" onClick={() => void openApiFile(api.rosterJobLogUrl(job.id))}>
              Open full log ↗
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void openApiFile(api.rosterJobLogUrl(job.id, true), { download: true, fallbackName: `${job.id}.log` })}>
              Download .log
            </button>
          </div>
          <pre className="small" style={{ margin: '6px 0 0', maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
            {job.log.map((l, i) => (
              <div key={i} style={{ color: l.level === 'error' ? 'var(--danger)' : l.level === 'warn' ? 'var(--warning, #b7791f)' : undefined }}>
                {l.message}
              </div>
            ))}
          </pre>
        </details>
      )}
    </div>
  );
}
