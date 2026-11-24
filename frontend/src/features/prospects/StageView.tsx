/**
 * View stage — one column of the conveyor, full screen and live: who is being
 * processed right now (and for how long), who is queued (in the order they'll
 * be picked up, with retry times), and who needs a person (review / failed).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { ErrorBanner, Loading, ScorePill, shortInstitute } from '../../components/common';
import { Drawer } from '../../components/ui';
import { AnimatePresence, cardMotion, motion } from '../../components/motion';
import type { FlowStage, StageMember, StageView as StageViewData } from '../../types';
import { columnOf, FlowChip, timeSince } from './flow';

export function StageView({ stage, mode, onClose, onOpen }: { stage: FlowStage; mode: 'auto' | 'manual'; onClose: () => void; onOpen: (id: string) => void }) {
  const { can } = useAuth();
  const col = columnOf(stage);
  const [data, setData] = useState<StageViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [, setNow] = useState(0);

  const load = () =>
    api
      .pipelineStage(stage)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load'));

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      void load();
      setNow((n) => n + 1);
    }, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  async function act(id: string, action: 'next' | 'retry') {
    setBusy(id);
    try {
      await api.memberFlowAction(id, action);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update');
    } finally {
      setBusy(null);
    }
  }

  async function runAll() {
    if (stage === 'done') return;
    setBusy('all');
    try {
      await api.runPipelineStage(stage);
      await load();
    } finally {
      setBusy(null);
    }
  }

  const item = (m: StageMember, extra: ReactNode, actions?: ReactNode) => (
    <motion.div key={m.id} {...cardMotion} className="stage-item">
      <div className="row">
        <button className="link-btn" style={{ fontWeight: 600, padding: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', font: 'inherit', textAlign: 'left', minWidth: 0 }} onClick={() => onOpen(m.id)}>
          <strong>{m.person.name}</strong>
        </button>
        <ScorePill score={m.relevance?.score} />
      </div>
      <div className="muted">{m.institution?.name ? shortInstitute(m.institution.name) : 'Institute unknown'}</div>
      <div className="row">
        {extra}
        {actions}
      </div>
    </motion.div>
  );

  return (
    <Drawer
      title={`${col.title} — ${col.next ? `waiting to ${col.next.toLowerCase()}` : 'done'}`}
      subtitle={<>{col.hint}. Updates live.</>}
      expanded={expanded}
      onToggleExpand={() => setExpanded(!expanded)}
      onClose={onClose}
      actions={
        data && (
          <>
            <span className="muted small">
              {mode === 'auto' || stage === 'done' ? 'Auto — everyone here is picked up in turn.' : `${data.idleCount.toLocaleString()} waiting for a person`}
            </span>
            <span style={{ flex: 1 }} />
            {can('sales') && mode === 'manual' && stage !== 'done' && data.idleCount > 0 && (
              <button className="btn btn-sm btn-primary" disabled={busy === 'all'} onClick={() => void runAll()}>
                {col.next} all {data.idleCount.toLocaleString()} waiting
              </button>
            )}
          </>
        )
      }
    >
      {error && <ErrorBanner message={error} />}
      {!data && !error && <Loading />}
      {data && (
        <div className="stage-view">
          <section className="stage-list">
            <h3>
              In progress <span className="muted small">{data.processing.length}</span>
            </h3>
            <AnimatePresence mode="popLayout" initial={false}>{data.processing.map((m) => item(m, <span className="muted small">{col.next ?? 'Working'} · {timeSince(m.flow?.startedAt)}</span>, <FlowChip flow={m.flow} />))}</AnimatePresence>
            {data.processing.length === 0 && <p className="muted small" style={{ margin: 4 }}>Nobody right now.</p>}
          </section>
          <section className="stage-list">
            <h3>
              Queued <span className="muted small">{data.queuedTotal.toLocaleString()}{data.queuedTotal > data.queued.length ? ` · next ${data.queued.length} shown` : ''}</span>
            </h3>
            <AnimatePresence mode="popLayout" initial={false}>{data.queued.map((m, i) =>
              item(
                m,
                <span className="muted small">
                  #{i + 1}
                  {m.flow?.attempts ? ` · attempt ${m.flow.attempts + 1}` : ''}
                </span>,
                <FlowChip flow={m.flow?.state === 'idle' ? { ...m.flow, state: 'queued' } : m.flow} />,
              ),
            )}</AnimatePresence>
            {data.queued.length === 0 && <p className="muted small" style={{ margin: 4 }}>{mode === 'auto' ? 'Nothing waiting — people are picked up as they arrive.' : 'Nothing queued.'}</p>}
          </section>
          <section className="stage-list">
            <h3>
              Needs a person <span className="muted small">{data.review.length + data.failed.length}</span>
            </h3>
            <AnimatePresence mode="popLayout" initial={false}>{[...data.failed, ...data.review].map((m) =>
              item(
                m,
                <span className="small" style={{ color: m.flow?.state === 'failed' ? 'var(--danger)' : 'var(--warning)', minWidth: 0 }}>
                  {m.flow?.state === 'failed' ? m.flow?.lastError ?? 'Failed' : m.flow?.note ?? 'Needs review'}
                </span>,
                can('sales') && (
                  <button className="btn btn-sm" disabled={busy === m.id} onClick={() => void act(m.id, m.flow?.state === 'failed' ? 'retry' : 'next')}>
                    {m.flow?.state === 'failed' ? 'Retry' : 'Continue anyway'}
                  </button>
                ),
              ),
            )}</AnimatePresence>
            {data.review.length + data.failed.length === 0 && <p className="muted small" style={{ margin: 4 }}>All clear.</p>}
          </section>
        </div>
      )}
    </Drawer>
  );
}
