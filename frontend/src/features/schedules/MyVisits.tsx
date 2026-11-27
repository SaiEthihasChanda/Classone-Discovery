/**
 * My visits — made for the phone: today's and the coming week's appointments for the signed-in
 * executive, with one big button for the next step (On my way → Check in → Check out).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { ErrorBanner, Loading } from '../../components/common';
import type { ScheduleEvent } from '../../types';
import { StatusPill } from './SchedulesPage';
import { currentPosition, fmtDayTime, fmtTime, mapSearch, sameDay } from './scheduleUtils';

export function MyVisits() {
  const { me } = useAuth();
  const [events, setEvents] = useState<ScheduleEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!me?.email) return;
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    void api
      .scheduleEvents({ from: from.toISOString(), to: new Date(from.getTime() + 8 * 86_400_000).toISOString(), assignee: me.email })
      .then((r) => (setEvents(r.events.filter((e) => e.status !== 'cancelled' && e.type !== 'blocked')), setError(null)))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load your visits'));
  }, [me?.email]);
  useEffect(load, [load]);

  if (!events) return error ? <ErrorBanner message={error} /> : <Loading />;
  const today = events.filter((e) => sameDay(new Date(e.start), new Date()));
  const later = events.filter((e) => !sameDay(new Date(e.start), new Date()));

  return (
    <div className="my-visits">
      {error && <ErrorBanner message={error} />}
      <h3 className="section-title">Today</h3>
      {!today.length ? <p className="muted">Nothing assigned to you today.</p> : today.map((e) => <VisitCard key={e.id} e={e} onChanged={load} />)}
      {later.length > 0 && (
        <>
          <h3 className="section-title" style={{ marginTop: 24 }}>
            Coming up
          </h3>
          {later.map((e) => (
            <VisitCard key={e.id} e={e} onChanged={load} compact />
          ))}
        </>
      )}
    </div>
  );
}

function VisitCard({ e, onChanged, compact }: { e: ScheduleEvent; onChanged: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const next: Array<{ step: 'on-the-way' | 'check-in' | 'check-out'; label: string }> =
    e.status === 'scheduled'
      ? [
          { step: 'check-in', label: 'Check in' },
          { step: 'on-the-way', label: 'On my way' },
        ]
      : e.status === 'on_the_way'
        ? [{ step: 'check-in', label: 'Check in' }]
        : e.status === 'checked_in'
          ? [{ step: 'check-out', label: 'Check out' }]
          : [];

  const go = async (step: (typeof next)[number]['step']) => {
    setBusy(true);
    setMsg(null);
    try {
      const pos = await currentPosition();
      await api.fieldStep(e.id, step, { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, note: step === 'check-out' ? note : undefined });
      if (pos.problem) setMsg(pos.problem);
      onChanged();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Could not record that');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`card card-pad visit-card${compact ? ' compact' : ''}`}>
      <div className="visit-head">
        <div>
          <div className="visit-time">{compact ? fmtDayTime(e.start) : `${fmtTime(e.start)} – ${fmtTime(e.end)}`}</div>
          <h4>{e.title}</h4>
          {e.contactName && (
            <div className="muted small">
              {e.contactName}
              {e.institution ? `, ${e.institution}` : ''}
              {e.leadId && (
                <>
                  {' · '}
                  <Link to={`/leads?status=all&open=${e.leadId}`}>Open in CRM</Link>
                </>
              )}
            </div>
          )}
        </div>
        <StatusPill status={e.displayStatus} />
      </div>
      {e.mode === 'online'
        ? e.meetingLink && (
            <a className="visit-where" href={e.meetingLink} target="_blank" rel="noreferrer">
              Join the meeting
            </a>
          )
        : e.address && (
            <a className="visit-where" href={mapSearch(e.address)} target="_blank" rel="noreferrer">
              📍 {e.address}
            </a>
          )}
      {e.notes && !compact && <p className="visit-notes">{e.notes}</p>}
      {!compact && e.status === 'checked_in' && (
        <textarea className="visit-outcome" rows={2} value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="How did it go? Next steps (optional)" />
      )}
      {msg && <p className="small visit-msg">{msg}</p>}
      {!compact && next.length > 0 && (
        <div className="visit-actions">
          {next.map((n, i) => (
            <button key={n.step} className={`btn ${i === 0 ? 'btn-primary' : ''} visit-btn`} disabled={busy} onClick={() => void go(n.step)}>
              {busy && i === 0 ? 'Recording…' : n.label}
            </button>
          ))}
        </div>
      )}
      {e.outcome && <p className="small" style={{ margin: '8px 0 0' }}>Outcome: {e.outcome}</p>}
    </article>
  );
}
