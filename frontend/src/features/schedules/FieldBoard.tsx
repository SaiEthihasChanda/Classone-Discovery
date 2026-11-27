/** Field today: who is where, from each executive's On my way / Check in / Check out. Refreshes every minute. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { ErrorBanner, Loading } from '../../components/common';
import type { FieldPerson } from '../../types';
import { StatusPill } from './SchedulesPage';
import { dayKey, fmtTime, mapLink, mapSearch } from './scheduleUtils';

const STATE: Record<FieldPerson['state'], { label: string; cls: string }> = {
  at_visit: { label: 'At a visit', cls: 'at' },
  on_the_way: { label: 'On the way', cls: 'going' },
  scheduled: { label: 'Visits later', cls: 'later' },
  done_for_day: { label: 'Done for the day', cls: 'done' },
  free: { label: 'No visits', cls: 'free' },
};

export function FieldBoard() {
  const [date, setDate] = useState(() => dayKey(new Date()));
  const [people, setPeople] = useState<FieldPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void api
      .fieldBoard(date)
      .then((r) => (setPeople(r.people), setError(null)))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the board'));
  }, [date]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const order: FieldPerson['state'][] = ['at_visit', 'on_the_way', 'scheduled', 'done_for_day', 'free'];
  const sorted = [...(people ?? [])].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || a.name.localeCompare(b.name));

  return (
    <div className="field-board">
      <div className="row" style={{ gap: 10, marginBottom: 14 }}>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} />
        <span className="muted small">Each step records the time and one location reading — nobody is tracked in between.</span>
      </div>
      {error && <ErrorBanner message={error} />}
      {!people ? (
        <Loading />
      ) : !people.length ? (
        <div className="empty">No sales users yet — add them under Admin → Users.</div>
      ) : (
        <div className="field-grid">
          {sorted.map((p) => (
            <section key={p.email} className="card card-pad field-card">
              <div className="field-card-head">
                <strong>{p.name}</strong>
                <span className={`field-state ${STATE[p.state].cls}`}>{STATE[p.state].label}</span>
              </div>
              {p.current && (
                <p className="field-now">
                  {p.current.status === 'checked_in' ? 'At' : 'Heading to'} <strong>{p.current.title}</strong>
                  {p.current.status === 'checked_in' && p.current.checkIn && <> since {fmtTime(p.current.checkIn.at)}</>}
                </p>
              )}
              {p.next && (
                <p className="muted small" style={{ margin: '0 0 8px' }}>
                  Next: {fmtTime(p.next.start)} · {p.next.title}
                </p>
              )}
              {p.lastLocation && (
                <a className="field-loc" href={mapLink(p.lastLocation.lat, p.lastLocation.lng)} target="_blank" rel="noreferrer">
                  📍 Last seen {fmtTime(p.lastLocation.at)} — {p.lastLocation.kind === 'checkIn' ? 'checked in at' : p.lastLocation.kind === 'checkOut' ? 'left' : 'set off for'} {p.lastLocation.eventTitle}
                </a>
              )}
              {p.visits.length > 0 && (
                <ol className="field-timeline">
                  {p.visits.map((v) => (
                    <li key={v.id} className={v.displayStatus}>
                      <span className="field-time">{fmtTime(v.start)}</span>
                      <span className="field-title">
                        {v.title}
                        {v.address && (
                          <a href={mapSearch(v.address)} target="_blank" rel="noreferrer" className="muted small">
                            {' '}
                            · map
                          </a>
                        )}
                      </span>
                      <StatusPill status={v.displayStatus} />
                    </li>
                  ))}
                </ol>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
