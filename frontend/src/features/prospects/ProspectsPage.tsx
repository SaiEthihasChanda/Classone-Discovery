/**
 * Prospects — every researcher found at the target institutes, on a conveyor:
 * Found → Verified → Scored → Filling info → In Leads. Each person moves on
 * their own; in Auto the system moves them, in Manual each step waits for a
 * person (per record, or "run all waiting" per column). Live: the board polls
 * the conveyor state every 3 s.
 */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type RosterListParams } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import { useAuth } from '../../auth/AuthProvider';
import { InstrumentBadge, ScorePill, shortInstitute } from '../../components/common';
import { Icon, Modal, Segmented, Tabs } from '../../components/ui';
import { MultiSelect } from '../../components/pickers';
import { AnimatePresence, cardMotion, motion } from '../../components/motion';
import type { FacultyMember, FlowStage, PipelineState, RosterConfig, RosterJob } from '../../types';
import { ProspectRecord } from './ProspectRecord';
import { PipelineTrigger } from './PipelineTrigger';
import { RunHistory } from './RunHistory';
import { StageView } from './StageView';
import { COLUMNS, columnOf, FlowChip, type BoardStage } from './flow';

const PAGE = 30;

function Column({
  col,
  filters,
  version,
  counts,
  mode,
  selectedId,
  canRun,
  onOpen,
  onView,
  onTrigger,
  onRunAll,
}: {
  col: { board: BoardStage | 'excluded'; stage?: FlowStage; title: string; next?: string; hint: string };
  filters: RosterListParams;
  version: number;
  counts?: PipelineState['stages'][FlowStage];
  mode: 'auto' | 'manual';
  selectedId: string | null;
  canRun: boolean;
  onOpen: (id: string) => void;
  onView?: () => void;
  onTrigger?: () => void;
  onRunAll?: () => void;
}) {
  const [limit, setLimit] = useState(PAGE);
  const key = JSON.stringify(filters);
  useEffect(() => setLimit(PAGE), [key]);
  const { data, loading } = useAsync(() => api.listRoster({ ...filters, stage: col.board, limit, sort: 'score' }), [key, limit, version]);

  // In Auto everyone waiting is in the queue; in Manual only those a person asked for.
  const queued = (counts?.queued ?? 0) + (mode === 'auto' && col.next ? (counts?.idle ?? 0) : 0);
  const live = counts ? [counts.processing && `${counts.processing} in progress`, queued > 0 && `${queued.toLocaleString()} queued`, (counts.review ?? 0) + (counts.failed ?? 0) > 0 && `${(counts.review ?? 0) + (counts.failed ?? 0)} need you`].filter(Boolean) : [];
  const waiting = counts?.idle ?? 0;

  return (
    <section className="board-col">
      <div className="board-col-head">
        <strong>{col.title}</strong>
        <span className="count">{data ? data.total.toLocaleString() : '…'}</span>
        <span className="col-actions">
          {canRun && onTrigger && (
            <button className="btn btn-sm btn-ghost" onClick={onTrigger} title="Find people — now or on a schedule">
              <Icon name="plus" size={14} /> Trigger
            </button>
          )}
          {onView && (
            <button className="btn btn-sm btn-ghost" onClick={onView} title="Who is queued and in progress here">
              View stage
            </button>
          )}
        </span>
      </div>
      {(live.length > 0 || (canRun && mode === 'manual' && waiting > 0 && col.next)) && (
        <div className="board-col-sub" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {live.length > 0 && <span>{live.join(' · ')}</span>}
          {canRun && mode === 'manual' && waiting > 0 && col.next && onRunAll && (
            <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={onRunAll} title={col.hint}>
              {col.next} all {waiting.toLocaleString()}
            </button>
          )}
        </div>
      )}
      <div className="board-cards">
        <AnimatePresence mode="popLayout" initial={false}>
        {data?.items.map((m: FacultyMember) => (
          <motion.button key={m.id} {...cardMotion} className={`board-card${selectedId === m.id ? ' selected' : ''}`} onClick={() => onOpen(m.id)}>
            <div className="name">
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.person.name}</span>
              <span className="score">
                <ScorePill score={m.relevance.score} />
              </span>
            </div>
            <div className="meta">
              {m.institution.name ? shortInstitute(m.institution.name) : 'Institute unknown'}
              {m.department.name ? ` · ${m.department.name.replace(/^(Department|School) of /i, '')}` : ''}
            </div>
            {(m.research.instruments.length > 0 || (m.flow?.state && m.flow.state !== 'idle')) && (
              <div className="chips">
                {col.board !== 'excluded' && <FlowChip flow={m.flow} compact />}
                {m.research.instruments.slice(0, 2).map((i, idx) => (
                  <InstrumentBadge key={idx} vendor={i.vendor} brand={i.brand} />
                ))}
              </div>
            )}
          </motion.button>
        ))}
        </AnimatePresence>
        {data && data.items.length === 0 && <p className="muted small" style={{ textAlign: 'center', margin: '16px 0' }}>Nobody here.</p>}
        {data && data.items.length < data.total && (
          <button className="btn btn-sm btn-ghost" disabled={loading} onClick={() => setLimit(limit + PAGE)}>
            {loading ? 'Loading…' : `Show more (${(data.total - data.items.length).toLocaleString()})`}
          </button>
        )}
      </div>
    </section>
  );
}

