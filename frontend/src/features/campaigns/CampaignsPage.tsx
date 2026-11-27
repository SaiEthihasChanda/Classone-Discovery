/**
 * Campaigns — designed emails sent to leads picked by filters, through the
 * sales Gmail at a steady pace. The list shows each campaign's progress and how
 * people responded; opening one goes to its builder (draft) or its report
 * (sending / sent). Replies land in Conversations under each person.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState, ErrorBanner, Loading, formatDate, relativeTime } from '../../components/common';
import { Icon, Segmented } from '../../components/ui';
import { AnimatePresence, cardMotion, motion } from '../../components/motion';
import type { CampaignListItem, CampaignStatus } from '../../types';
import { CampaignBuilder } from './CampaignBuilder';

export const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  sending: 'Sending',
  paused: 'Paused',
  done: 'Sent',
  cancelled: 'Cancelled',
};

export function CampaignsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const openId = params.get('id');
  const [data, setData] = useState<{ items: CampaignListItem[]; sentToday: number; dailyCap: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState(false);

  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('id', id);
    else next.delete('id');
    setParams(next, { replace: true });
  };

  useEffect(() => {
    api
      .campaigns()
      .then((d) => (setData(d), setError(null)))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load'));
  }, [tick, openId]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, []);

  async function create() {
    const name = window.prompt('Name this campaign (only your team sees it):', `Campaign ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`);
    if (!name?.trim()) return;
    setCreating(true);
    try {
      const c = await api.createCampaign(name.trim());
      open(c.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create');
    } finally {
      setCreating(false);
    }
  }

  if (openId) return <CampaignBuilder id={openId} onClose={() => (open(null), setTick((n) => n + 1))} onOpen={open} />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Campaigns</h1>
          <p>
            Designed emails to the leads you pick, sent from the sales mailbox one at a time.{' '}
            {data && (
              <span className="muted">
                {data.sentToday} of {data.dailyCap} sent today
              </span>
            )}
          </p>
        </div>
        {can('sales') && (
          <button className="btn btn-primary" disabled={creating} onClick={() => void create()}>
            <Icon name="plus" size={16} /> New campaign
          </button>
        )}
      </div>
      {error && <ErrorBanner message={error} />}
      <NewProducts onOpen={open} />
      <h2 className="section-heading">All campaigns</h2>
      {!data && !error && <Loading />}
      {data?.items.length === 0 && (
        <div className="card">
          <EmptyState>No campaigns yet. Start one: design the email from blocks, choose who gets it, and send.</EmptyState>
        </div>
      )}
      <div className="campaign-grid">
        <AnimatePresence initial={false}>
          {data?.items.map((c) => {
            const pct = c.stats.total ? Math.round(((c.stats.sent + c.stats.failed + c.stats.skipped) / c.stats.total) * 100) : 0;
            return (
              <motion.button key={c.id} {...cardMotion} className="campaign-card" onClick={() => open(c.id)}>
                <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                  <span className={`cstatus ${c.status}`}>{STATUS_LABEL[c.status]}</span>
                  <span className="muted small">{c.status === 'scheduled' && c.sendAt ? `Starts ${formatDate(c.sendAt)}` : relativeTime(c.updatedAt)}</span>
                </div>
                <strong className="campaign-name">
                  {c.kind === 'product_launch' && <span className="launch-tag">New product</span>}
                  {c.name}
                </strong>
                <span className="campaign-subject">{c.subject || <em className="muted">No subject yet</em>}</span>
                {c.stats.total > 0 ? (
                  <>
                    <div className="progress">
                      <span style={{ width: `${pct}%` }} />
                    </div>
                    <div className="campaign-stats">
                      <span>
                        <strong>{c.stats.sent}</strong> sent
                      </span>
                      {c.stats.queued > 0 && (
                        <span>
                          <strong>{c.stats.queued}</strong> waiting
                        </span>
                      )}
                      {c.stats.sent > 0 && (
                        <span title="Opened at least once (an estimate: some mail apps block or pre-load images)">
                          <strong>{c.stats.opened}</strong> opened
                        </span>
                      )}
                      {c.stats.sent > 0 && (
                        <span>
                          <strong>{c.stats.clicked}</strong> clicked
                        </span>
                      )}
                      <span>
                        <strong>{c.stats.replied}</strong> replied
                      </span>
                      {c.stats.failed + c.stats.skipped > 0 && <span className="muted">{c.stats.failed + c.stats.skipped} not sent</span>}
                    </div>
                  </>
                ) : (
                  <span className="muted small">{c.blockCount} block{c.blockCount === 1 ? '' : 's'} · not sent yet</span>
                )}
              </motion.button>
            );
          })}
        </AnimatePresence>
      </div>
    </>
  );
}

// --- New products from the website ------------------------------------------------------------------

type Launches = Awaited<ReturnType<typeof api.launches>>;

const LAUNCH_STATUS: Record<Launches['items'][number]['status'], string> = {
  pending: 'Preparing',
  ready: 'Campaign ready',
  failed: 'Could not prepare',
  skipped: 'Nobody matched',
  withdrawn: 'Removed from the website — not sent',
};

/**
 * Products added to classonesystems.in become announcement campaigns by themselves: the AI drafts the
 * email and picks who it fits. Auto: it sends after a 24 h review window. Manual: it waits as a draft.
 */
