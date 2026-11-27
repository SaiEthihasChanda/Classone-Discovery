/**
 * Conversations — the sales mailbox, organised around what needs doing and around people.
 *
 * Overview: "Needs you" — one card at a time for each conversation waiting on the team
 * (their message, the AI's draft, Send / Edit / No reply needed right on the card), worked
 * through like a to-do list; below it, everyone the mailbox talks to, as a grid of person cards.
 *
 * Person page (?person=email): who they are, and one timeline of every email with them,
 * grouped by topic, newest topic first — each topic with its own reply box.
 *
 * Nothing is sent without a click on Send. Live: refreshes every 15 s (the server reads the
 * inbox every minute).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { ErrorBanner, Loading, ScorePill, StatusBadge, relativeTime, shortInstitute } from '../../components/common';
import { Icon, Modal, Segmented } from '../../components/ui';
import { AnimatePresence, cardMotion, motion } from '../../components/motion';
import type { CheckInSettings, EmailThread, Person, PersonDetail } from '../../types';

type QueueItem = Awaited<ReturnType<typeof api.needsYou>>['items'][number];

const INTENT_LABEL: Record<string, string> = {
  product_enquiry: 'Product enquiry',
  quote_request: 'Quote request',
  support_request: 'Support',
  meeting_request: 'Meeting request',
  not_interested: 'Not interested',
  unsubscribe: 'Unsubscribe',
  out_of_office: 'Out of office',
  other: 'Message',
};

const initials = (name: string) =>
  name
    .replace(/^(dr|prof)\.?\s+/i, '')
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join('');

function avatarHue(email: string): number {
  let h = 0;
  for (const c of email) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function Avatar({ name, email, size = 40 }: { name: string; email: string; size?: number }) {
  const hue = avatarHue(email);
  return (
    <span className="conv-avatar" style={{ width: size, height: size, fontSize: size * 0.36, background: `hsl(${hue} 55% 92%)`, color: `hsl(${hue} 45% 32%)` }}>
      {initials(name) || '?'}
    </span>
  );
}

const firstName = (name: string) => name.replace(/^(dr|prof)\.?\s+/i, '').split(' ')[0] || name;
const waitedFor = (iso?: string) => {
  if (!iso) return '';
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  return h < 1 ? 'just now' : h < 24 ? `${Math.floor(h)} h` : `${Math.floor(h / 24)} d`;
};
const clock = (iso: string) => new Date(iso).toLocaleString('en-IN', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export function ConversationsPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('person');
  const [tick, setTick] = useState(0);
  const [composeTo, setComposeTo] = useState<string | null>(null);

  const go = (email: string | null) => {
    const next = new URLSearchParams(params);
    if (email) next.set('person', email);
    else next.delete('person');
    setParams(next);
    window.scrollTo({ top: 0 });
  };

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="conv-page">
      {selected ? (
        <PersonPage key={selected} email={selected} tick={tick} onBack={() => go(null)} onChanged={() => setTick((n) => n + 1)} />
      ) : (
        <>
          <div className="page-header" style={{ marginBottom: 18 }}>
            <div>
              <h1>Conversations</h1>
              <p>Everyone the sales mailbox is talking to — and who is waiting on you.</p>
            </div>
            <div className="row" style={{ gap: 12 }}>
              <CheckInSwitch />
              <FollowUpSwitch />
              <button className="btn btn-primary" onClick={() => setComposeTo('')}>
                <Icon name="plus" size={16} /> New message
              </button>
            </div>
          </div>
          <NeedsYou tick={tick} onOpen={go} onChanged={() => setTick((n) => n + 1)} />
          <Everyone tick={tick} onOpen={go} />
        </>
      )}
      {composeTo !== null && <ComposeModal to={composeTo} onClose={() => setComposeTo(null)} onSent={(email) => (setComposeTo(null), setTick((n) => n + 1), go(email))} />}
    </div>
  );
}

/**
 * Re-engagement check-ins: once a day the AI drafts a short check-in for people quiet for 90+ days
 * (approved leads and customers we wrote to before). Drafts only — they wait in Needs you.
 */