/** Confirm before Auto: it sets the whole waiting backlog moving. */
function AutoConfirm({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const { data } = useAsync(() => api.pipelineAutoPreview(), []);
  return (
    <Modal onClose={onCancel}>
      <h2>Switch to Auto?</h2>
      <p className="muted">Everyone waiting starts moving through the stages on their own, and new people move as soon as they are found.</p>
      {data ? (
        <ul style={{ display: 'grid', gap: 6, paddingLeft: 20 }}>
          <li>
            <strong>{(data.waiting.verify + data.waiting.score).toLocaleString()}</strong> people will be verified and scored — about {data.estimatedScoringCredits.toLocaleString()} OpenAlex credits, spread over days by the daily cap.
          </li>
          <li>
            <strong>{data.belowThreshold.toLocaleString()}</strong> already-scored people below {data.threshold} will be <strong>excluded</strong> (you can restore them).
          </li>
          <li>
            <strong>{(data.waiting.promote - data.belowThreshold + data.waiting.fill).toLocaleString()}</strong> will move on towards Leads → To review.
          </li>
        </ul>
      ) : (
        <p className="muted">Counting…</p>
      )}
      <div className="modal-foot">
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!data} onClick={onConfirm}>
          Switch to Auto
        </button>
      </div>
    </Modal>
  );
}

