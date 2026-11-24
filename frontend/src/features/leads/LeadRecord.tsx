import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Drawer, Tabs } from '../../components/ui';
import { useAuth } from '../../auth/AuthProvider';
import { api } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import {
  AffiliationNote,
  ErrorBanner,
  FundingList,
  InstrumentBadge,
  Loading,
  ScorePill,
  SourceBadge,
  StatusBadge,
  formatDate,
} from '../../components/common';

type LeadTab = 'overview' | 'research' | 'instruments' | 'funding' | 'emails';

/**
 * One lead, as a side panel with top tabs (expand → full-screen overlay).
 * `onChanged` lets the list behind it refresh after an approve, send or edit.
 */
export function LeadRecord({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged?: () => void }) {
  const { can } = useAuth();
  const [tab, setTab] = useState<LeadTab>('overview');
  const [expanded, setExpanded] = useState(false);
  const { data: lead, loading, error, reload: reloadLead } = useAsync(() => api.getLead(id), [id]);
  const reload = () => {
    reloadLead();
    onChanged?.();
  };
  const { data: scanCost } = useAsync(() => api.scanInstrumentsEstimate(), []);
  const { data: backfillUsage } = useAsync(() => api.backfillAiUsage(), []);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichNote, setEnrichNote] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [threadBusyId, setThreadBusyId] = useState<string | null>(null);
  const [threadNote, setThreadNote] = useState<string | null>(null);

  /**
   * Asks OpenAlex about this researcher's own papers, brand by brand. The
   * discovery run only sees the paper or two of theirs that ranked for a
   * query; this is how the rest of their instruments get attached.
   */
  async function scanInstruments() {
    if (!lead) return;
    setScanning(true);
    setActionError(null);
    setScanNote(null);
    try {
      const result = await api.scanInstruments(lead.id);
      const names = [...new Set(result.found.map((i) => i.model ?? i.brand))];
      setScanNote(
        (names.length > 0
          ? `Found: ${names.join(', ')}.`
          : 'No instrument brand appears in the full text of this researcher\u2019s recent papers.') +
          ` ${result.queriesIssued} queries (~${result.queriesIssued * 10} credits).` +
          (result.stoppedEarly ? ` Stopped early: ${result.stoppedEarly}` : ''),
      );
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  }

  async function review(decision: 'approved' | 'rejected') {
    if (!lead) return;

    // Rejections carry a reason so the review queue stays auditable.
    let reason: string | undefined;
    if (decision === 'rejected') {
      reason = window.prompt('Why is this lead being rejected? (optional)') ?? undefined;
    }

    setBusy(true);
    setActionError(null);
    try {
      await api.reviewLead(lead.id, decision, reason);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not record the decision');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!lead) return;
    if (!window.confirm(`Delete ${lead.person.name}? This cannot be undone.`)) return;

    setBusy(true);
    try {
      await api.deleteLead(lead.id);
      onChanged?.();
      onClose();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not delete the lead');
      setBusy(false);
    }
  }

  if (!lead) {
    return (
      <Drawer title="Lead" expanded={expanded} onToggleExpand={() => setExpanded(!expanded)} onClose={onClose}>
        {loading ? <Loading /> : error ? <ErrorBanner message={error} /> : null}
      </Drawer>
    );
  }

  const signals = lead.aiScoring.qualificationSignals;
  const instruments = lead.research.instruments ?? [];
  // Sightings flagged for review (a bare brand in a paper that is not electrochemistry) do not count as ownership.
  const confirmed = instruments.filter((i) => !i.needsReview);
  const hasClassOneBrand = confirmed.some((i) => i.vendor === 'classone');
  const hasCompetitor = confirmed.some((i) => i.vendor === 'competitor');
  const canScan = /A\d{6,}/.test(`${lead.person.profileUrl ?? ''} ${lead.source.sourceRecordId ?? ''}`);


  /**
   * Profile page → email/designation/phone; ORCID → lab site; lab site →
   * facilities pages; open-access papers → Methods section. Fills blanks only.
   */
  async function enrichFromWeb() {
    if (!lead) return;
    setEnriching(true);
    setActionError(null);
    setEnrichNote(null);
    try {
      const r = await api.enrichLeadFromWeb(lead.id);
      const parts: string[] = [];
      if (r.filled.length > 0) parts.push(`Filled ${r.filled.join(', ')}.`);
      const names = [...new Set(r.instrumentsFound.map((i) => i.model ?? i.brand))];
      if (names.length > 0) parts.push(`Instruments: ${names.join(', ')}.`);
      parts.push(
        `${r.pagesVisited} page${r.pagesVisited === 1 ? '' : 's'} read` +
          (r.papers.considered > 0
            ? `; ${r.papers.openAccess} of ${r.papers.considered} papers open access, ${r.papers.read} read`
            : '') +
          '.',
      );
      if (r.errors.length > 0) parts.push(`${r.errors.length} page${r.errors.length === 1 ? '' : 's'} could not be fetched.`);
      if (r.filled.length === 0 && names.length === 0) parts.unshift('Nothing new found.');
      setEnrichNote(parts.join(' '));
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Enrichment failed');
    } finally {
      setEnriching(false);
    }
  }

  /** Gemini web-search backfill — only reaches for whatever ORCID/the scraper above could not find. Needs the billed key. */
  async function backfillAi() {
    if (!lead) return;
    setBackfilling(true);
    setActionError(null);
    setEnrichNote(null);
    try {
      const r = await api.backfillLeadAi(lead.id);
      setEnrichNote(
        r.filled.length > 0
          ? `Gemini filled ${r.filled.join(', ')}.${r.sources.length > 0 ? ` Sources: ${r.sources.slice(0, 3).join(', ')}` : ''}`
          : 'Gemini found nothing new.',
      );
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Backfill failed');
    } finally {
      setBackfilling(false);
    }
  }

  /** Drafts (or refreshes) this lead's next outreach message. Never sends — see the Outreach page. */
  async function draftOutreachNow() {
    if (!lead) return;
    setDrafting(true);
    setActionError(null);
    setThreadNote(null);
    try {
      await api.draftOutreach(lead.id);
      setThreadNote('Drafted — review and send it from the Outreach page.');
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not draft outreach');
    } finally {
      setDrafting(false);
    }
  }

  async function approveThread(threadId: string) {
    setThreadBusyId(threadId);
    setActionError(null);
    setThreadNote(null);
    try {
      await api.approveSendOutreach(threadId);
      setThreadNote('Sent.');
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not send this draft');
    } finally {
      setThreadBusyId(null);
    }
  }

  async function discardThreadDraft(threadId: string) {
    if (!window.confirm('Discard this draft without sending it?')) return;
    setThreadBusyId(threadId);
    setActionError(null);
    try {
      await api.rejectDraft(threadId);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not discard this draft');
    } finally {
      setThreadBusyId(null);
    }
  }

  async function markThreadReplied(threadId: string) {
    setThreadBusyId(threadId);
    setActionError(null);
    try {
      await api.markReplied(threadId);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not record the reply');
    } finally {
      setThreadBusyId(null);
    }
  }

  async function verifyNow(deep = false) {
    if (!lead) return;
    setVerifying(true);
    setActionError(null);
    try {
      const r = await api.verifyAffiliation(lead.id, deep);
      setEnrichNote(
        r.assessment
          ? `Affiliation check: ${r.assessment.status === 'current' ? 'still at ' + (r.lead.institution.name ?? 'this institute') : r.assessment.status === 'moved' ? 'moved to ' + (r.lead.institution.name ?? '?') : r.assessment.status === 'conflict' ? 'needs review — the sources disagree (see the note on Institution)' : 'current institute could not be established — cleared'}.`
          : 'OpenAlex has no affiliation record for this author.',
      );
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setVerifying(false);
    }
  }

  const enrichButton = (
    <button
      className="btn btn-sm"
      onClick={enrichFromWeb}
      disabled={enriching}
      title="Read the institute profile page, ORCID, the lab website and open-access papers. Fills only blank fields; no OpenAlex credits."
    >
      {enriching ? 'Reading web pages…' : 'Enrich from web'}
    </button>
  );

  const stillMissing = (['email', 'title', 'department', 'phone', 'websiteUrl'] as const).filter((f) =>
    f === 'department' ? !lead.institution.department : !lead.person[f],
  );

  const backfillButton = (
    <button
      className="btn btn-sm"
      onClick={backfillAi}
      disabled={backfilling || stillMissing.length === 0}
      title={
        stillMissing.length === 0
          ? 'Nothing missing — email, title, department, phone and website are all set'
          : `Web-search for: ${stillMissing.join(', ')}. Needs a billed Gemini key — free past ${backfillUsage?.freeAllowance ?? 5000} searches/month, then $14 per 1,000.`
      }
    >
      {backfilling
        ? 'Searching…'
        : `Find missing info (AI)${backfillUsage?.overFreeAllowance ? ` — ~$${backfillUsage.estimatedMonthCostUsd.toFixed(2)} this month` : ''}`}
    </button>
  );

  const scanButton = (
    <button
      className="btn btn-sm"
      onClick={scanInstruments}
      disabled={scanning || !canScan}
      title={
        canScan
          ? 'Search the full text of every recent paper by this researcher for instrument brands and models'
          : 'Needs an OpenAlex author record — set the profile URL to their OpenAlex author page'
      }
    >
      {scanning
        ? 'Scanning papers…'
        : `Scan all papers for instruments${scanCost ? ` (${scanCost.min}–${scanCost.max} credits)` : ''}`}
    </button>
  );

  return (
    <Drawer
      title={lead.person.name}
      subtitle={
        <>
          {lead.person.title && `${lead.person.title} · `}
          {lead.institution.name ?? 'Institution unknown'}{' '}
          <AffiliationNote affiliation={lead.institution.affiliation} institutionName={lead.institution.name} />
        </>
      }
      expanded={expanded}
      onToggleExpand={() => setExpanded(!expanded)}
      onClose={onClose}
      actions={
        <>
          <StatusBadge status={lead.status} />
          {lead.status === 'pending_review' && can('sales') && (
            <>
              <button className="btn btn-success btn-sm" disabled={busy} onClick={() => review('approved')}>
                Approve
              </button>
              <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => review('rejected')}>
                Reject
              </button>
            </>
          )}
          <span style={{ flex: 1 }} />
          {can('sales') && enrichButton}
          {can('sales') && backfillButton}
          {can('admin') && (
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={remove}>
              Delete
            </button>
          )}
        </>
      }
      tabs={
        <Tabs
          items={[
            { key: 'overview', label: 'Overview' },
            { key: 'research', label: 'Research' },
            { key: 'instruments', label: 'Instruments', count: instruments.length || undefined },
            { key: 'funding', label: 'Funding' },
            { key: 'emails', label: 'Emails', count: lead.threads.length || undefined },
          ]}
          value={tab}
          onChange={setTab}
        />
      }
    >
      {actionError && <ErrorBanner message={actionError} />}
      {enrichNote && <div className="alert alert-info">{enrichNote}</div>}

      {tab === 'research' && (
          <section className="card card-pad">
            <h2 className="section-title">Research</h2>
            {lead.research.summary ? (
              <p style={{ margin: 0 }}>{lead.research.summary}</p>
            ) : (
              <p className="muted small" style={{ margin: 0 }}>
                No summary yet. Phase 2 discovery generates this automatically from the
                researcher's published work.
              </p>
            )}

            {lead.research.topics.length > 0 && (
              <div style={{ marginTop: 14 }}>
                {lead.research.topics.map((topic) => (
                  <span key={topic} className="tag">
                    {topic}
                  </span>
                ))}
              </div>
            )}

            {lead.research.recentPublications.length > 0 && (
              <>
                <h3 className="section-title" style={{ marginTop: 20 }}>
                  Recent publications
                </h3>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {lead.research.recentPublications.map((pub, i) => (
                    <li key={i} className="small">
                      {pub.url ? (
                        <a href={pub.url} target="_blank" rel="noreferrer">
                          {pub.title}
                        </a>
                      ) : (
                        pub.title
                      )}
                      {pub.year && <span className="muted"> ({pub.year})</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
      )}
      {tab === 'instruments' && (
          <section className="card card-pad">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <h2 className="section-title" style={{ marginBottom: 0 }}>
                Instruments in use
              </h2>
              {scanButton}
            </div>
            {scanNote && (
              <div className="alert alert-info" style={{ marginTop: 10 }}>
                {scanNote}
              </div>
            )}
            {instruments.length === 0 ? (
              <p className="muted small" style={{ marginBottom: 0, marginTop: 10 }}>
                None identified yet. Discovery tags what the paper it found happened to show; the
                scan reads the full text of every recent paper by this researcher.
              </p>
            ) : (
              <>
              <p className="muted small" style={{ marginTop: 10 }}>
                {confirmed.length === 0
                  ? 'Only unconfirmed brand mentions so far — check the papers below before treating this as ownership.'
                  : hasClassOneBrand && hasCompetitor
                  ? 'Uses both a Class One brand and competitor equipment — an upgrade and displacement opportunity.'
                  : hasClassOneBrand
                    ? 'Already uses a Class One brand — an existing user; think upgrade, multi-channel or accessories.'
                    : 'Uses competitor equipment — a proven buyer of potentiostats; a displacement or second-instrument opportunity.'}
              </p>
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 10 }}>
                {instruments.map((inst, i) => (
                  <li key={`${inst.brandKey}-${inst.model ?? ''}-${i}`}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <strong>{inst.model ?? inst.brand}</strong>
                      {inst.model && <span className="muted small">{inst.brand}</span>}
                      <InstrumentBadge vendor={inst.vendor} />
                      {inst.needsReview && (
                        <span className="badge badge-pending" title="A bare brand name in a paper that does not read as electrochemistry — not counted as ownership until checked">
                          needs review
                        </span>
                      )}
                    </div>
                    <div className="muted small" style={{ marginTop: 2 }}>
                      {inst.evidence}
                      {inst.sourceUrl && (
                        <>
                          {' '}
                          <a href={inst.sourceUrl} target="_blank" rel="noreferrer">
                            source →
                          </a>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              </>
            )}
          </section>
      )}
      {tab === 'funding' && (
          <section className="card card-pad">
            <h2 className="section-title">Funding</h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              Funders and grant numbers acknowledged on recent papers; scheme and year are decoded from the grant number.
              Title, amount and status are not in acknowledgements — for SERB/ANRF grants, SERB-PRISM has them by file number.
            </p>
            <FundingList funding={lead.research.funding} checkedAt={lead.research.fundingCheckedAt} />
          </section>
      )}
      {tab === 'emails' && (
          <section className="card card-pad">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <h2 className="section-title" style={{ marginBottom: 0 }}>
                Email threads
              </h2>
              <button
                className="btn btn-sm"
                onClick={draftOutreachNow}
                disabled={drafting || !lead.person.email || lead.threads.some((t) => t.status === 'draft')}
                title={!lead.person.email ? 'Needs an email address first' : 'AI-drafts the next message — never sends'}
              >
                {drafting ? 'Drafting…' : 'Draft outreach'}
              </button>
            </div>
            {threadNote && (
              <div className="alert alert-success" style={{ marginTop: 10 }}>
                {threadNote}
              </div>
            )}
            {lead.threads.length === 0 ? (
              <p className="muted small" style={{ margin: '10px 0 0' }}>
                No outreach yet. "Draft outreach" writes the first-touch email — approve it on the{' '}
                <Link to="/outreach">Outreach page</Link> to send it.
              </p>
            ) : (
              <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
                {lead.threads.map((thread) => (
                  <div key={thread.id} className="card-pad" style={{ background: 'var(--surface-alt)', borderRadius: 'var(--radius)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                      <div>
                        <strong>{thread.subjectLine}</strong>
                        <div className="muted small">
                          {thread.status === 'draft' ? 'Pending draft' : thread.status} ·{' '}
                          {thread.messages.length} sent · {thread.followUp.attemptsSent}/{thread.followUp.maxAttempts} follow-ups
                        </div>
                      </div>
                      {thread.status === 'draft' && (
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                          <button className="btn btn-success btn-sm" disabled={threadBusyId === thread.id} onClick={() => approveThread(thread.id)}>
                            Approve & send
                          </button>
                          <button className="btn btn-danger btn-sm" disabled={threadBusyId === thread.id} onClick={() => discardThreadDraft(thread.id)}>
                            Discard
                          </button>
                        </div>
                      )}
                      {thread.status === 'open' && (
                        <button className="btn btn-sm" disabled={threadBusyId === thread.id} onClick={() => markThreadReplied(thread.id)}>
                          Mark replied
                        </button>
                      )}
                    </div>
                    {thread.status === 'draft' && thread.draftBody && (
                      <p className="small" style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>
                        {thread.draftBody}
                      </p>
                    )}
                    {thread.messages.length > 0 && (
                      <details style={{ marginTop: 8 }}>
                        <summary className="small muted" style={{ cursor: 'pointer' }}>
                          Message history ({thread.messages.length})
                        </summary>
                        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                          {thread.messages.map((m) => (
                            <li key={m.messageId} className="small" style={{ marginBottom: 6 }}>
                              <strong>{m.direction === 'outbound' ? 'Sent' : 'Received'}</strong> · {m.type} ·{' '}
                              {formatDate(m.sentAt)}
                              <div className="muted">{m.subject}</div>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
      )}
      {tab === 'overview' && (
        <div style={{ display: 'grid', gap: 28 }}>
          <section className="card card-pad">
            <h2 className="section-title">Contact</h2>
            <dl className="kv">
              <dt>Email</dt>
              <dd>
                {lead.person.email ? (
                  <a href={`mailto:${lead.person.email}`}>{lead.person.email}</a>
                ) : (
                  <span className="muted">—</span>
                )}
              </dd>
              <dt>Institution</dt>
              <dd>
                {lead.institution.name ?? <span className="muted">— (not confirmed)</span>}
                {lead.institution.affiliation && (
                  <div className="muted small" style={{ marginTop: 4 }}>
                    {lead.institution.affiliation.status === 'current' && 'Confirmed current'}
                    {lead.institution.affiliation.status === 'moved' &&
                      `Moved here from ${lead.institution.affiliation.previousInstitution ?? '?'}`}
                    {lead.institution.affiliation.status === 'conflict' &&
                      `Needs review — ${lead.institution.affiliation.note ?? 'the sources disagree'}`}
                    {lead.institution.affiliation.status === 'unknown' &&
                      `Last seen at ${lead.institution.affiliation.previousInstitution ?? '?'}${lead.institution.affiliation.lastSeenYear ? ` (${lead.institution.affiliation.lastSeenYear})` : ''}; no current institute on record`}
                    {' · '}
                    {(
                      { directory: 'institute directory', irins: 'IRINS', vidwan: 'Vidwan', orcid: 'ORCID', openalex: 'OpenAlex' } as Record<string, string>
                    )[lead.institution.affiliation.source] ?? lead.institution.affiliation.source}
                    , {formatDate(lead.institution.affiliation.verifiedAt)}
                    {lead.institution.affiliation.directoryListed === false && ' · not in the institute directory'}
                  </div>
                )}
                {!lead.institution.affiliation && (
                  <div className="muted small" style={{ marginTop: 4 }}>Not yet verified</div>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <button className="btn btn-sm" onClick={() => verifyNow(false)} disabled={verifying} title="OpenAlex + ORCID — free, seconds">
                    {verifying ? 'Checking…' : 'Verify now'}
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => verifyNow(true)}
                    disabled={verifying}
                    title="Also asks the institute directory and the IRINS/Vidwan registries — needs the scraper service, takes a minute"
                  >
                    Deep check
                  </button>
                </div>
                {(lead.institution.affiliation?.evidence?.length ?? 0) > 0 && (
                  <details style={{ marginTop: 8 }}>
                    <summary className="small muted" style={{ cursor: 'pointer' }}>
                      What each source said ({lead.institution.affiliation!.evidence!.length})
                    </summary>
                    <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                      {lead.institution.affiliation!.evidence!.map((e, i) => (
                        <li key={`${e.source}-${i}`}>
                          <strong>{e.source}</strong>:{' '}
                          {e.institution ? (
                            <>
                              {e.institution}
                              {e.current === true ? ' (current)' : ''}
                            </>
                          ) : (
                            <span className="muted">{e.detail ?? 'nothing found'}</span>
                          )}
                          {e.institution && e.detail && <span className="muted"> — {e.detail}</span>}
                          {e.url && (
                            <>
                              {' '}
                              <a href={e.url} target="_blank" rel="noreferrer">
                                source →
                              </a>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </dd>
              <dt>Department</dt>
              <dd>{lead.institution.department ?? '—'}</dd>
              <dt>Country</dt>
              <dd>{lead.institution.country ?? '—'}</dd>
              <dt>Profile</dt>
              <dd>
                {lead.person.profileUrl ? (
                  <a href={lead.person.profileUrl} target="_blank" rel="noreferrer">
                    View profile
                  </a>
                ) : (
                  <span className="muted">—</span>
                )}
              </dd>
              <dt>ORCID</dt>
              <dd className="mono">{lead.person.orcid ?? '—'}</dd>
              <dt>Phone</dt>
              <dd>{lead.person.phone ?? <span className="muted">—</span>}</dd>
              <dt>Lab website</dt>
              <dd>
                {lead.person.websiteUrl ? (
                  <a href={lead.person.websiteUrl} target="_blank" rel="noreferrer">
                    {lead.person.websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                  </a>
                ) : (
                  <span className="muted">—</span>
                )}
              </dd>
            </dl>
            {lead.research.webEnrichedAt && (
              <p className="muted small" style={{ margin: '10px 0 0' }}>
                Web enrichment last run {formatDate(lead.research.webEnrichedAt)}.
              </p>
            )}
          </section>

          <section className="card card-pad">
            <h2 className="section-title">AI qualification</h2>
            <dl className="kv">
              <dt>Relevance score</dt>
              <dd>
                <ScorePill score={lead.aiScoring.relevanceScore} />
              </dd>
              <dt>Product relevance</dt>
              <dd>{signals?.productRelevance ?? '—'}</dd>
              <dt>Institution</dt>
              <dd>{signals?.institutionalStrength ?? '—'}</dd>
              <dt>Recency</dt>
              <dd>{signals?.recency ?? '—'}</dd>
              <dt>Engagement</dt>
              <dd>{signals?.engagementPotential ?? '—'}</dd>
            </dl>

            {lead.aiScoring.relevanceReasoning && (
              <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
                {lead.aiScoring.relevanceReasoning}
              </p>
            )}

            {lead.aiScoring.recommendedProductIds.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="small muted" style={{ marginBottom: 6 }}>
                  Recommended products
                </div>
                {lead.aiScoring.recommendedProductIds.map((pid) => (
                  <span key={pid} className="tag">
                    {pid}
                  </span>
                ))}
              </div>
            )}

            {lead.aiScoring.relevanceScore === undefined && (
              <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
                Not scored yet — AI enrichment runs in Phase 2.
              </p>
            )}
          </section>

          <section className="card card-pad">
            <h2 className="section-title">Record</h2>
            <dl className="kv">
              <dt>Source</dt>
              <dd>
                <SourceBadge source={lead.source.type} />
              </dd>
              <dt>Discovered</dt>
              <dd>{formatDate(lead.source.discoveredAt)}</dd>
              <dt>Added</dt>
              <dd>{formatDate(lead.createdAt)}</dd>
              <dt>Follow-up</dt>
              <dd>{lead.followUpStatusSummary.replace(/_/g, ' ')}</dd>
              {lead.review.reviewedAt && (
                <>
                  <dt>Reviewed</dt>
                  <dd>
                    {formatDate(lead.review.reviewedAt)}
                    {lead.review.reviewedBy && ` by ${lead.review.reviewedBy}`}
                  </dd>
                </>
              )}
              {lead.review.rejectionReason && (
                <>
                  <dt>Reason</dt>
                  <dd>{lead.review.rejectionReason}</dd>
                </>
              )}
            </dl>
          </section>
        </div>
      )}
    </Drawer>
  );
}