function CheckInSwitch() {
  const { can } = useAuth();
  const [s, setS] = useState<CheckInSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api.checkInSettings().then(setS).catch(() => {});
  }, []);
  if (!s) return null;
  const change = async (on: 'on' | 'off') => {
    setBusy(true);
    try {
      setS(await api.setCheckInSettings({ enabled: on === 'on' }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="followup-switch" title={`On: every day the AI drafts a check-in (at most ${s.dailyMax}) for people who have been quiet for ${s.quietDays}+ days. Drafts wait here in Needs you — nothing is sent without approval.`}>
      <span className="muted small">Check-ins</span>
      <Segmented
        label="Check-ins"
        items={[
          { key: 'off', label: 'Off' },
          { key: 'on', label: 'On' },
        ]}
        value={s.enabled ? 'on' : 'off'}
        disabled={busy || !can('sales')}
        onChange={(v) => void change(v)}
      />
    </div>
  );
}

/** Global follow-up mode: Auto sends due follow-ups by themselves (Mon–Sat, 9–6 IST) and tells the team. */
function FollowUpSwitch() {
  const { can } = useAuth();
  const [mode, setMode] = useState<'auto' | 'manual' | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api.conversationSettings().then((s) => setMode(s.followUpMode)).catch(() => {});
  }, []);
  const change = async (m: 'auto' | 'manual') => {
    if (m === 'auto' && !window.confirm('Send follow-ups automatically?\n\nWhen someone has not answered, the AI-written follow-up goes out by itself (Mon–Sat, 9 am–6 pm IST, at most 2 per conversation) and the team is emailed each time. People set to "Never auto" are left out.')) return;
    setBusy(true);
    try {
      setMode((await api.setFollowUpMode(m)).followUpMode);
    } finally {
      setBusy(false);
    }
  };
  if (!mode) return null;
  return (
    <div className="followup-switch" title="Auto: due follow-ups are sent by themselves and the team is told. Manual: they wait in Needs you.">
      <span className="muted small">Follow-ups</span>
      <Segmented
        label="Follow-up mode"
        items={[
          { key: 'manual', label: 'Manual' },
          { key: 'auto', label: 'Auto' },
        ]}
        value={mode}
        disabled={busy || !can('sales')}
        onChange={(m) => void change(m)}
      />
    </div>
  );
}

// --- Needs you: one card at a time ------------------------------------------------------------------

function NeedsYou({ tick, onOpen, onChanged }: { tick: number; onOpen: (email: string) => void; onChanged: () => void }) {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState(0);

  useEffect(() => {
    api
      .needsYou()
      .then((r) => (setItems(r.items), setError(null)))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load'));
  }, [tick]);

  const list = items ?? [];
  const at = Math.min(index, Math.max(0, list.length - 1));
  const current = list[at];
  const finish = (threadId: string) => {
    setItems((cur) => (cur ? cur.filter((i) => i.threadId !== threadId) : cur));
    setDone((n) => n + 1);
    onChanged();
  };

  return (
    <section className="needs-you">
      <div className="needs-head">
        <h2>
          Needs you {items && <span className="needs-count">{list.length}</span>}
        </h2>
        {list.length > 1 && (
          <div className="needs-nav">
            <div className="needs-faces">
              {list.slice(0, 8).map((i, k) => (
                <button key={i.threadId} className={`face${at === k ? ' active' : ''}${i.overdue ? ' late' : ''}`} onClick={() => setIndex(k)} title={`${i.person.name} — ${i.topic}`}>
                  <Avatar name={i.person.name} email={i.person.email} size={28} />
                </button>
              ))}
              {list.length > 8 && <span className="muted small">+{list.length - 8}</span>}
            </div>
            <button className="icon-btn" disabled={at <= 0} onClick={() => setIndex(at - 1)} title="Previous">
              ←
            </button>
            <span className="muted small">
              {at + 1} of {list.length}
            </span>
            <button className="icon-btn" disabled={at >= list.length - 1} onClick={() => setIndex(at + 1)} title="Next">
              →
            </button>
          </div>
        )}
      </div>
      {error && <ErrorBanner message={error} />}
      {!items && !error && <Loading />}
      {items && list.length === 0 && (
        <div className="needs-empty">
          <span className="needs-check">✓</span>
          <div>
            <strong>All caught up.</strong>
            <div className="muted small">{done ? `${done} handled just now. ` : ''}Nobody is waiting for a reply — new mail and follow-ups appear here as they come in.</div>
          </div>
        </div>
      )}
      <AnimatePresence mode="popLayout" initial={false}>
        {current && <QueueCard key={current.threadId} item={current} onDone={() => finish(current.threadId)} onOpen={() => onOpen(current.person.email)} />}
      </AnimatePresence>
    </section>
  );
}

