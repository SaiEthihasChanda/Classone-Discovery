import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import {
  EmptyState,
  ErrorBanner,
  InstrumentBadge,
  Loading,
  ScorePill,
  SourceBadge,
} from '../../components/common';

/**
 * The human approve/reject gate.
 *
 * The proposal's key control: AI scores and enriches, but a person decides. This
 * is what stops a false positive reaching a real researcher's inbox.
 *
 * Sorted by score descending so the best leads get judged while attention is
 * freshest, and the tail can be bulk-rejected.
 */
export function ReviewQueuePage() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [minScore, setMinScore] = useState<number>(0);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNote, setBulkNote] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsync(
    () =>
      api.listLeads({
        status: 'pending_review',
        sortBy: 'score',
        sortDir: 'desc',
        // The best 200 by score; "approve all" acts on every match, not this page.
        limit: 200,
        ...(minScore > 0 ? { minScore } : {}),
      }),
    [minScore],
  );

  /**
   * Approves every pending lead matching the current score filter — not just
   * the page that is loaded. The confirm names the exact count, because this is
   * the one action here that moves many leads towards real outreach at once.
   */
  async function approveAll() {
    if (!data) return;
    const scope = minScore > 0 ? `scoring ${minScore} or above` : 'awaiting review';
    if (
      !window.confirm(
        `Approve all ${data.total} lead${data.total === 1 ? '' : 's'} ${scope}?\n\n` +
          'Approved leads become eligible for outreach. This cannot be undone in bulk.',
      )
    ) {
      return;
    }

    setBulkBusy(true);
    setActionError(null);
    setBulkNote(null);
    try {
      const result = await api.bulkReview({
        decision: 'approved',
        ...(minScore > 0 ? { minScore } : {}),
      });
      setBulkNote(`Approved ${result.updated} lead${result.updated === 1 ? '' : 's'}.`);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Bulk approval failed');
    } finally {
      setBulkBusy(false);
    }
  }

  async function decide(id: string, decision: 'approved' | 'rejected') {
    let reason: string | undefined;
    if (decision === 'rejected') {
      reason = window.prompt('Reason for rejecting? (optional)') ?? undefined;
    }

    setBusyId(id);
    setActionError(null);
    try {
      await api.reviewLead(id, decision, reason);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not record the decision');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Review Queue</h1>
          <p>
            AI-scored leads awaiting a human decision. Nothing reaches outreach until it is
            approved here.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={reload}>
            Refresh
          </button>
          <button
            className="btn btn-success btn-sm"
            onClick={approveAll}
            disabled={bulkBusy || !data || data.total === 0}
            title={minScore > 0 ? `Approve every pending lead scoring ${minScore}+` : 'Approve every pending lead'}
          >
            {bulkBusy
              ? 'Approving…'
              : `Approve all${data ? ` (${data.total})` : ''}${minScore > 0 ? ` scoring ${minScore}+` : ''}`}
          </button>
        </div>
      </div>

      <div className="toolbar">
        <select value={minScore} onChange={(e) => setMinScore(Number(e.target.value))}>
          <option value={0}>All scores</option>
          <option value={40}>Score 40+</option>
          <option value={60}>Score 60+</option>
          <option value={70}>Score 70+ (strong)</option>
        </select>
        {data && (
          <span className="muted small" style={{ marginLeft: 'auto' }}>
            {data.total} awaiting review
            {data.total > data.items.length && ` · showing the top ${data.items.length} by score`}
          </span>
        )}
      </div>

      {bulkNote && <div className="alert alert-success">{bulkNote}</div>}
      {actionError && <ErrorBanner message={actionError} />}
      {error && <ErrorBanner message={error} />}
      {loading && !data && <Loading />}

      {data && data.items.length === 0 && (
        <EmptyState>
          {minScore > 0 ? (
            <>No pending leads score {minScore} or above.</>
          ) : (
            <>
              Nothing to review. Run discovery from the{' '}
              <Link to="/discovery">Discovery</Link> page to find leads.
            </>
          )}
        </EmptyState>
      )}

      {data?.items.map((lead) => (
        <div key={lead.id} className="card card-pad" style={{ marginBottom: 12 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 16,
              alignItems: 'flex-start',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ flex: '1 1 420px', minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <ScorePill score={lead.aiScoring.relevanceScore} />
                <Link to={`/leads/${lead.id}`}>
                  <strong>{lead.person.name}</strong>
                </Link>
                <SourceBadge source={lead.source.type} />
                {(lead.research.instruments ?? []).slice(0, 2).map((inst, i) => (
                  <InstrumentBadge
                    key={`${inst.brandKey}-${i}`}
                    vendor={inst.vendor}
                    brand={inst.brand}
                    model={inst.model}
                  />
                ))}
              </div>

              <div className="muted small" style={{ marginTop: 4 }}>
                {[lead.person.title, lead.institution.name, lead.person.email]
                  .filter(Boolean)
                  .join(' · ') || 'No contact details yet'}
              </div>

              {lead.research.summary && (
                <p style={{ margin: '10px 0 0', fontSize: 13 }}>{lead.research.summary}</p>
              )}

              {lead.aiScoring.relevanceReasoning && (
                <p className="muted small" style={{ margin: '6px 0 0' }}>
                  <em>{lead.aiScoring.relevanceReasoning}</em>
                </p>
              )}

              {lead.aiScoring.recommendedProductIds.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {lead.aiScoring.recommendedProductIds.map((id) => (
                    <span key={id} className="tag">
                      {id}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button
                className="btn btn-success btn-sm"
                disabled={busyId === lead.id}
                onClick={() => decide(lead.id, 'approved')}
              >
                Approve
              </button>
              <button
                className="btn btn-danger btn-sm"
                disabled={busyId === lead.id}
                onClick={() => decide(lead.id, 'rejected')}
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
