import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import {
  AffiliationNote,
  ErrorBanner,
  InstrumentBadge,
  Loading,
  ScorePill,
  SourceBadge,
  StatusBadge,
  formatDate,
} from '../../components/common';

export function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: lead, loading, error, reload } = useAsync(() => api.getLead(id!), [id]);
  const { data: scanCost } = useAsync(() => api.scanInstrumentsEstimate(), []);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichNote, setEnrichNote] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

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
      navigate('/leads');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not delete the lead');
      setBusy(false);
    }
  }

  if (loading && !lead) return <Loading />;
  if (error) return <ErrorBanner message={error} />;
  if (!lead) return null;

  const signals = lead.aiScoring.qualificationSignals;
  const instruments = lead.research.instruments ?? [];
  const hasClassOneBrand = instruments.some((i) => i.vendor === 'classone');
  const hasCompetitor = instruments.some((i) => i.vendor === 'competitor');
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

  async function verifyNow() {
    if (!lead) return;
    setVerifying(true);
    setActionError(null);
    try {
      const r = await api.verifyAffiliation(lead.id);
      setEnrichNote(
        r.assessment
          ? `Affiliation check: ${r.assessment.status === 'current' ? 'still at ' + (r.lead.institution.name ?? 'this institute') : r.assessment.status === 'moved' ? 'moved to ' + (r.lead.institution.name ?? '?') : 'current institute could not be established — cleared'}.`
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
      className="btn btn-sm btn-primary"
      onClick={enrichFromWeb}
      disabled={enriching}
      title="Read the institute profile page, ORCID, the lab website and open-access papers. Fills only blank fields; no OpenAlex credits."
    >
      {enriching ? 'Reading web pages…' : 'Enrich from web'}
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
    <>
      <div className="page-header">
        <div>
          <Link to="/leads" className="small">
            ← Back to leads
          </Link>
          <h1 style={{ marginTop: 6 }}>{lead.person.name}</h1>
          <p>
            {lead.person.title && `${lead.person.title} · `}
            {lead.institution.name ?? 'Institution unknown'}{' '}
            <AffiliationNote affiliation={lead.institution.affiliation} institutionName={lead.institution.name} />
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {enrichButton}
          <StatusBadge status={lead.status} />
          {lead.status === 'pending_review' && (
            <>
              <button
                className="btn btn-success btn-sm"
                disabled={busy}
                onClick={() => review('approved')}
              >
                Approve
              </button>
              <button
                className="btn btn-danger btn-sm"
                disabled={busy}
                onClick={() => review('rejected')}
              >
                Reject
              </button>
            </>
          )}
          <button className="btn btn-sm" disabled={busy} onClick={remove}>
            Delete
          </button>
        </div>
      </div>

      {actionError && <ErrorBanner message={actionError} />}
      {enrichNote && <div className="alert alert-info">{enrichNote}</div>}

      <div className="detail-grid">
        <div style={{ display: 'grid', gap: 18 }}>
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
                {hasClassOneBrand && hasCompetitor
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

          <section className="card card-pad">
            <h2 className="section-title">Email threads</h2>
            {lead.threads.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                No outreach yet. Threads appear here once the email system ships in Phase 3.
              </p>
            ) : (
              lead.threads.map((thread) => (
                <div key={thread.id} className="feed-item">
                  <span className="feed-dot" />
                  <span>
                    <strong>{thread.subjectLine}</strong>
                    <div className="muted small">
                      {thread.messages.length} message
                      {thread.messages.length === 1 ? '' : 's'} · {thread.status} ·{' '}
                      {thread.followUp.attemptsSent}/{thread.followUp.maxAttempts} follow-ups sent
                    </div>
                  </span>
                  <span className="feed-time">{formatDate(thread.createdAt)}</span>
                </div>
              ))
            )}
          </section>
        </div>

        <div style={{ display: 'grid', gap: 18 }}>
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
                    {lead.institution.affiliation.status === 'unknown' &&
                      `Last seen at ${lead.institution.affiliation.previousInstitution ?? '?'}${lead.institution.affiliation.lastSeenYear ? ` (${lead.institution.affiliation.lastSeenYear})` : ''}; no current institute on record`}
                    {' · '}
                    {lead.institution.affiliation.source === 'directory' ? 'institute directory' : 'OpenAlex'},{' '}
                    {formatDate(lead.institution.affiliation.verifiedAt)}
                    {lead.institution.affiliation.directoryListed === false && ' · not in the institute directory'}
                  </div>
                )}
                {!lead.institution.affiliation && (
                  <div className="muted small" style={{ marginTop: 4 }}>Not yet verified</div>
                )}
                <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={verifyNow} disabled={verifying}>
                  {verifying ? 'Checking…' : 'Verify now'}
                </button>
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
      </div>
    </>
  );
}