function QueueCard({ item, onDone, onOpen }: { item: QueueItem; onDone: () => void; onOpen: () => void }) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.draft?.body ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const run = async (kind: string, fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };
  const writeWithAi = async () => {
    setBusy('ai');
    setError(null);
    try {
      setText((await api.aiDraftReply(item.threadId)).body);
      setEditing(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The AI could not write it');
    } finally {
      setBusy(null);
    }
  };
  const body = item.theirMessage?.body ?? '';
  const long = body.length > 420;

  return (
    <motion.article {...cardMotion} className={`queue-card${item.overdue ? ' late' : ''}`}>
      <header className="queue-who">
        <Avatar name={item.person.name} email={item.person.email} size={44} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <button className="link-btn queue-name" onClick={onOpen}>
            {item.person.name}
          </button>
          <div className="muted small">
            {[item.person.title, item.person.institution && shortInstitute(item.person.institution)].filter(Boolean).join(' · ') || item.person.email}
            {!item.person.isLead && <span className="tag-new" style={{ marginLeft: 6 }}>Not in CRM</span>}
          </div>
        </div>
        <div className="queue-status">
          {item.kind === 'reply' ? (
            <span className={`qstatus ${item.overdue ? 'late' : 'waiting'}`}>{item.overdue ? `Overdue · ${waitedFor(item.waitingSince)}` : `Waiting ${waitedFor(item.waitingSince)}`}</span>
          ) : (
            <span className="qstatus followup">{item.draft?.type === 'check_in' ? 'Check-in ready' : item.draft?.type === 'grant_note' ? 'New grant — note ready' : 'Follow-up ready'}</span>
          )}
          {item.autoReplyDueAt && <span className="muted small">Holding reply {clock(item.autoReplyDueAt)}</span>}
          {item.autoReplySent && <span className="muted small">Holding reply sent</span>}
        </div>
      </header>

      <div className="queue-topic">
        {item.theirMessage?.intent && item.theirMessage.intent !== 'other' && <span className="intent-pill">{INTENT_LABEL[item.theirMessage.intent] ?? 'Message'}</span>}
        <span>{item.topic}</span>
      </div>

      {item.theirMessage ? (
        <div className="queue-theirs">
          <div className={`queue-theirs-body${long && !expanded ? ' clamped' : ''}`}>{body}</div>
          {long && (
            <button className="link-btn small" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Show less' : 'Show all'}
            </button>
          )}
        </div>
      ) : (
        <p className="muted small" style={{ margin: '0 0 10px' }}>
          They haven't answered your last email. The AI drafted a follow-up.
        </p>
      )}

      {error && <div className="composer-error">{error}</div>}
      {item.person.doNotContact && <div className="composer-error">{firstName(item.person.name)} asked not to be emailed — answer only if they need it.</div>}

      {editing ? (
        <div className="queue-edit">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(14, Math.max(5, text.split('\n').length + 1))} autoFocus />
        </div>
      ) : item.draft ? (
        <div className="queue-draft">
          <div className="queue-draft-label">✦ AI draft {item.draft?.type === 'check_in' ? '— check-in' : item.draft?.type === 'grant_note' ? '— congratulations on a new grant' : item.kind === 'followup' ? '— follow-up' : '— reply'}</div>
          <div className="queue-draft-body">{item.draft.body}</div>
        </div>
      ) : (
        <p className="muted small">No draft yet — write one, or let the AI suggest it.</p>
      )}

      {can('sales') && (
        <footer className="queue-actions">
          {editing ? (
            <button className="btn btn-primary" disabled={!text.trim() || busy !== null} onClick={() => void run('send', () => api.replyOnConversation(item.threadId, text))}>
              {busy === 'send' ? 'Sending…' : 'Send'}
            </button>
          ) : item.draft ? (
            <button className="btn btn-primary" disabled={busy !== null} onClick={() => void run('send', () => api.sendWaitingDraft(item.threadId))}>
              {busy === 'send' ? 'Sending…' : 'Send'}
            </button>
          ) : null}
          {!editing && (
            <button className="btn" disabled={busy !== null} onClick={() => (item.draft ? (setText(item.draft.body), setEditing(true)) : void writeWithAi())}>
              {item.draft ? 'Edit' : busy === 'ai' ? 'Writing…' : '✦ Write with AI'}
            </button>
          )}
          {editing && (
            <button className="btn btn-sm ai-btn" disabled={busy !== null} onClick={() => void writeWithAi()}>
              {busy === 'ai' ? 'Writing…' : '✦ Rewrite with AI'}
            </button>
          )}
          <span style={{ flex: 1 }} />
          {item.kind === 'reply' ? (
            <button className="btn btn-ghost" disabled={busy !== null} onClick={() => void run('handled', () => api.markConversationHandled(item.threadId))}>
              No reply needed
            </button>
          ) : (
            <button className="btn btn-ghost" disabled={busy !== null} onClick={() => void run('skip', () => api.discardWaitingDraft(item.threadId))}>
              {item.draft?.type === 'check_in' ? "Don't check in" : item.draft?.type === 'grant_note' ? "Don't send" : "Don't follow up"}
            </button>
          )}
          <button className="btn btn-ghost" onClick={onOpen}>
            Open {firstName(item.person.name)} →
          </button>
        </footer>
      )}
    </motion.article>
  );
}

