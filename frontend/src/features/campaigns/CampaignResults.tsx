/**
 * A sent campaign, person by person: who opened, which links they clicked, who opened the demo
 * booking page, who booked, who replied — filterable, with a one-click follow-up (for approval) to
 * people who looked at the booking page but did not book.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { ErrorBanner, relativeTime } from '../../components/common';
import { Segmented } from '../../components/ui';
import type { CampaignResultRow, CampaignResults as Results } from '../../types';

type Filter = 'all' | 'opened' | 'clicked' | 'notBooked' | 'booked' | 'replied';

const linkLabel = (url: string) => {
  try {
    const u = new URL(url);
    if (/^\/book\/?$/.test(u.pathname)) return 'Booking page';
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last).replace(/[-_]/g, ' ') : u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

export function CampaignResults({ campaignId, tick }: { campaignId: string; tick: number }) {
  const { can } = useAuth();
  const [data, setData] = useState<Results | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    api
      .campaignResults(campaignId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the results'));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, tick]);

  const rows = useMemo(() => {
    const all = (data?.rows ?? []).filter((r) => r.status === 'sent');
    const keep: Record<Filter, (r: CampaignResultRow) => boolean> = {
      all: () => true,
      opened: (r) => Boolean(r.openedAt),
      clicked: (r) => r.clicks > 0,
      notBooked: (r) => r.clickedBooking && !r.booked,
      booked: (r) => Boolean(r.booked),
      replied: (r) => r.replied,
    };
    return all.filter(keep[filter]);
  }, [data, filter]);

  if (error) return <ErrorBanner message={error} />;
  if (!data) return null;
  const s = data.summary;
  if (!s.sent) return null;
  const funnel = [
    { label: 'Emailed', n: s.sent },
    { label: 'Opened', n: s.opened, hint: 'An estimate: some mail apps block images, others load them for privacy.' },
    { label: 'Clicked a link', n: s.clicked },
    { label: 'Opened the booking page', n: s.clickedBooking },
    { label: 'Booked a demo', n: s.booked },
  ];

  const nudge = async () => {
    if (!window.confirm(`Draft a short follow-up for the ${s.clickedNotBooked} ${s.clickedNotBooked === 1 ? 'person' : 'people'} who opened the booking page but did not book?\n\nThe drafts wait in Conversations → Needs you; nothing is sent until someone approves each one.`)) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api.nudgeNonBookers(campaignId);
      setNote(r.drafted ? `${r.drafted} follow-up${r.drafted === 1 ? '' : 's'} drafted — review them in Conversations → Needs you.` : 'Nobody to follow up: they have replied, booked, already been followed up, or have a draft waiting.');
      void load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card card-pad results">
      <h3 className="section-title">Results</h3>
      <div className="results-funnel">
        {funnel.map((f, i) => (
          <div key={f.label} title={f.hint}>
            <strong>{f.n}</strong>
            <span>{f.label}</span>
            {i > 0 && <small>{funnel[0]!.n ? Math.round((f.n / funnel[0]!.n) * 100) : 0}%</small>}
            <i style={{ width: `${funnel[0]!.n ? Math.max(f.n ? 4 : 0, (f.n / funnel[0]!.n) * 100) : 0}%`, animationDelay: `${i * 80}ms` }} />
          </div>
        ))}
      </div>

      {s.clickedNotBooked > 0 && (
        <div className="results-callout">
          <span>
            <strong>{s.clickedNotBooked}</strong> {s.clickedNotBooked === 1 ? 'person' : 'people'} opened the booking page but did not book.
          </span>
          <span className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm btn-ghost" onClick={() => setFilter('notBooked')}>
              Show them
            </button>
            {can('sales') && (
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void nudge()}>
                {busy ? 'Drafting…' : 'Draft a follow-up'}
              </button>
            )}
          </span>
        </div>
      )}
      {note && <p className="small" style={{ color: 'var(--success)', margin: 0 }}>{note}</p>}

      <Segmented<Filter>
        label="Show"
        items={[
          { key: 'all', label: 'Everyone', count: s.sent },
          { key: 'opened', label: 'Opened', count: s.opened },
          { key: 'clicked', label: 'Clicked', count: s.clicked },
          { key: 'notBooked', label: "Didn't book", count: s.clickedNotBooked },
          { key: 'booked', label: 'Booked', count: s.booked },
          { key: 'replied', label: 'Replied', count: s.replied },
        ]}
        value={filter}
        onChange={setFilter}
      />

      <div className="results-list">
        {!rows.length ? (
          <p className="muted small">Nobody here yet.</p>
        ) : (
          rows.map((r) => (
            <div key={r.id} className="results-row">
              <div className="results-who">
                <strong>{r.leadId ? <Link to={`/leads?status=all&open=${r.leadId}`}>{r.name ?? r.email}</Link> : (r.name ?? r.email)}</strong>
                <span className="muted small">{r.email}</span>
              </div>
              <div className="results-tags">
                {r.openedAt ? <span className="rtag opened" title={`First opened ${relativeTime(r.openedAt)}${r.opens > 1 ? ` · ${r.opens} opens` : ''}`}>Opened</span> : <span className="rtag none">Not opened</span>}
                {[...new Set(r.links.map((l) => linkLabel(l.url)))].map((l) => (
                  <span key={l} className={`rtag link${l === 'Booking page' ? ' booking' : ''}`}>
                    {l === 'Booking page' ? '📅 ' : '↗ '}
                    {l}
                  </span>
                ))}
                {r.booked && <span className="rtag booked">Booked · {new Date(r.booked.start).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>}
                {r.clickedBooking && !r.booked && <span className="rtag warn">Didn't book{r.nudged ? ' · followed up' : ''}</span>}
                {r.replied && <span className="rtag replied">Replied</span>}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
