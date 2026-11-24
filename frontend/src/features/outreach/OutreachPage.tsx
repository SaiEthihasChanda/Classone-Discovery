import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState, ErrorBanner, Loading, formatDate, relativeTime } from '../../components/common';
import { Tabs } from '../../components/ui';
import { LeadRecord } from '../leads/LeadRecord';

const DRAFT_TYPE_LABEL: Record<string, string> = {
  initial_outreach: 'First email',
  follow_up_1: 'Follow-up 1',
  follow_up_2: 'Follow-up 2',
};

type OutreachTab = 'drafts' | 'sent' | 'closed';

/**
 * Outreach — the approval gate for every email (Drafts), what's out and waiting
 * (Sent), and finished conversations (Closed). Nothing emails anyone without a
 * click here or on the lead itself.
 */
export function OutreachPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as OutreachTab | null) ?? 'drafts';
  const openLead = params.get('open');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const setQuery = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v === null ? next.delete(k) : next.set(k, v));
    setParams(next, { replace: true });
  };

  const { data, loading, error, reload } = useAsync(async () => {
    const [drafts, open, closed, replied] = await Promise.all([
      api.listThreads('draft'),
      api.listThreads('open'),
      api.listThreads('closed'),
      api.listThreads('replied'),
    ]);
    return { drafts: drafts.items, sent: open.items, closed: [...replied.items, ...closed.items] };
  }, []);

  async function act(id: string, fn: () => Promise<unknown>, done?: string) {
    setBusyId(id);
    setActionError(null);
    setNote(null);
    try {
      await fn();
      if (done) setNote(done);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusyId(null);
    }
  }

  const items = data ? data[tab] : [];

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Outreach</h1>
          <p>AI drafts every email; a person approves before anything is sent.</p>
        </div>
      </div>

      <Tabs
        items={[
          { key: 'drafts', label: 'Drafts', count: data?.drafts.length },
          { key: 'sent', label: 'Sent', count: data?.sent.length },
          { key: 'closed', label: 'Closed', count: data?.closed.length },
        ]}
        value={tab}
        onChange={(k) => setQuery({ tab: k === 'drafts' ? null : k })}
      />

      {note && <div className="alert alert-success">{note}</div>}
      {actionError && <ErrorBanner message={actionError} />}
      {error && <ErrorBanner message={error} />}
      {loading && !data && <Loading />}

      {data && items.length === 0 && (
        <div className="card">
          <EmptyState>
            {tab === 'drafts'
              ? 'No drafts waiting. Open a lead and choose "Draft outreach" to write one.'
              : tab === 'sent'
                ? 'Nothing sent yet.'
                : 'No closed conversations yet.'}
          </EmptyState>
        </div>
      )}

      <div style={{ display: 'grid', gap: 14 }}>
        {items.map((thread) => (
          <article key={thread.id} className="card card-pad">
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 420px', minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button className="btn-link" onClick={() => setQuery({ open: thread.leadId })}>
                    {thread.leadName ?? 'Unknown lead'}
                  </button>
                  {tab === 'drafts' && <span className="badge badge-neutral">{DRAFT_TYPE_LABEL[thread.draftType ?? ''] ?? thread.draftType}</span>}
                  {tab === 'closed' && <span className="badge badge-neutral">{thread.closedReason?.replace(/_/g, ' ') ?? thread.status}</span>}
                </div>
                <div className="muted small">
                  {[thread.leadInstitution, thread.leadEmailSnapshot].filter(Boolean).join(' · ')}
                  {tab === 'sent' && thread.followUp.nextCheckAt && <> · follow-up {new Date(thread.followUp.nextCheckAt).getTime() <= Date.now() ? 'due now' : `on ${formatDate(thread.followUp.nextCheckAt)}`}</>}
                  {tab !== 'drafts' && thread.messages.length > 0 && <> · last sent {relativeTime(thread.messages.at(-1)!.sentAt)}</>}
                </div>
                {tab === 'drafts' ? (
                  <>
                    <p style={{ margin: '14px 0 4px', fontWeight: 600 }}>{thread.draftSubject}</p>
                    <p style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{thread.draftBody}</p>
                  </>
                ) : (
                  <p style={{ margin: '10px 0 0' }}>
                    {thread.subjectLine}
                    <span className="muted"> · {thread.messages.length} sent · {thread.followUp.attemptsSent}/{thread.followUp.maxAttempts} follow-ups</span>
                  </p>
                )}
              </div>

              {can('sales') && (
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  {tab === 'drafts' && (
                    <>
                      <button className="btn btn-primary btn-sm" disabled={busyId === thread.id} onClick={() => void act(thread.id, () => api.approveSendOutreach(thread.id), `Sent to ${thread.leadEmailSnapshot}.`)}>
                        {busyId === thread.id ? 'Sending…' : 'Approve & send'}
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        disabled={busyId === thread.id}
                        onClick={() => window.confirm('Discard this draft without sending it?') && void act(thread.id, () => api.rejectDraft(thread.id))}
                      >
                        Discard
                      </button>
                    </>
                  )}
                  {tab === 'sent' && (
                    <>
                      {thread.followUp.attemptsSent < thread.followUp.maxAttempts && (
                        <button className="btn btn-sm" disabled={busyId === thread.id} onClick={() => void act(thread.id, () => api.draftOutreach(thread.leadId), 'Follow-up drafted — see Drafts.')}>
                          Draft follow-up
                        </button>
                      )}
                      <button className="btn btn-sm" disabled={busyId === thread.id} onClick={() => void act(thread.id, () => api.markReplied(thread.id))}>
                        Mark replied
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </article>
        ))}
      </div>

      {openLead && <LeadRecord id={openLead} onClose={() => setQuery({ open: null })} onChanged={reload} />}
    </>
  );
}
