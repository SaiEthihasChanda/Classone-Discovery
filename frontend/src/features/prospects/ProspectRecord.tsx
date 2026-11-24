import { useEffect, useState } from 'react';
import { columnOf, FlowChip, REDO_LABEL, timeFromNow } from './flow';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import { useAuth } from '../../auth/AuthProvider';
import { Drawer, Tabs } from '../../components/ui';
import { ROLE_LABELS } from '../../components/pickers';
import { AffiliationNote, ErrorBanner, FundingList, InstrumentBadge, Loading, ScorePill, formatDate, shortInstitute } from '../../components/common';

type ProspectTab = 'overview' | 'research' | 'sources' | 'funding';

/** One roster member as a side panel with top tabs (expand → full-screen overlay). */
export function ProspectRecord({ id, mode, onClose, onChanged }: { id: string; mode: 'auto' | 'manual'; onClose: () => void; onChanged?: () => void }) {
  const { can } = useAuth();
  const [tab, setTab] = useState<ProspectTab>('overview');
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data, loading, error, reload } = useAsync(() => api.getRosterMember(id), [id]);
  const m = data?.member;

  // While this person is moving, follow them live.
  const moving = m?.flow?.state === 'queued' || m?.flow?.state === 'processing';
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => {
      reload();
      onChanged?.();
    }, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving, id]);

  async function flowAction(action: 'next' | 'redo' | 'retry') {
    setBusy(true);
    setActionError(null);
    try {
      await api.memberFlowAction(id, action);
      reload();
      onChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not update');
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(next: 'eligible' | 'excluded') {
    if (!m) return;
    let reason: string | undefined;
    if (next === 'excluded') {
      const answer = window.prompt(`Exclude ${m.person.name}? Why are they not a prospect? (optional)`, m.flow?.note ?? '');
      if (answer === null) return; // cancelled
      reason = answer || undefined;
    }
    setBusy(true);
    setActionError(null);
    try {
      await api.setRosterStatus(m.id, next, reason);
      reload();
      onChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not update');
    } finally {
      setBusy(false);
    }
  }

  if (!m) {
    return (
      <Drawer title="Prospect" expanded={expanded} onToggleExpand={() => setExpanded(!expanded)} onClose={onClose}>
        {loading ? <Loading /> : error ? <ErrorBanner message={error} /> : null}
      </Drawer>
    );
  }

  const profile = m.person.profileUrl && !/openalex\.org/i.test(m.person.profileUrl) ? m.person.profileUrl : undefined;
  const col = columnOf(m.flow?.stage);
  const flowState = m.flow?.state ?? 'idle';
  const active = m.status !== 'excluded';
  const canStep = can('sales') && active && flowState !== 'processing';

  return (
    <Drawer
      title={m.person.name}
      subtitle={
        <>
          {m.person.title ?? ROLE_LABELS[m.role.category] ?? m.role.category}
          {m.institution.name && ` · ${shortInstitute(m.institution.name)}`}{' '}
          <AffiliationNote affiliation={m.institution.affiliation} institutionName={m.institution.name} />
        </>
      }
      expanded={expanded}
      onToggleExpand={() => setExpanded(!expanded)}
      onClose={onClose}
      actions={
        <>
          <span className="badge badge-customer">{active ? col.title : 'Excluded'}</span>
          {active && <FlowChip flow={m.flow} compact />}
          <ScorePill score={m.relevance.score} />
          <span style={{ flex: 1 }} />
          {canStep && flowState === 'failed' && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void flowAction('retry')}>
              Retry {col.next?.toLowerCase()}
            </button>
          )}
          {canStep && flowState !== 'failed' && col.next && (mode === 'manual' || flowState === 'review' || m.flow?.note) && (
            <button className="btn btn-sm btn-primary" disabled={busy || flowState === 'queued'} onClick={() => void flowAction('next')} title="Run the next step for this person only">
              {flowState === 'queued' ? 'Queued…' : flowState === 'review' ? 'Continue anyway' : `Run next step: ${col.next}`}
            </button>
          )}
          {canStep && m.flow?.stage && (
            <button className="btn btn-sm" disabled={busy || flowState === 'queued'} onClick={() => void flowAction('redo')} title="Run the step that brought them here again">
              {REDO_LABEL[m.flow.stage]}
            </button>
          )}
          {m.status === 'promoted' && m.leadId && (
            <Link className="btn btn-sm btn-primary" to={`/leads?status=all&open=${m.leadId}`}>
              Open lead
            </Link>
          )}
          {can('sales') && m.status === 'eligible' && (
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void setStatus('excluded')} title="Not a prospect — take them off the conveyor (Restore brings them back)">
              Exclude
            </button>
          )}
          {can('sales') && m.status === 'excluded' && (
            <button className="btn btn-sm" disabled={busy} onClick={() => void setStatus('eligible')}>
              Restore
            </button>
          )}
        </>
      }
      tabs={
        <Tabs
          items={[
            { key: 'overview', label: 'Overview' },
            { key: 'research', label: 'Research' },
            { key: 'sources', label: 'Sources & affiliation' },
            { key: 'funding', label: 'Funding' },
          ]}
          value={tab}
          onChange={setTab}
        />
      }
    >
      {actionError && <ErrorBanner message={actionError} />}
      {active && (m.flow?.lastError || m.flow?.note) && (
        <div className={`alert ${flowState === 'failed' ? 'alert-error' : 'alert-info'}`} style={{ marginBottom: 18 }}>
          {flowState === 'failed' ? `${col.next ?? 'Step'} failed after ${m.flow?.attempts ?? 0} tries: ${m.flow?.lastError}` : m.flow?.lastError && flowState === 'queued' ? `Last try failed (${m.flow.lastError}) — retrying ${m.flow.nextAttemptAt ? timeFromNow(m.flow.nextAttemptAt) : 'soon'}.` : m.flow?.note}
        </div>
      )}

      {tab === 'overview' && (
        <div style={{ display: 'grid', gap: 28 }}>
          <section>
            <h3 className="section-title">Contact</h3>
            <dl className="kv">
              <dt>Email</dt>
              <dd>{m.person.email ? <a href={`mailto:${m.person.email}`}>{m.person.email}</a> : <span className="muted">—</span>}</dd>
              <dt>Phone</dt>
              <dd>{m.person.phone ?? <span className="muted">—</span>}</dd>
              <dt>Department</dt>
              <dd>{m.department.name ?? <span className="muted">—</span>}</dd>
              <dt>Institute</dt>
              <dd>{m.institution.name ?? <span className="muted">unknown</span>}</dd>
              <dt>Links</dt>
              <dd style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {profile && <a href={profile} target="_blank" rel="noreferrer">Profile</a>}
                {m.person.websiteUrl && <a href={m.person.websiteUrl} target="_blank" rel="noreferrer">Lab website</a>}
                {m.person.orcid && <a href={`https://orcid.org/${m.person.orcid}`} target="_blank" rel="noreferrer">ORCID</a>}
                {m.person.openAlexAuthorId && <a href={`https://openalex.org/${m.person.openAlexAuthorId}`} target="_blank" rel="noreferrer">OpenAlex</a>}
              </dd>
            </dl>
          </section>
          <section>
            <h3 className="section-title">Fit</h3>
            {m.relevance.reasoning ? <p style={{ margin: 0 }}>{m.relevance.reasoning}</p> : <p className="muted" style={{ margin: 0 }}>Not scored yet.</p>}
            {m.research.instruments.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
                {m.research.instruments.slice(0, 6).map((i, idx) => (
                  <span key={idx} style={{ opacity: i.needsReview ? 0.5 : 1 }} title={i.evidence}>
                    <InstrumentBadge vendor={i.vendor} brand={i.brand} model={i.model} />
                  </span>
                ))}
              </div>
            )}
            {(m.research.applicationAreas ?? []).length > 0 && (
              <div style={{ marginTop: 12 }}>
                {m.research.applicationAreas!.map((a) => (
                  <span key={a} className="tag">
                    {a}
                  </span>
                ))}
              </div>
            )}
          </section>
          {m.tags.length > 0 && (
            <section>
              <h3 className="section-title">Tags</h3>
              {m.tags.map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
            </section>
          )}
        </div>
      )}

      {tab === 'research' && (
        <div style={{ display: 'grid', gap: 24 }}>
          {m.research.worksCount !== undefined && (
            <p className="muted" style={{ margin: 0 }}>
              {m.research.worksCount} works · h-index {m.research.hIndex ?? '?'} · publishing {m.research.firstPublicationYear ?? '?'}–{m.research.lastPublicationYear ?? '?'}
            </p>
          )}
          {m.research.topics.length > 0 && (
            <section>
              <h3 className="section-title">Topics</h3>
              {m.research.topics.map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
            </section>
          )}
          <section>
            <h3 className="section-title">Recent publications</h3>
            {m.research.recentPublications.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>None on record.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
                {m.research.recentPublications.map((p, i) => (
                  <li key={i}>
                    {p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.title}</a> : p.title}
                    {p.year ? <span className="muted"> ({p.year})</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {tab === 'sources' && (
        <div style={{ display: 'grid', gap: 24 }}>
          <section>
            <h3 className="section-title">Where we found them</h3>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
              {m.sources.map((s, i) => (
                <li key={i}>
                  <strong style={{ textTransform: 'capitalize' }}>{s.type.replace(/_/g, ' ')}</strong>
                  {s.title ? ` — ${s.title}` : ''}
                  {s.department ? `, ${s.department}` : ''}{' '}
                  {s.url && <a href={s.url} target="_blank" rel="noreferrer">open</a>}
                </li>
              ))}
            </ul>
            {m.role.basis && <p className="muted small">Role basis: {m.role.basis}</p>}
            {m.exclusionReason && <p className="muted small">Excluded: {m.exclusionReason}</p>}
          </section>
          <section>
            <h3 className="section-title">Affiliation</h3>
            {m.institution.affiliation ? (
              <>
                <p style={{ margin: 0 }}>
                  <strong style={{ textTransform: 'capitalize' }}>{m.institution.affiliation.status}</strong> via {m.institution.affiliation.source}, {formatDate(m.institution.affiliation.verifiedAt)}
                  {m.institution.affiliation.previousInstitution && <> · previously {m.institution.affiliation.previousInstitution}</>}
                </p>
                {m.institution.affiliation.note && <p className="muted small">{m.institution.affiliation.note}</p>}
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {(m.institution.affiliation.evidence ?? []).map((e, i) => (
                    <li key={i}>
                      <strong>{e.source}</strong>: {e.institution ?? <span className="muted">{e.detail ?? 'nothing'}</span>}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="muted" style={{ margin: 0 }}>Not yet verified. Discovered at {m.institution.discoveredName}.</p>
            )}
          </section>
        </div>
      )}

      {tab === 'funding' && <FundingList funding={m.research.funding} checkedAt={m.research.fundingCheckedAt} />}
    </Drawer>
  );
}
