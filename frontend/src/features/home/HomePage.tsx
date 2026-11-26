/**
 * Home — the analytics dashboard. Headline numbers, anything broken, today's to-dos, the
 * funnel from "found" to "replied", sending trends, outreach and campaign results, and who on
 * the team answered what. Data: GET /dashboard?range= (backend services/dashboard/dashboardService.ts).
 * Running roster jobs still show here so a run started in the wizard can be checked later.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import { useAuth } from '../../auth/AuthProvider';
import { ErrorBanner, Loading, relativeTime } from '../../components/common';
import { JobPanel } from '../../components/pickers';
import type { DashboardData, DashboardRange } from '../../types';

const RANGES: Array<{ value: DashboardRange; label: string }> = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'all', label: 'All time' },
];

/** Sends by kind — categorical slots 1–4 of the validated palette, fixed order; replies take slot 5. */
const SERIES = [
  { key: 'manual', label: 'Written by the team', color: '#2a78d6' },
  { key: 'ai', label: 'AI draft, approved', color: '#eb6834' },
  { key: 'automatic', label: 'Automatic', color: '#1baf7a' },
  { key: 'campaign', label: 'Campaign', color: '#eda100' },
] as const;
const REPLIES_COLOR = '#e87ba4';

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

const fmtHours = (h: number | null) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 24)} days`);
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtPct = (v: number | null) => (v == null ? '—' : `${v}%`);

export function HomePage() {
  const { me } = useAuth();
  const [range, setRange] = useState<DashboardRange>('30');
  const { data, loading, error, reload } = useAsync(async () => {
    const [dash, jobs] = await Promise.all([api.dashboard(range), api.rosterJobs()]);
    return { dash, running: jobs.jobs.filter((j) => j.status === 'running') };
  }, [range]);
  const first = me?.name?.split(' ')[0];
  const d = data?.dash;
  const periodWord = range === 'all' ? 'all time' : `the last ${range} days`;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>
            {greeting()}
            {first ? `, ${first}` : ''}
          </h1>
          <p>
            How sales is going over {periodWord}.{d && <span className="muted"> Updated {relativeTime(d.generatedAt)}.</span>}
          </p>
        </div>
        <div className="dash-controls">
          <div className="segmented" role="radiogroup" aria-label="Period">
            {RANGES.map((r) => (
              <button key={r.value} role="radio" aria-checked={range === r.value} className={range === r.value ? 'active' : ''} onClick={() => setRange(r.value)}>
                {r.label}
              </button>
            ))}
          </div>
          <button className="btn btn-sm btn-ghost" onClick={reload} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}
      {!d && !error && <Loading />}

      {d && (
        <div className="dash">
          {d.alerts.length > 0 && <Alerts alerts={d.alerts} />}
          <Tiles d={d} range={range} />
          <Todo d={d} />
          {data.running.length > 0 && (
            <section>
              <h2 className="section-title">Running now</h2>
              {data.running.map((j) => (
                <JobPanel key={j.id} job={j} onCancel={() => void api.cancelRosterJob(j.id).then(reload)} />
              ))}
            </section>
          )}
          <div className="dash-two">
            <Funnel funnel={d.funnel} />
            <Trend trends={d.trends} />
          </div>
          <Outreach o={d.outreach} />
          <Team team={d.team} />
          <Activity activity={d.activity} />
        </div>
      )}
    </>
  );
}

// --- Alerts ------------------------------------------------------------------------------------------------

const ALERT_ICON = { critical: '!', warning: '!', info: 'i' } as const;
const ALERT_WORD = { critical: 'Needs fixing', warning: 'Warning', info: 'Note' } as const;

function Alerts({ alerts }: { alerts: DashboardData['alerts'] }) {
  return (
    <div className="dash-alerts" role="list">
      {alerts.map((a, i) => (
        <Link key={i} role="listitem" to={a.to} className={`dash-alert ${a.level}`}>
          <span className="dash-alert-icon" aria-hidden>
            {ALERT_ICON[a.level]}
          </span>
          <span>
            <span className="visually-hidden">{ALERT_WORD[a.level]}: </span>
            <strong>{a.title}</strong>
            <span className="dash-alert-detail">{a.detail}</span>
          </span>
          <span className="dash-alert-go" aria-hidden>
            →
          </span>
        </Link>
      ))}
    </div>
  );
}

// --- Headline numbers ------------------------------------------------------------------------------------

function Delta({ now, prev, unit = '', label }: { now: number | null; prev: number | null; unit?: string; label: string }) {
  if (now == null || prev == null) return null;
  const diff = Math.round((now - prev) * 10) / 10;
  if (diff === 0) return <span className="tile-delta">Same as {label}</span>;
  return (
    <span className="tile-delta">
      <span aria-hidden>{diff > 0 ? '▲' : '▼'}</span> {Math.abs(diff)}
      {unit} {diff > 0 ? 'more' : 'fewer'} than {label}
    </span>
  );
}

function Tiles({ d, range }: { d: DashboardData; range: DashboardRange }) {
  const h = d.headline;
  const prevLabel = range === 'all' ? '' : `the ${range} days before`;
  const tiles: Array<{ label: string; value: string; sub?: React.ReactNode; to?: string; warn?: boolean }> = [
    { label: 'People in the CRM', value: String(h.inCrm.value), sub: <span className="tile-delta">{h.inCrm.delta} approved {range === 'all' ? 'in all' : 'this period'}</span>, to: '/leads' },
    { label: 'Awaiting approval', value: String(h.awaitingApproval.value), to: '/leads?status=pending_review' },
    { label: 'Discoveries in progress', value: String(h.discoveriesInProgress.value), sub: <span className="tile-delta">People moving through Prospects</span>, to: '/prospects' },
    { label: 'Open conversations', value: String(h.openConversations.value), to: '/conversations' },
    { label: 'Overdue replies', value: String(h.overdueReplies.value), sub: <span className="tile-delta">Waiting over 2 days</span>, to: '/conversations', warn: h.overdueReplies.value > 0 },
    { label: 'Emails sent', value: String(h.emailsSent.value), sub: prevLabel ? <Delta now={h.emailsSent.value} prev={h.emailsSent.prev} label={prevLabel} /> : undefined },
    {
      label: 'Reply rate',
      value: fmtPct(h.replyRate.value),
      sub: (
        <span className="tile-delta">
          {h.replyRate.replied} of {h.replyRate.contacted} people we wrote to
        </span>
      ),
    },
  ];
  return (
    <div className="dash-tiles">
      {tiles.map((t) => {
        const body = (
          <>
            <span className="tile-label">{t.label}</span>
            <span className={`tile-value${t.warn ? ' warn' : ''}`}>{t.value}</span>
            {t.sub}
          </>
        );
        return t.to ? (
          <Link key={t.label} to={t.to} className="dash-tile link">
            {body}
          </Link>
        ) : (
          <div key={t.label} className="dash-tile">
            {body}
          </div>
        );
      })}
    </div>
  );
}

// --- To-dos ----------------------------------------------------------------------------------------------

function Todo({ d }: { d: DashboardData }) {
  const items = [
    { count: d.todo.toReview, title: 'Leads to review', to: '/leads?status=pending_review' },
    { count: d.todo.needsYou, title: 'Conversations need you', to: '/conversations' },
    { count: d.todo.conveyorFailed, title: 'Stuck on the conveyor', to: '/prospects' },
  ];
  return (
    <div className="dash-todo">
      <span className="dash-todo-head">Today</span>
      {items.map((t) => (
        <Link key={t.title} to={t.to} className={`dash-todo-item${t.count === 0 ? ' zero' : ''}`}>
          <strong>{t.count}</strong> {t.title}
          {t.count > 0 && <span aria-hidden> →</span>}
        </Link>
      ))}
    </div>
  );
}

// --- Funnel ----------------------------------------------------------------------------------------------

function Funnel({ funnel }: { funnel: DashboardData['funnel'] }) {
  const max = Math.max(1, ...funnel.map((s) => s.count));
  return (
    <section className="card card-pad">
      <h2 className="section-title">From found to replied</h2>
      <p className="muted small dash-sub">People who reached each step in this period.</p>
      <div className="funnel">
        {funnel.map((s, i) => {
          const prev = i > 0 ? funnel[i - 1].count : null;
          const conv = prev ? Math.round((s.count / prev) * 100) : null;
          return (
            <div key={s.key} className="funnel-row" title={`${s.label}: ${s.count}${conv != null ? ` (${conv}% of the step before)` : ''}`}>
              <span className="funnel-label">{s.label}</span>
              <span className="funnel-track">
                <span className="funnel-bar" style={{ width: `${Math.max(s.count ? 1.5 : 0, (s.count / max) * 100)}%` }} />
              </span>
              <span className="funnel-count">{s.count.toLocaleString('en-IN')}</span>
              <span className="funnel-conv">{conv != null ? `${conv}%` : ''}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// --- Trend chart -----------------------------------------------------------------------------------------

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * pow * 4 >= v)! * pow;
  return step * 4;
}

function bucketLabel(start: string, days: number): string {
  const dt = new Date(start);
  return days >= 28 ? dt.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }) : dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function Trend({ trends }: { trends: DashboardData['trends'] }) {
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const b = trends.buckets;
  const total = (x: (typeof b)[number]) => x.manual + x.ai + x.automatic + x.campaign;
  const yMax = niceMax(Math.max(0, ...b.map((x) => Math.max(total(x), x.replies))));
  // Draw at the box's real width so ticks and labels stay legible on a phone.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(560);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(280, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [asTable]);
  const H = W < 420 ? 200 : 220;
  const pad = { l: 32, r: 8, t: 8, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const slot = b.length ? iw / b.length : iw;
  const barW = Math.min(36, slot * 0.6);
  const y = (v: number) => pad.t + ih - (v / yMax) * ih;
  const cx = (i: number) => pad.l + slot * i + slot / 2;
  const every = Math.ceil(b.length / Math.max(3, Math.floor(iw / 70)));
  const per = trends.bucketDays === 1 ? 'day' : trends.bucketDays >= 28 ? 'month' : 'week';

  return (
    <section className="card card-pad">
      <div className="dash-card-head">
        <h2 className="section-title">Emails sent and replies</h2>
        <button className="btn btn-sm btn-ghost" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Show as chart' : 'Show as table'}
        </button>
      </div>
      <p className="muted small dash-sub">Per {per}. Bars are emails we sent, by how they were written; the line is replies received.</p>

      <div className="chart-legend">
        {SERIES.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <span>
          <i className="line" style={{ background: REPLIES_COLOR }} />
          Replies
        </span>
      </div>

      {asTable ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{per[0].toUpperCase() + per.slice(1)} of</th>
                {SERIES.map((s) => (
                  <th key={s.key} className="num">
                    {s.label}
                  </th>
                ))}
                <th className="num">Replies</th>
                <th className="num">New leads</th>
              </tr>
            </thead>
            <tbody>
              {b.map((x) => (
                <tr key={x.start}>
                  <td>{fmtDay(x.start)}</td>
                  {SERIES.map((s) => (
                    <td key={s.key} className="num">
                      {x[s.key]}
                    </td>
                  ))}
                  <td className="num">{x.replies}</td>
                  <td className="num">{x.newLeads}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-box" ref={box} onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Emails sent and replies per ${per}`} className="trend-svg">
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <g key={f}>
                <line x1={pad.l} x2={W - pad.r} y1={y(yMax * f)} y2={y(yMax * f)} className={f === 0 ? 'axis' : 'grid'} />
                <text x={pad.l - 6} y={y(yMax * f) + 4} className="tick" textAnchor="end">
                  {Math.round(yMax * f)}
                </text>
              </g>
            ))}
            {b.map((x, i) => {
              let acc = 0;
              const segs = SERIES.filter((s) => x[s.key] > 0);
              return (
                <g key={x.start} opacity={hover == null || hover === i ? 1 : 0.45}>
                  {segs.map((s, si) => {
                    const v = x[s.key];
                    const top = y(acc + v);
                    const bottom = y(acc);
                    acc += v;
                    const isTop = si === segs.length - 1;
                    const h = Math.max(0, bottom - top - (si > 0 ? 2 : 0));
                    return isTop ? (
                      <path key={s.key} d={roundTop(cx(i) - barW / 2, top, barW, h, Math.min(4, h))} fill={s.color} />
                    ) : (
                      <rect key={s.key} x={cx(i) - barW / 2} y={top} width={barW} height={h} fill={s.color} />
                    );
                  })}
                  {i % every === 0 && (
                    <text x={cx(i)} y={H - 8} className="tick" textAnchor="middle">
                      {bucketLabel(x.start, trends.bucketDays)}
                    </text>
                  )}
                </g>
              );
            })}
            {b.length > 1 && <polyline points={b.map((x, i) => `${cx(i)},${y(x.replies)}`).join(' ')} fill="none" stroke={REPLIES_COLOR} strokeWidth={2} strokeLinejoin="round" />}
            {b.map((x, i) => (
              <circle key={x.start} cx={cx(i)} cy={y(x.replies)} r={hover === i ? 5 : 4} fill={REPLIES_COLOR} stroke="#fff" strokeWidth={2} />
            ))}
            {b.map((x, i) => (
              <rect key={`hit-${x.start}`} x={pad.l + slot * i} y={pad.t} width={slot} height={ih} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${bucketLabel(x.start, trends.bucketDays)}: ${total(x)} sent, ${x.replies} replies`} />
            ))}
          </svg>
          {hover != null && b[hover] && (
            <div className="chart-tip" style={{ left: `${Math.min(75, Math.max(25, (cx(hover) / W) * 100))}%` }}>
              <strong>
                {per === 'day' ? fmtDay(b[hover].start) : `${per[0].toUpperCase() + per.slice(1)} of ${fmtDay(b[hover].start)}`}
              </strong>
              {SERIES.map((s) => (
                <span key={s.key}>
                  <i style={{ background: s.color }} />
                  {s.label}
                  <b>{b[hover][s.key]}</b>
                </span>
              ))}
              <span>
                <i className="line" style={{ background: REPLIES_COLOR }} />
                Replies<b>{b[hover].replies}</b>
              </span>
              <span className="muted">
                New leads<b>{b[hover].newLeads}</b>
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** A bar with rounded top corners only, anchored square on the baseline. */
function roundTop(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return '';
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

// --- Outreach --------------------------------------------------------------------------------------------

const CAMPAIGN_STATUS: Record<string, string> = { draft: 'Draft', scheduled: 'Scheduled', sending: 'Sending', paused: 'Paused', done: 'Sent', cancelled: 'Cancelled' };

function Outreach({ o }: { o: DashboardData['outreach'] }) {
  const sentTotal = o.sends.manual + o.sends.ai + o.sends.automatic + o.sends.campaign;
  const stats = [
    { label: 'Emails sent', value: String(sentTotal) },
    { label: 'Emails received', value: String(o.received) },
    { label: 'Reply rate', value: fmtPct(o.replyRate) },
    { label: 'Typical time to their reply', value: fmtHours(o.medianReplyHours) },
    { label: 'Follow-ups sent', value: String(o.followUps.auto + o.followUps.approved), sub: `${o.followUps.auto} automatic · ${o.followUps.approved} approved` },
  ];
  return (
    <section className="card card-pad">
      <h2 className="section-title">Outreach</h2>
      <div className="dash-stats">
        {stats.map((s) => (
          <div key={s.label}>
            <span className="tile-label">{s.label}</span>
            <span className="dash-stat-value">{s.value}</span>
            {s.sub && <span className="tile-delta">{s.sub}</span>}
          </div>
        ))}
      </div>
      <div className="dash-two inner">
        <div>
          <h3 className="dash-h3">Campaigns</h3>
          {o.campaigns.length === 0 ? (
            <p className="muted small">No campaigns sent in this period.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th className="num">Sent</th>
                    <th className="num">Replied</th>
                    <th className="num">Unsubscribed</th>
                    <th className="num">Reply rate</th>
                  </tr>
                </thead>
                <tbody>
                  {o.campaigns.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link to={`/campaigns?id=${c.id}`}>{c.name}</Link>
                        <div className="muted small">
                          {c.kind === 'product_launch' ? 'New product · ' : ''}
                          {CAMPAIGN_STATUS[c.status] ?? c.status}
                        </div>
                      </td>
                      <td className="num">{c.sent}</td>
                      <td className="num">{c.replied}</td>
                      <td className="num">{c.unsubscribed}</td>
                      <td className="num">{fmtPct(c.replyRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div>
          <h3 className="dash-h3">Products the repliers were matched to</h3>
          {o.topProducts.length === 0 ? (
            <p className="muted small">No replies from people with product matches yet.</p>
          ) : (
            <ol className="dash-products">
              {o.topProducts.map((p) => (
                <li key={p.productId}>
                  <span>{p.name}</span>
                  <b>
                    {p.repliers} {p.repliers === 1 ? 'person' : 'people'}
                  </b>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}

// --- Team ------------------------------------------------------------------------------------------------

function Team({ team }: { team: DashboardData['team'] }) {
  return (
    <section className="card card-pad">
      <h2 className="section-title">Team</h2>
      <p className="muted small dash-sub">Who sent what in this period, and how quickly they answered.</p>
      {team.length === 0 ? (
        <p className="muted small">No emails sent in this period.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Who</th>
                <th className="num">Sent</th>
                <th className="num">Drafts approved</th>
                <th className="num">Typical answer time</th>
                <th className="num">Waiting on them</th>
              </tr>
            </thead>
            <tbody>
              {team.map((t) => (
                <tr key={t.who}>
                  <td>{t.name}</td>
                  <td className="num">{t.sent}</td>
                  <td className="num">{t.approved}</td>
                  <td className="num">{fmtHours(t.medianResponseHours)}</td>
                  <td className="num">{t.waiting}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// --- Activity --------------------------------------------------------------------------------------------

function Activity({ activity }: { activity: DashboardData['activity'] }) {
  return (
    <section className="card card-pad">
      <h2 className="section-title">Recent activity</h2>
      {activity.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Nothing yet.
        </p>
      ) : (
        activity.map((entry) => (
          <div key={entry.id} className="feed-item">
            <span className={`feed-dot ${entry.severity}`} />
            <span>{entry.relatedLeadId ? <Link to={`/leads?status=all&open=${entry.relatedLeadId}`}>{entry.message}</Link> : entry.message}</span>
            <span className="feed-time">{relativeTime(entry.createdAt)}</span>
          </div>
        ))
      )}
    </section>
  );
}