// --- Everyone: person cards -------------------------------------------------------------------------

function Everyone({ tick, onOpen }: { tick: number; onOpen: (email: string) => void }) {
  const [filter, setFilter] = useState<'all' | 'leads' | 'new'>('all');
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(
      () =>
        api
          .people(filter, q)
          .then((r) => alive && (setPeople(r.items), setError(null)))
          .catch((e) => alive && setError(e instanceof Error ? e.message : 'Could not load')),
      q ? 250 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [filter, q, tick]);

  return (
    <section className="everyone">
      <div className="everyone-head">
        <h2>Everyone</h2>
        <div className="row" style={{ gap: 6 }}>
          {(['all', 'leads', 'new'] as const).map((f) => (
            <button key={f} className={`chip${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'leads' ? 'Leads' : 'Not in CRM'}
            </button>
          ))}
        </div>
        <div className="conv-search" style={{ margin: 0, flex: '0 1 280px' }}>
          <Icon name="search" size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people, emails, institutes" />
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      {!people && !error && <Loading />}
      {people?.length === 0 && <p className="muted">{q || filter !== 'all' ? 'Nobody matches.' : 'No mail yet.'}</p>}
      <div className="people-grid">
        <AnimatePresence mode="popLayout" initial={false}>
          {people?.map((p) => (
            <motion.button key={p.email} {...cardMotion} className={`person-card${p.overdue ? ' late' : p.needsReply ? ' waiting' : ''}`} onClick={() => onOpen(p.email)}>
              <div className="person-card-top">
                <Avatar name={p.name} email={p.email} size={42} />
                <div style={{ minWidth: 0 }}>
                  <strong className="person-name">{p.name}</strong>
                  <div className="muted small person-inst">{p.institution ? shortInstitute(p.institution) : p.email}</div>
                </div>
              </div>
              <div className="person-card-state">
                {p.overdue > 0 ? (
                  <span className="qstatus late">Overdue · {waitedFor(p.waitingSince)}</span>
                ) : p.needsReply > 0 ? (
                  <span className="qstatus waiting">Waiting on you</span>
                ) : p.drafts > 0 ? (
                  <span className="qstatus followup">✦ Draft ready</span>
                ) : (
                  <span className="muted small">{p.lastDirection === 'outbound' ? 'Waiting on them' : 'Up to date'}</span>
                )}
                <span className="muted small">{p.lastAt ? relativeTime(p.lastAt) : ''}</span>
              </div>
              <div className="person-card-tags">
                {!p.leadId && <span className="tag-new">Not in CRM</span>}
                {p.autoReply && <span className="tag-auto">Auto-reply</span>}
                {p.doNotContact && <span className="tag-dnc">Do not contact</span>}
                {p.unread > 0 && <span className="pbadge unread">{p.unread} new</span>}
                <span className="muted small" style={{ marginLeft: 'auto' }}>
                  {p.conversations} topic{p.conversations === 1 ? '' : 's'}
                </span>
              </div>
            </motion.button>
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}

// --- Person page: one timeline, grouped by topic ----------------------------------------------------

const lastActivity = (t: EmailThread) => new Date(t.messages.at(-1)?.sentAt ?? t.draftCreatedAt ?? t.createdAt).getTime();
const isWaiting = (t: EmailThread) => Boolean(t.awaitingReplySince && t.status !== 'closed');

function PersonPage({ email, tick, onBack, onChanged }: { email: string; tick: number; onBack: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const [data, setData] = useState<PersonDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [showOld, setShowOld] = useState(false);
  const [activeTopic, setActiveTopic] = useState<string | null>(null);
  // The banner stays pinned; its live height tells the topic list and jump targets where to sit below it.
  const [profileH, setProfileH] = useState(140);
  const profileRef = (el: HTMLElement | null) => {
    if (!el) return;
    const ro = new ResizeObserver(() => setProfileH(el.offsetHeight));
    ro.observe(el);
  };

  useEffect(() => {
    let alive = true;
    api
      .person(email)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e instanceof Error ? e.message : 'Could not load'));
    return () => {
      alive = false;
    };
  }, [email, tick, version]);

  // Opening the person reads their new mail.
  const unreadKey = data?.threads.filter((t) => t.messages.some((m) => m.direction === 'inbound' && !m.readAt)).map((t) => t.id).join() ?? '';
  useEffect(() => {
    if (!unreadKey) return;
    void Promise.all(unreadKey.split(',').map((id) => api.markConversationRead(id))).then(() => onChanged());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadKey]);

  const reload = () => {
    setVersion((n) => n + 1);
    onChanged();
  };
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update');
    } finally {
      setBusy(false);
    }
  };

  // Topics needing you first, then the rest by latest activity; closed ones folded away.
  const topics = useMemo(() => {
    const all = [...(data?.threads ?? [])].sort((a, b) => Number(isWaiting(b) || b.status === 'draft') - Number(isWaiting(a) || a.status === 'draft') || lastActivity(b) - lastActivity(a));
    return { active: all.filter((t) => t.status !== 'closed'), closed: all.filter((t) => t.status === 'closed') };
  }, [data]);

  if (error && !data) return <ErrorBanner message={error} />;
  if (!data) return <Loading />;
  const p = data.person;
  const jump = (id: string) => {
    if (topics.closed.some((t) => t.id === id)) setShowOld(true);
    setActiveTopic(id);
    // After a closed topic unfolds, the section exists to scroll to.
    requestAnimationFrame(() => document.getElementById(`topic-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <div className="person-page" style={{ ['--profile-h' as string]: `${profileH}px` }}>
      {error && <ErrorBanner message={error} />}
      <header className="profile" ref={profileRef}>
        <button className="icon-btn profile-back" onClick={onBack} title="Back to Conversations">
          ←
        </button>
        <Avatar name={p.name} email={p.email} size={64} />
        <div className="profile-main">
          <h1>{p.name}</h1>
          <div className="muted">{[p.title, p.department, p.institution].filter(Boolean).join(' · ') || p.email}</div>
          <div className="profile-meta">
            <span className="mono small">{p.email}</span>
            {p.phone && <span className="small">{p.phone}</span>}
            {data.lead ? (
              <>
                <StatusBadge status={data.lead.status} />
                {data.lead.score !== undefined && data.lead.score !== null && <ScorePill score={data.lead.score} />}
                {data.lead.products.length > 0 && <span className="small muted">Fits: {data.lead.products.join(', ')}</span>}
              </>
            ) : (
              <span className="tag-new">Not in CRM</span>
            )}
          </div>
        </div>
        <div className="profile-actions">
          {data.lead ? (
            <Link className="btn btn-sm" to={`/leads?status=all&open=${data.lead.id}`}>
              Open lead
            </Link>
          ) : (
            can('sales') && (
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act(() => api.personToLead(p.email))}>
                Add to CRM
              </button>
            )
          )}
          {can('sales') && (
            <>
              <label className="switch-row" title="If a reply is overdue, a short holding message goes out automatically (it never promises or confirms anything) and the team is told.">
                <input type="checkbox" checked={p.autoReply} disabled={busy || p.doNotContact} onChange={(e) => void act(() => api.setAutoReply(p.email, e.target.checked))} />
                Auto-reply when overdue
              </label>
              <label className="switch-row">
                <input type="checkbox" checked={p.doNotContact} disabled={busy} onChange={(e) => void act(() => api.setDoNotContact(p.email, e.target.checked))} />
                Do not contact
              </label>
              <label className="switch-row" title="Default follows the Auto/Manual switch on the Conversations page.">
                Follow-ups
                <select value={p.followUpMode ?? ''} disabled={busy || p.doNotContact} onChange={(e) => void act(() => api.setPersonFollowUpMode(p.email, (e.target.value || null) as 'auto' | 'manual' | null))}>
                  <option value="">Default</option>
                  <option value="auto">Always auto</option>
                  <option value="manual">Never auto</option>
                </select>
              </label>
            </>
          )}
        </div>
      </header>

      <div className="person-body">
      <nav className="topic-nav" aria-label="Topics">
        <div className="topic-nav-title">Topics</div>
        {[...topics.active, ...topics.closed].map((t) => {
          const waiting = isWaiting(t);
          const overdue = waiting && Date.now() - new Date(t.awaitingReplySince!).getTime() > 48 * 3_600_000;
          return (
            <button key={t.id} className={`topic-link${activeTopic === t.id ? ' active' : ''}${t.status === 'closed' ? ' closed' : ''}`} onClick={() => jump(t.id)}>
              <span className={`topic-dot${overdue ? ' late' : waiting ? ' waiting' : t.status === 'draft' ? ' draft' : ''}`} />
              <span className="topic-link-text">{t.subjectLine.replace(/^(re|fwd?):\s*/i, '')}</span>
              <span className="topic-link-when">{relativeTime(new Date(lastActivity(t)).toISOString())}</span>
            </button>
          );
        })}
      </nav>
      <div className="timeline">
        {topics.active.map((t) => (
          <TopicSection key={t.id} thread={t} person={p} onChanged={reload} />
        ))}
        {topics.active.length === 0 && <p className="muted">No open conversations.</p>}
        {topics.closed.length > 0 && (
          <div className="closed-topics">
            <button className="link-btn small" onClick={() => setShowOld(!showOld)}>
              {showOld ? 'Hide' : 'Show'} {topics.closed.length} closed conversation{topics.closed.length === 1 ? '' : 's'}
            </button>
            {showOld && topics.closed.map((t) => <TopicSection key={t.id} thread={t} person={p} onChanged={reload} />)}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

function TopicSection({ thread: t, person, onChanged }: { thread: EmailThread; person: PersonDetail['person']; onChanged: () => void }) {
  const { can } = useAuth();
  const waiting = isWaiting(t);
  const overdue = waiting && Date.now() - new Date(t.awaitingReplySince!).getTime() > 48 * 3_600_000;
  const hasDraft = t.status === 'draft' && Boolean(t.draftBody);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allShown, setAllShown] = useState(false);
  // Long topics show their last few emails; the rest fold away.
  const msgs = allShown ? t.messages : t.messages.slice(-4);

  const run = async (kind: string, fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      setText('');
      setOpen(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };
  const suggest = async () => {
    setBusy('ai');
    setError(null);
    try {
      setText((await api.aiDraftReply(t.id)).body);
      setOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The AI could not write it');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section id={`topic-${t.id}`} className={`topic${overdue ? ' late' : waiting ? ' waiting' : ''}${t.status === 'closed' ? ' closed' : ''}`}>
      <header className="topic-head">
        <div style={{ minWidth: 0 }}>
          <h3>{t.subjectLine.replace(/^(re|fwd?):\s*/i, '')}</h3>
          <span className="muted small">
            {t.messages.length} email{t.messages.length === 1 ? '' : 's'} · last {relativeTime(new Date(lastActivity(t)).toISOString())}
            {t.status === 'closed' && t.closedReason ? ` · closed (${t.closedReason.replace(/_/g, ' ')})` : ''}
          </span>
        </div>
        {waiting ? (
          <span className={`qstatus ${overdue ? 'late' : 'waiting'}`}>{overdue ? `Overdue · ${waitedFor(t.awaitingReplySince)}` : `Waiting on you · ${waitedFor(t.awaitingReplySince)}`}</span>
        ) : hasDraft ? (
          <span className="qstatus followup">✦ Draft ready</span>
        ) : t.status !== 'closed' && t.messages.at(-1)?.direction === 'outbound' ? (
          <span className="muted small">Waiting on them</span>
        ) : null}
      </header>

      {t.messages.length > msgs.length && (
        <button className="link-btn small topic-more" onClick={() => setAllShown(true)}>
          Show {t.messages.length - msgs.length} earlier email{t.messages.length - msgs.length === 1 ? '' : 's'}
        </button>
      )}
      <ol className="tl">
        {msgs.map((m) => (
          <TimelineItem key={m.messageId} m={m} name={person.name} />
        ))}
      </ol>

      {t.autoReplyDueAt && <div className="topic-note">Holding reply goes out {clock(t.autoReplyDueAt)} unless someone answers first.</div>}

      {hasDraft && !open && (
        <div className="queue-draft" style={{ margin: '10px 0 0' }}>
          <div className="queue-draft-label">✦ AI draft {t.draftType === 'response' ? '— reply' : t.draftType?.startsWith('follow_up') ? '— follow-up' : t.draftType === 'check_in' ? '— check-in' : t.draftType === 'grant_note' ? '— new grant' : ''}</div>
          <div className="queue-draft-body">{t.draftBody}</div>
          {can('sales') && (
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <button className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void run('send', () => api.sendWaitingDraft(t.id))}>
                {busy === 'send' ? 'Sending…' : 'Send'}
              </button>
              <button className="btn btn-sm" disabled={busy !== null} onClick={() => (setText(t.draftBody!), setOpen(true))}>
                Edit
              </button>
              <button className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => void run('discard', () => api.discardWaitingDraft(t.id))}>
                Discard draft
              </button>
            </div>
          )}
        </div>
      )}

      {error && <div className="composer-error" style={{ marginTop: 10 }}>{error}</div>}

      {can('sales') && t.status !== 'closed' && (
        <div className="topic-reply">
          {open ? (
            <>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(14, Math.max(4, text.split('\n').length + 1))} placeholder={`Reply to ${firstName(person.name)} about this…`} autoFocus />
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <button className="btn btn-primary btn-sm" disabled={!text.trim() || busy !== null} onClick={() => void run('send', () => api.replyOnConversation(t.id, text))}>
                  {busy === 'send' ? 'Sending…' : 'Send reply'}
                </button>
                <button className="btn btn-sm ai-btn" disabled={busy !== null} onClick={() => void suggest()}>
                  {busy === 'ai' ? 'Writing…' : '✦ Draft with AI'}
                </button>
                <span style={{ flex: 1 }} />
                <button className="btn btn-sm btn-ghost" onClick={() => (setOpen(false), setText(''))}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-sm" onClick={() => setOpen(true)}>
                Reply
              </button>
              {!hasDraft && (
                <button className="btn btn-sm ai-btn" disabled={busy !== null} onClick={() => void suggest()}>
                  {busy === 'ai' ? 'Writing…' : '✦ Draft with AI'}
                </button>
              )}
              {waiting && (
                <button className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => void run('handled', () => api.markConversationHandled(t.id))}>
                  No reply needed
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function TimelineItem({ m, name }: { m: EmailThread['messages'][number]; name: string }) {
  const [open, setOpen] = useState(false);
  const ours = m.direction === 'outbound';
  const who = ours
    ? m.type === 'campaign'
      ? 'Campaign'
      : m.sentBy === 'auto-reply'
        ? 'Holding reply (automatic)'
        : m.sentBy === 'auto-followup'
          ? 'You · follow-up (automatic)'
        : m.sentBy === 'gmail'
          ? 'You, from Gmail'
          : m.type.startsWith('follow_up')
            ? 'You · follow-up'
            : m.type === 'initial_outreach'
              ? 'You · first email'
              : 'You'
    : firstName(name);
  const long = m.bodyText.length > 360;
  return (
    <motion.li {...cardMotion} className={`tl-item ${ours ? 'ours' : 'theirs'}`}>
      <span className="tl-dot" />
      <div className="tl-card">
        <div className="tl-meta">
          <strong>{who}</strong>
          {!ours && m.intent && m.intent !== 'other' && <span className="intent-pill">{INTENT_LABEL[m.intent]}</span>}
          <span className="muted small">{new Date(m.sentAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>
        </div>
        <div className={`tl-body${long && !open ? ' clamped' : ''}`}>{m.bodyText}</div>
        {long && (
          <button className="link-btn small" onClick={() => setOpen(!open)}>
            {open ? 'Show less' : 'Show all'}
          </button>
        )}
        {m.attachments?.length ? (
          <div className="bubble-files">
            {m.attachments.map((a) => (
              <span key={a.filename} className="file-pill">📎 {a.filename}</span>
            ))}
          </div>
        ) : null}
      </div>
    </motion.li>
  );
}

// --- New message ------------------------------------------------------------------------------------

function ComposeModal({ to: initialTo, onClose, onSent }: { to: string; onClose: () => void; onSent: (email: string) => void }) {
  const [to, setTo] = useState(initialTo);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.composeMessage({ to, subject, body });
      onSent(to.trim().toLowerCase());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose}>
      <h2 style={{ marginTop: 0 }}>New message</h2>
      {error && <ErrorBanner message={error} />}
      <div style={{ display: 'grid', gap: 12 }}>
        <label className="field">
          <span>To</span>
          <input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@institute.ac.in" autoFocus />
        </label>
        <label className="field">
          <span>Subject</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <label className="field">
          <span>Message</span>
          <textarea rows={9} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !to || !subject.trim() || !body.trim()} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </Modal>
  );
}
