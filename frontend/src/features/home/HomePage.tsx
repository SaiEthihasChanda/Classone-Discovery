/**
 * Home — what needs doing today, each item one click from the action.
 * Running pipeline jobs show here too, so a run started in the wizard can be
 * left and checked later.
 */
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import { useAuth } from '../../auth/AuthProvider';
import { ErrorBanner, relativeTime } from '../../components/common';
import { JobPanel } from '../../components/pickers';

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function HomePage() {
  const { me } = useAuth();
  const { data, error, reload } = useAsync(async () => {
    const [review, drafts, open, jobs, dash] = await Promise.all([
      api.listLeads({ status: 'pending_review', limit: 1 }),
      api.listThreads('draft'),
      api.listThreads('open'),
      api.rosterJobs(),
      api.dashboard(),
    ]);
    const now = Date.now();
    return {
      toReview: review.total,
      drafts: drafts.items.length,
      dueFollowUps: open.items.filter((t) => t.followUp.nextCheckAt && new Date(t.followUp.nextCheckAt).getTime() <= now).length,
      awaitingReply: open.items.length,
      running: jobs.jobs.filter((j) => j.status === 'running'),
      activity: dash.recentActivity.slice(0, 8),
    };
  }, []);

  const first = me?.name?.split(' ')[0];
  const todos = data
    ? [
        { count: data.toReview, title: 'Leads to review', hint: 'Approve or reject newly promoted researchers.', to: '/leads?status=pending_review', cta: 'Review leads' },
        { count: data.drafts, title: 'Emails to approve', hint: 'AI-written drafts waiting for a human to send.', to: '/outreach', cta: 'Open drafts' },
        { count: data.dueFollowUps, title: 'Follow-ups due', hint: 'No reply yet and the wait is over — draft the next email.', to: '/outreach?tab=sent', cta: 'See threads' },
        { count: data.awaitingReply, title: 'Awaiting reply', hint: 'Sent and open. Mark replied when someone answers.', to: '/outreach?tab=sent', cta: 'See sent' },
      ]
    : [];

  return (
    <>
      <div className="page-header">
        <div>
          <h1>
            {greeting()}
            {first ? `, ${first}` : ''}
          </h1>
          <p>Here's what needs attention.</p>
        </div>
        <button className="btn btn-sm btn-ghost" onClick={reload}>
          Refresh
        </button>
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="todo-grid">
        {todos.map((t) => (
          <Link key={t.title} to={t.to} className="todo">
            <span className={`todo-count${t.count === 0 ? ' zero' : ''}`}>{t.count}</span>
            <span className="todo-title">{t.title}</span>
            <span className="todo-hint">{t.hint}</span>
            {t.count > 0 && <span className="todo-cta">{t.cta} →</span>}
          </Link>
        ))}
      </div>

      {data && data.running.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <h2 className="section-title">Running now</h2>
          {data.running.map((j) => (
            <JobPanel key={j.id} job={j} onCancel={() => void api.cancelRosterJob(j.id).then(reload)} />
          ))}
        </div>
      )}

      {data && (
        <section className="card card-pad">
          <h2 className="section-title">Recent activity</h2>
          {data.activity.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>Nothing yet.</p>
          ) : (
            data.activity.map((entry) => (
              <div key={entry.id} className="feed-item">
                <span className={`feed-dot ${entry.severity}`} />
                <span>{entry.relatedLeadId ? <Link to={`/leads?status=all&open=${entry.relatedLeadId}`}>{entry.message}</Link> : entry.message}</span>
                <span className="feed-time">{relativeTime(entry.createdAt)}</span>
              </div>
            ))
          )}
        </section>
      )}
    </>
  );
}
