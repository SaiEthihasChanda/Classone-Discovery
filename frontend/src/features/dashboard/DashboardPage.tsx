import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import { ErrorBanner, Loading, relativeTime } from '../../components/common';

/**
 * The proposal's command centre: four tiles plus a recent-activity feed.
 *
 * Polls every 30s so the numbers stay live without a page refresh. Polling
 * rather than websockets is deliberate — an internal tool with a handful of
 * users does not need a socket server, and this survives the eventual move to
 * Cloud Functions unchanged.
 */
const POLL_INTERVAL_MS = 30_000;

export function DashboardPage() {
  const { data, loading, error, reload } = useAsync(() => api.dashboard(), []);

  useEffect(() => {
    const id = setInterval(reload, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [reload]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBanner message={error} />;
  if (!data) return null;

  const { tiles, recentActivity } = data;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p>Live view of customer records, discoveries, threads and alerts.</p>
        </div>
        <button className="btn btn-sm" onClick={reload}>
          Refresh
        </button>
      </div>

      <div className="tiles">
        <Tile value={tiles.activeCustomers} label="Active Customers" />
        <Tile value={tiles.inProgressDiscoveries} label="In-Progress Discoveries" />
        <Tile value={tiles.openThreads} label="Open Email Threads" />
        <Tile value={tiles.criticalAlerts} label="Critical Alerts" alert />
      </div>

      <div className="card card-pad">
        <h2 className="section-title">Recent Notifications</h2>

        {recentActivity.length === 0 ? (
          <p className="muted small">
            No activity yet. Add a lead from the <Link to="/leads">Leads</Link> page to see
            entries here.
          </p>
        ) : (
          recentActivity.map((entry) => (
            <div key={entry.id} className="feed-item">
              <span className={`feed-dot ${entry.severity}`} />
              <span>
                {entry.relatedLeadId ? (
                  <Link to={`/leads/${entry.relatedLeadId}`}>{entry.message}</Link>
                ) : (
                  entry.message
                )}
              </span>
              <span className="feed-time">{relativeTime(entry.createdAt)}</span>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function Tile({ value, label, alert }: { value: number; label: string; alert?: boolean }) {
  return (
    <div className={`tile${alert && value > 0 ? ' alert' : ''}`}>
      <div className="tile-value">{value}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}
