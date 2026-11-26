/**
 * Opened from a "Review & send" button in a team email (overdue digest, holding-reply
 * notice). Works without signing in — the link itself is the permission, and it can only
 * send this one reply to this one person. Shows what they wrote and the reply, and sends
 * only on the button below (never on opening the link, so mail-app link scanners can't).
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { relativeTime } from '../../components/common';

type Draft = Awaited<ReturnType<typeof api.publicDraft>>;

export function SendDraftPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');

  useEffect(() => {
    if (!token) return setError('This link is incomplete.');
    api
      .publicDraft(token)
      .then(setDraft)
      .catch((e) => setError(e instanceof Error ? e.message : 'This link does not work.'));
  }, [token]);

  const send = async () => {
    setState('sending');
    setError(null);
    try {
      await api.sendPublicDraft(token);
      setState('sent');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send');
      setState('idle');
    }
  };

  return (
    <div className="act-page">
      <div className="act-card">
        <img src="/classone-logo.png" alt="Class One Systems" className="act-logo" />
        {error && <div className="composer-error">{error}</div>}
        {!draft && !error && <p className="muted">Loading…</p>}
        {draft && state === 'sent' && (
          <div className="act-done">
            <div className="act-tick">✓</div>
            <h2>Sent to {draft.to.name}</h2>
            <p className="muted">It went from the sales mailbox, in the same conversation. You can close this page.</p>
          </div>
        )}
        {draft && state !== 'sent' && (
          <>
            <h2 style={{ margin: '4px 0 2px' }}>Reply to {draft.to.name}</h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              {draft.to.email}
              {draft.waitingSince ? ` · waiting since ${relativeTime(draft.waitingSince)}` : ''}
            </p>
            {draft.theirMessage && (
              <>
                <div className="act-label">They wrote — “{draft.theirMessage.subject}”</div>
                <div className="inbound-quote" style={{ marginTop: 4 }}>{draft.theirMessage.body}</div>
              </>
            )}
            <div className="act-label" style={{ marginTop: 16 }}>
              Reply to send — {draft.subject}
            </div>
            <div className="ai-card" style={{ width: '100%', marginTop: 4 }}>
              <div className="ai-card-body">{draft.body}</div>
            </div>
            <div className="row" style={{ gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" disabled={state === 'sending'} onClick={() => void send()}>
                {state === 'sending' ? 'Sending…' : 'Send this reply'}
              </button>
              <a className="btn" href={`/conversations?person=${encodeURIComponent(draft.to.email ?? '')}`}>
                Edit it in the CRM instead
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
