/**
 * Admin → Activity: who did what in the app, newest first. Search the text, pick a person, or show
 * only people / only the app's own work, over a date range. Entries link to the lead they touched.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBanner, Loading } from '../../components/common';
import type { ActivityLogEntry } from '../../types';

type Kind = '' | 'people' | 'system';
const day = (d: Date) => d.toISOString().slice(0, 10);

function when(at: string): string {
  return new Date(at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const initials = (s: string) =>
  s
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

export function ActivityLogPage() {
  const [text, setText] = useState('');
  const [actor, setActor] = useState('');
  const [kind, setKind] = useState<Kind>('');
  const [from, setFrom] = useState(() => day(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(() => day(new Date()));
  const [items, setItems] = useState<ActivityLogEntry[] | null>(null);
  const [actors, setActors] = useState<Array<{ actor: string; actorName?: string }>>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const query = useCallback(
    (before?: string) =>
      api.activityLog({
        text: text.trim() || undefined,
        actor: actor || undefined,
        kind: actor ? undefined : kind || undefined,
        from: from ? new Date(from).toISOString() : undefined,
        to: to ? new Date(new Date(to).getTime() + 86_400_000).toISOString() : undefined,
        before,
        limit: 50,
      }),
    [text, actor, kind, from, to],
  );

  // Filters apply as you type (debounced).
  useEffect(() => {
    const t = setTimeout(() => {
      setError(null);
      query()
        .then((r) => {
          setItems(r.items);
          setMore(r.items.length === 50);
          if (r.actors) setActors(r.actors);
        })
        .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the activity log'));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const loadMore = async () => {
    if (!items?.length) return;
    setLoadingMore(true);
    try {
      const r = await query(String(items[items.length - 1]!.createdAt));
      setItems([...items, ...r.items]);
      setMore(r.items.length === 50);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="activity-log">
      <div className="activity-filters">
        <input className="activity-search" placeholder="Search — a name, an institute, “approved”, “deleted”…" value={text} onChange={(e) => setText(e.target.value)} />
        <select value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Person">
          <option value="">Everyone</option>
          {actors.map((a) => (
            <option key={a.actor} value={a.actor}>
              {a.actorName ?? a.actor}
            </option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} disabled={Boolean(actor)} aria-label="Kind">
          <option value="">People and the app</option>
          <option value="people">Only people</option>
          <option value="system">Only the app</option>
        </select>
        <label className="activity-date">
          From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="activity-date">
          To <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>

      {error && <ErrorBanner message={error} />}
      {!items ? (
        <Loading label="Loading the activity log…" />
      ) : !items.length ? (
        <div className="empty">Nothing matches.</div>
      ) : (
        <div className="card activity-list">
          {items.map((a) => (
            <div key={a.id} className={`activity-row${a.severity !== 'info' ? ` ${a.severity}` : ''}`}>
              <span className={`activity-avatar${a.actor ? '' : ' system'}`} title={a.actor ?? 'The app'}>
                {a.actor ? initials(a.actorName ?? a.actor) : '⚙'}
              </span>
              <div className="activity-main">
                <div>
                  <strong>{a.actor ? (a.actorName ?? a.actor) : 'The app'}</strong> <span>{a.message}</span>
                </div>
                <div className="muted small">
                  {when(String(a.createdAt))}
                  {a.relatedLeadId && (
                    <>
                      {' · '}
                      <Link to={`/leads?status=all&open=${a.relatedLeadId}`}>Open lead</Link>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
          {more && (
            <div className="activity-more">
              <button className="btn btn-sm" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Show older'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
