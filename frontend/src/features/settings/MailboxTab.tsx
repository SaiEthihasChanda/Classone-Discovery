/**
 * Mailbox history: bring older mail from the sales mailbox onto people's conversations.
 * Imported mail is filed as already read — no AI, nothing drafted, sent or scheduled.
 */
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { ErrorBanner, relativeTime } from '../../components/common';
import type { MailboxImport } from '../../types';

const day = (d: Date) => d.toISOString().slice(0, 10);

export function MailboxTab() {
  const [state, setState] = useState<MailboxImport | null>(null);
  const [from, setFrom] = useState(() => day(new Date(Date.now() - 90 * 86_400_000)));
  const [to, setTo] = useState(() => day(new Date()));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .mailboxImport()
      .then((r) => setState(r.import))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not read the import status'));

  useEffect(() => {
    void load();
  }, []);
  // While an import runs, its progress refreshes every 2 s.
  useEffect(() => {
    if (state?.status !== 'running') return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [state?.status]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setState((await api.startMailboxImport(from, to)).import);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the import');
    } finally {
      setBusy(false);
    }
  };

  const running = state?.status === 'running';
  const pct = state && state.found ? Math.round(((state.handled + state.failed) / state.found) * 100) : 0;

  return (
    <div className="mailbox-tab">
      <section className="card card-pad">
        <h3 className="section-title">How mail reaches Conversations</h3>
        <ul className="mailbox-facts">
          <li>Every minute the app reads the last 2 days of the Primary inbox and the Sent folder.</li>
          <li>When the server starts after being off, it catches up on what it missed, up to 30 days back.</li>
          <li>Newsletters, notifications, no-reply senders and bounces are skipped.</li>
        </ul>
      </section>

      <section className="card card-pad">
        <h3 className="section-title">Import older mail</h3>
        <p className="muted small">
          Files mail from a date range onto each person's conversation, already marked read. The AI is not used — nothing is drafted, sent or scheduled, and nobody new
          becomes a lead (unknown senders are kept as contacts). Mail already in the app is skipped, so running it twice is safe.
        </p>
        {error && <ErrorBanner message={error} />}
        <div className="mailbox-range">
          <label>
            From
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} disabled={running} />
          </label>
          <label>
            To
            <input type="date" value={to} min={from} max={day(new Date())} onChange={(e) => setTo(e.target.value)} disabled={running} />
          </label>
          <button className="btn btn-primary" onClick={() => void start()} disabled={busy || running || !from || !to}>
            {running ? 'Importing…' : busy ? 'Starting…' : 'Import'}
          </button>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          At most a year per run, and up to 5,000 emails per folder.
        </p>
      </section>

      {state && (
        <section className={`card card-pad mailbox-status ${state.status}`}>
          <div className="mailbox-status-head">
            <strong>{state.status === 'running' ? 'Importing' : state.status === 'done' ? 'Last import finished' : 'Last import stopped'}</strong>
            <span className="muted small">
              {day(new Date(state.from))} to {day(new Date(new Date(state.to).getTime() - 1))} · started {relativeTime(state.startedAt)}
            </span>
          </div>
          {running && (
            <div className="progress" aria-label="Import progress">
              <span style={{ width: `${state.found ? pct : 4}%` }} />
            </div>
          )}
          <p className="small" style={{ margin: 0 }}>
            {state.found ? (
              <>
                {state.handled.toLocaleString('en-IN')} of {state.found.toLocaleString('en-IN')} emails handled
                {state.failed ? ` · ${state.failed} could not be read` : ''}
              </>
            ) : running ? (
              'Listing the mailbox…'
            ) : (
              'No email in that range.'
            )}
          </p>
          {state.error && <p className="small mailbox-error">{state.error}</p>}
        </section>
      )}
    </div>
  );
}
