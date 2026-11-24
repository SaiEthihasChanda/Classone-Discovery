/**
 * Runs & schedules — every conveyor run (who it found, how many reached Leads,
 * how many still moving or needing a person) with one overall log per run,
 * and the scheduled runs, editable in place.
 */
import { useEffect, useState } from 'react';
import { api, openApiFile } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState, ErrorBanner, Loading, formatDate, shortInstitute } from '../../components/common';
import { Modal } from '../../components/ui';
import type { FlowRun, PipelineSchedule, RosterConfig } from '../../types';
import { describeSchedule } from './flow';
import { PipelineTrigger } from './PipelineTrigger';

function duration(startedAt: string, finishedAt?: string): string {
  const ms = (finishedAt ? new Date(finishedAt).getTime() : Date.now()) - new Date(startedAt).getTime();
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return '<1 min';
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** The run's one overall log, live while the run is moving, filterable by level and paged. */
function RunLog({ run, onClose }: { run: FlowRun; onClose: () => void }) {
  const [levels, setLevels] = useState<Array<'info' | 'warn' | 'error'>>(['info', 'warn', 'error']);
  const [page, setPage] = useState(1);
  const [tick, setTick] = useState(0);
  const limit = 300;
  const { data, loading, error } = useAsync(() => api.rosterRunLog(run._id, { level: levels.join(','), page, limit }), [run._id, levels.join(','), page, tick]);
  const totalPages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1;
  useEffect(() => {
    if (!run.flowing) return;
    const t = setInterval(() => setTick((n) => n + 1), 4000);
    return () => clearInterval(t);
  }, [run.flowing]);

  return (
    <Modal onClose={onClose}>
      <h2>Logs — {run.options?.label ?? 'Run'}</h2>
      <p className="muted small" style={{ margin: '0 0 14px' }}>
        Started {formatDate(run.startedAt)}
        {run.flowing ? ' · still moving, updates live' : ''}
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        {(['info', 'warn', 'error'] as const).map((l) => (
          <label key={l} className="checkbox-row" style={{ margin: 0 }}>
            <input
              type="checkbox"
              checked={levels.includes(l)}
              onChange={() => {
                setPage(1);
                setLevels((prev) => (prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l]));
              }}
            />
            {{ info: 'Info', warn: 'Warnings', error: 'Errors' }[l]}
          </label>
        ))}
        {data && <span className="muted small">{data.total.toLocaleString()} lines</span>}
        <span style={{ flex: 1 }} />
        <button className="btn btn-sm" onClick={() => void openApiFile(api.rosterRunLogUrl(run._id, true), { download: true, fallbackName: `${run._id}.log` })}>
          Download
        </button>
      </div>
      {error && <ErrorBanner message={error} />}
      {loading && !data && <Loading label="Loading log…" />}
      {data && (
        <pre className="small" style={{ margin: 0, height: '52vh', overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)', fontSize: 12, background: 'var(--surface-alt)', padding: 12, borderRadius: 10 }}>
          {data.items.map((l, i) => (
            <div key={`${l.seq}-${i}`} style={{ color: l.level === 'error' ? 'var(--danger)' : l.level === 'warn' ? 'var(--warning)' : undefined }}>
              {new Date(l.at).toLocaleTimeString('en-IN')} {l.message}
            </div>
          ))}
          {data.items.length === 0 && <span className="muted">Nothing logged yet.</span>}
        </pre>
      )}
      {data && totalPages > 1 && (
        <div className="pagination" style={{ marginTop: 8 }}>
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ← Previous
          </button>
          <span className="small muted">
            Page {page} of {totalPages}
          </span>
          <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
            Next →
          </button>
        </div>
      )}
      <div className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

function statusOf(run: FlowRun): { label: string; badge: string } {
  if (run.status === 'running') return { label: 'Finding people', badge: 'badge-pending' };
  if (run.status === 'failed') return { label: 'Failed', badge: 'badge-rejected' };
  if (run.status === 'cancelled' && !run.flowing) return { label: 'Stopped', badge: 'badge-neutral' };
  if (run.flowing) return { label: 'Moving', badge: 'badge-pending' };
  return { label: 'Done', badge: 'badge-approved' };
}

function Schedules({ config, mode }: { config: RosterConfig; mode: 'auto' | 'manual' }) {
  const { can } = useAuth();
  const { data, error, reload } = useAsync(() => api.pipelineSchedules(), []);
  const [editing, setEditing] = useState<PipelineSchedule | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Live: next/last run, "started late" and errors change on the server as schedules fire.
  useEffect(() => {
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload]);

  async function toggle(s: PipelineSchedule) {
    setBusy(s.id);
    try {
      const { id: _id, ...rest } = s;
      await api.updatePipelineSchedule(s.id, { ...rest, enabled: !s.enabled });
      reload();
    } finally {
      setBusy(null);
    }
  }
  async function remove(s: PipelineSchedule) {
    if (!window.confirm(`Delete the scheduled run "${s.name}"?`)) return;
    setBusy(s.id);
    try {
      await api.deletePipelineSchedule(s.id);
      reload();
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorBanner message={error} />;
  if (!data) return <Loading />;
  return (
    <section style={{ marginBottom: 28 }}>
      <h3 className="section-title">Scheduled runs</h3>
      {data.items.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>None. Use Pipeline trigger → When to schedule one.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>When</th>
                <th>Next run</th>
                <th>Last run</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((s) => (
                <tr key={s.id} style={{ opacity: s.enabled ? 1 : 0.55 }}>
                  <td>
                    <strong>{s.name}</strong>
                    <div className="muted small">{s.config.institutionIds.length} institute{s.config.institutionIds.length === 1 ? '' : 's'}</div>
                  </td>
                  <td className="small">{describeSchedule(s)}</td>
                  <td className="small">{s.enabled && s.nextRunAt ? formatDate(s.nextRunAt) : <span className="muted">{s.type === 'once' && s.lastRunAt ? 'Done' : 'Off'}</span>}</td>
                  <td className="small">
                    {s.lastRunAt ? formatDate(s.lastRunAt) : <span className="muted">—</span>}
                    {s.lastRunLate && <div style={{ color: 'var(--warning)' }}>Started late</div>}
                    {s.lastError && <div style={{ color: 'var(--warning)' }}>{s.lastError}</div>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {can('sales') && (
                      <>
                        <button className="btn btn-sm btn-ghost" onClick={() => setEditing(s)}>
                          Edit
                        </button>
                        <button className="btn btn-sm btn-ghost" disabled={busy === s.id} onClick={() => void toggle(s)}>
                          {s.enabled ? 'Pause' : 'Resume'}
                        </button>
                      </>
                    )}
                    {can('admin') && (
                      <button className="btn btn-sm btn-ghost" disabled={busy === s.id} onClick={() => void remove(s)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <PipelineTrigger config={config} mode={mode} editing={editing} onClose={() => setEditing(null)} onStarted={reload} />}
    </section>
  );
}

export function RunHistory({ config, mode }: { config: RosterConfig; mode: 'auto' | 'manual' }) {
  const [tick, setTick] = useState(0);
  const { data, loading, error } = useAsync(() => api.flowRuns(), [tick]);
  const [logOf, setLogOf] = useState<FlowRun | null>(null);
  const instituteNames = new Map(config.institutions.map((i) => [i.id, i.name] as const));

  // Live: counts move while runs flow, and a schedule can start a new run at any moment.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const institutes = (run: FlowRun) => {
    const ids = run.options?.institutionIds ?? [];
    if (!ids.length) return run._id === 'flow-backlog' ? 'People already on the roster' : '—';
    return ids.slice(0, 3).map((id) => shortInstitute(instituteNames.get(id) ?? id)).join(', ') + (ids.length > 3 ? ` +${ids.length - 3}` : '');
  };

  return (
    <>
      <Schedules config={config} mode={mode} />

      <h3 className="section-title">Runs</h3>
      {error && <ErrorBanner message={error} />}
      {loading && !data && <Loading />}
      {data && data.items.length === 0 && <EmptyState>No runs yet — start one with Pipeline trigger.</EmptyState>}
      {data && data.items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                <th>People</th>
                <th>Started</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((run) => {
                const st = statusOf(run);
                return (
                  <tr key={run._id}>
                    <td>
                      <strong>{run.options?.label ?? (run._id === 'flow-backlog' ? 'Existing roster' : 'Run')}</strong>
                      <div className="muted small">
                        {institutes(run)}
                        {run.options?.triggeredBy?.startsWith('schedule:') && ' · scheduled'}
                        {run.options?.late && <span style={{ color: 'var(--warning)' }}> · started late</span>}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${st.badge}`}>{st.label}</span>
                    </td>
                    <td className="small">
                      {run.people.total.toLocaleString()} found · <strong>{run.people.inLeads.toLocaleString()}</strong> in Leads · {run.people.excluded.toLocaleString()} excluded
                      {run.people.moving > 0 && <> · {run.people.moving} moving</>}
                      {run.people.attention > 0 && <span style={{ color: 'var(--warning)' }}> · {run.people.attention} need you</span>}
                    </td>
                    <td className="small">
                      {formatDate(run.startedAt)}
                      <div className="muted">{run.status === 'running' ? `finding for ${duration(run.startedAt)}` : run.finishedAt ? `found in ${duration(run.startedAt, run.finishedAt)}` : ''}</div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-sm" onClick={() => setLogOf(run)}>
                        Logs
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {logOf && <RunLog run={logOf} onClose={() => setLogOf(null)} />}
    </>
  );
}