function NewProducts({ onOpen }: { onOpen: (id: string) => void }) {
  const { can } = useAuth();
  const [data, setData] = useState<Launches | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api
      .launches()
      .then((d) => (setData(d), setError(null)))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load'));
  useEffect(() => {
    void load();
  }, []);
  if (!data) return error ? <ErrorBanner message={error} /> : null;
  const s = data.settings;

  const save = async (patch: Partial<Launches['settings']>) => {
    if (
      patch.mode === 'auto' &&
      !window.confirm(
        'Announce new products automatically?\n\nWhen a product is added to classonesystems.in, the AI drafts an email, picks the people it fits, and sends it 24 hours later (Mon to Sat, 9 am to 6 pm IST) unless someone pauses or edits it. The team is emailed a preview first.',
      )
    )
      return;
    setBusy('settings');
    try {
      await api.setLaunchSettings(patch);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  };
  const checkNow = async () => {
    setBusy('check');
    setNote(null);
    setError(null);
    try {
      const r = await api.checkWebsiteNow();
      setNote(
        r.busy
          ? 'A check is already running.'
          : `Checked ${r.seen} products on the website: ${r.added?.length ? `new: ${r.added.join(', ')}` : 'nothing new'}${r.removed?.length ? `; removed: ${r.removed.join(', ')}` : ''}.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the website');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="new-products card card-pad">
      <div className="np-head">
        <div>
          <h2 style={{ margin: 0 }}>New products</h2>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Products added to classonesystems.in are announced to the people they fit.
            {data.lastSync && <> Website last checked {relativeTime(data.lastSync.at)} ({data.lastSync.seen} products).</>}
          </p>
        </div>
        <div className="np-controls">
          <Segmented
            label="New-product mode"
            title="Auto: sends 24 h after it is prepared unless paused. Manual: waits as a draft."
            items={[
              { key: 'manual', label: 'Manual' },
              { key: 'auto', label: 'Auto' },
            ]}
            value={s.mode}
            disabled={busy !== null || !can('sales')}
            onChange={(m) => void save({ mode: m })}
          />
          {can('sales') && (
            <button className="btn btn-sm" disabled={busy !== null} onClick={() => void checkNow()}>
              {busy === 'check' ? 'Checking…' : 'Check the website now'}
            </button>
          )}
        </div>
      </div>
      <div className="np-settings">
        <label>
          Send to people rated
          <select value={s.minRelevance} disabled={busy !== null || !can('sales')} onChange={(e) => void save({ minRelevance: Number(e.target.value) })}>
            {[40, 50, 60, 70, 80].map((v) => (
              <option key={v} value={v}>
                {v}+
              </option>
            ))}
          </select>
          for relevance, at most
          <select value={s.maxRecipients} disabled={busy !== null || !can('sales')} onChange={(e) => void save({ maxRecipients: Number(e.target.value) })}>
            {[25, 50, 100, 200, 300, 500].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          people per product.
        </label>
      </div>
      {error && <ErrorBanner message={error} />}
      {note && <div className="composer-note">{note}</div>}
      {data.items.length === 0 ? (
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          No new products since the website was first read. Add one on the website and it appears here within 30 minutes.
        </p>
      ) : (
        <div className="np-list">
          {data.items.map((l) => (
            <button key={l.id} className={`np-item ${l.status}`} disabled={!l.campaignId} onClick={() => l.campaignId && onOpen(l.campaignId)}>
              <strong>{l.productName ?? l.productId}</strong>
              <span className="muted small">found {relativeTime(l.detectedAt)}</span>
              <span className={`np-status ${l.status}`}>
                {LAUNCH_STATUS[l.status]}
                {l.status === 'ready' && l.recipients ? ` · ${l.recipients} people` : ''}
              </span>
              {l.error && l.status !== 'ready' && <span className="muted small">{l.error}</span>}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