export function ProspectsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const view = (params.get('view') as 'board' | 'history' | null) ?? 'board';
  const stageParam = params.get('stage') as FlowStage | null;

  const { data: config } = useAsync(() => api.rosterConfig(), []);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [institutionId, setInstitutionId] = useState<string[]>([]);
  const [domain, setDomain] = useState<string[]>([]);
  const [minScore, setMinScore] = useState(0);
  const [showExcluded, setShowExcluded] = useState(false);
  const [trigger, setTrigger] = useState(false);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<PipelineState | null>(null);
  const [builds, setBuilds] = useState<RosterJob[]>([]);
  const signature = useRef('');

  const setQuery = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v === null ? next.delete(k) : next.set(k, v));
    setParams(next, { replace: true });
  };

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Live: conveyor counts every 3 s; the columns reload whenever they change.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [s, jobs] = await Promise.all([api.pipelineState(), api.rosterJobs('roster_build')]);
        if (!alive) return;
        setState(s);
        const running = jobs.jobs.filter((j) => j.status === 'running');
        setBuilds(running);
        const sig = JSON.stringify([s.stages, s.excluded, running.map((j) => j.counters)]);
        if (sig !== signature.current) {
          signature.current = sig;
          setVersion((v) => v + 1);
        }
      } catch {
        // keep the last state; the next poll retries
      }
    };
    void load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const mode = state?.settings.mode ?? 'manual';

  async function setMode(next: 'auto' | 'manual') {
    setConfirmAuto(false);
    const r = await api.updatePipelineSettings({ mode: next });
    setState((s) => (s ? { ...s, settings: r.settings } : s));
  }

  async function runAll(stage: FlowStage) {
    if (stage === 'done') return;
    await api.runPipelineStage(stage);
    setVersion((v) => v + 1);
  }

  const filters: RosterListParams = {
    q: debouncedQ || undefined,
    institutionId: institutionId.length ? institutionId.join(',') : undefined,
    domain: domain.length ? domain.join(',') : undefined,
    minScore: minScore > 0 ? minScore : undefined,
  };

  const caps = state?.caps;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Prospects</h1>
          <p>Researchers at the target institutes, each moving from found to lead on their own.</p>
        </div>
        <div className="page-actions mode-switch">
          {can('sales') && state && (
            <Segmented
              items={[
                { key: 'manual', label: 'Manual' },
                { key: 'auto', label: 'Auto' },
              ]}
              value={mode}
              onChange={(k) => (k === 'auto' ? setConfirmAuto(true) : void setMode('manual'))}
            />
          )}
          {can('sales') && config && (
            <button className="btn btn-primary" onClick={() => setTrigger(true)}>
              <Icon name="plus" size={16} /> Pipeline trigger
            </button>
          )}
        </div>
      </div>

      {caps && (
        <div className="cap-line">
          <span>{mode === 'auto' ? 'Auto: people move through every stage on their own.' : 'Manual: each step waits for you.'}</span>
          <span className={caps.openAlex.paused ? 'paused' : undefined}>
            Scoring today: {caps.openAlex.usedToday === null ? '—' : caps.openAlex.usedToday.toLocaleString()} / {caps.openAlex.cap.toLocaleString()} OpenAlex credits{caps.openAlex.paused ? ' — paused until tomorrow' : ''}
          </span>
          {caps.gemini.keySet && (
            <span className={caps.gemini.paused ? 'paused' : undefined}>
              Gemini searches: {caps.gemini.usedToday} / {caps.gemini.cap}
              {caps.gemini.paused ? ' — free sources only until tomorrow' : ''}
            </span>
          )}
          {Object.entries(state?.paused ?? {}).map(([stage, p]) => (
            <span key={stage} className="paused" title={p!.reason}>
              {columnOf(stage as FlowStage).next ?? stage} paused — {/gemini/i.test(p!.reason) ? 'Gemini is busy' : 'service busy'}, retrying at {new Date(p!.until).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          ))}
          {builds.map((b) => (
            <span key={b.id}>
              Finding people… {b.counters.created ?? 0} new{' '}
              {can('sales') && (
                <button className="btn btn-sm btn-ghost" style={{ padding: '0 6px' }} onClick={() => void api.cancelRosterJob(b.id)}>
                  Stop
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <Tabs
        items={[
          { key: 'board', label: 'Board' },
          { key: 'history', label: 'Runs & schedules' },
        ]}
        value={view}
        onChange={(k) => setQuery({ view: k === 'board' ? null : k })}
      />

      {view === 'history' && config && <RunHistory config={config as RosterConfig} mode={mode} />}

      {view === 'board' && (
        <>
          <div className="toolbar">
            <input className="search" placeholder="Search name, department, topic" value={q} onChange={(e) => setQ(e.target.value)} />
            <MultiSelect
              label="Institutes"
              searchable
              options={(config?.institutions ?? []).map((i) => ({ value: i.id, label: shortInstitute(i.name) }))}
              selected={institutionId}
              onChange={setInstitutionId}
            />
            <MultiSelect label="Departments" options={Object.entries(config?.domains ?? {}).map(([k, v]) => ({ value: k, label: v }))} selected={domain} onChange={setDomain} />
            <select value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} style={{ minWidth: 140 }}>
              <option value={0}>Any score</option>
              <option value={40}>Score 40+</option>
              <option value={60}>Score 60+</option>
              <option value={70}>Score 70+</option>
            </select>
            <label className="checkbox-row" style={{ margin: 0 }}>
              <input type="checkbox" checked={showExcluded} onChange={(e) => setShowExcluded(e.target.checked)} />
              Show excluded{state ? ` (${state.excluded.toLocaleString()})` : ''}
            </label>
          </div>

          {showExcluded ? (
            <div className="board" style={{ gridTemplateColumns: 'minmax(270px, 420px)' }}>
              <Column col={{ board: 'excluded', title: 'Excluded', hint: 'Not prospects' }} filters={filters} version={version} mode={mode} selectedId={openId} canRun={false} onOpen={(id) => setQuery({ open: id })} />
            </div>
          ) : (
            <div className="board five">
              {COLUMNS.map((col) => (
                <Column
                  key={col.board}
                  col={col}
                  filters={filters}
                  version={version}
                  counts={state?.stages[col.stage]}
                  mode={mode}
                  selectedId={openId}
                  canRun={can('sales')}
                  onOpen={(id) => setQuery({ open: id })}
                  onView={() => setQuery({ stage: col.stage })}
                  onTrigger={col.board === 'found' ? () => setTrigger(true) : undefined}
                  onRunAll={() => void runAll(col.stage)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {stageParam && <StageView stage={stageParam} mode={mode} onClose={() => setQuery({ stage: null })} onOpen={(id) => setQuery({ open: id })} />}
      {openId && <ProspectRecord id={openId} mode={mode} onClose={() => setQuery({ open: null })} onChanged={() => setVersion((v) => v + 1)} />}
      {trigger && config && <PipelineTrigger config={config as RosterConfig} mode={mode} onClose={() => setTrigger(false)} onStarted={() => setVersion((v) => v + 1)} />}
      {confirmAuto && <AutoConfirm onCancel={() => setConfirmAuto(false)} onConfirm={() => void setMode('auto')} />}
    </>
  );
}
