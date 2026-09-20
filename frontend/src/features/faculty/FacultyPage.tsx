import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type RosterListParams } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import {
  AffiliationNote,
  EmptyState,
  ErrorBanner,
  InstrumentBadge,
  Loading,
  ScorePill,
  formatDate,
  shortInstitute,
} from '../../components/common';
import type { FacultyMember, RosterJob, RosterJobKind } from '../../types';

/**
 * Faculty roster — the five stages, run one after another, each as a
 * background job with live progress:
 *
 *   1 Build      ORCID + OpenAlex + faculty pages → every professor/scientist
 *                in the kept departments at the chosen institutes
 *   2 Verify     still there? movers shown at the new place, unknowns blanked
 *   3 Score      relevance from recent output (1 OpenAlex credit per person)
 *   4 Promote    above the threshold → CRM leads, with the instrument scan
 *   5 Fill       missing email / title / phone / website on the new leads
 *
 * Every stage asks before it runs and says what it will cost.
 */

const ROLE_LABELS: Record<string, string> = {
  professor: 'Professor',
  scientist: 'Scientist',
  officer: 'Officer / lab in-charge',
  fellow: 'Faculty fellow',
  inferred: 'Likely faculty (inferred)',
  unknown: 'Unknown',
  excluded: 'Excluded',
};

const STAGE_LABEL: Record<RosterJobKind, string> = {
  roster_build: '1 · Build roster',
  roster_verify: '2 · Verify affiliations',
  roster_score: '3 · Score relevance',
  roster_sweep: '3b · Instrument sweep',
  roster_promote: '4 · Promote to CRM',
  roster_fill: '5 · Fill missing info',
};

function InstitutePicker({
  options,
  selected,
  onChange,
}: {
  options: Array<{ id: string; name: string; kind: string }>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [filter, setFilter] = useState('');
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const term = filter.trim().toLowerCase();
  const matching = term ? options.filter((o) => o.name.toLowerCase().includes(term)) : options;
  const label = selected.length === 0 ? 'Choose institutes' : selected.length === 1 ? shortInstitute(options.find((o) => o.id === selected[0])?.name ?? '') : `${selected.length} institutes`;
  const PILOT = ['I162827531', 'I68891433', 'I24676775', 'I145894827', 'I94234084']; // Bombay, Delhi, Madras, Kharagpur, Kanpur

  return (
    <details className="dropdown">
      <summary className={`btn btn-sm${selected.length > 0 ? ' btn-primary' : ''}`}>{label} ▾</summary>
      <div className="dropdown-menu" style={{ minWidth: 380 }}>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name…" style={{ marginBottom: 8 }} />
        <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={() => onChange(PILOT)}>
            Pilot 5 (IIT B/D/M/KGP/K)
          </button>
          {['IIT', 'NIT', 'IIIT'].map((kind) => (
            <button key={kind} className="btn btn-sm" onClick={() => onChange([...new Set([...selected, ...options.filter((o) => o.kind === kind).map((o) => o.id)])])}>
              + all {kind}s
            </button>
          ))}
          <button className="btn btn-sm" onClick={() => onChange(options.map((o) => o.id))}>
            All 72
          </button>
          {selected.length > 0 && (
            <button className="btn btn-sm" onClick={() => onChange([])}>
              Clear
            </button>
          )}
        </div>
        {matching.map((inst) => (
          <label key={inst.id} className="dropdown-option">
            <input type="checkbox" checked={selected.includes(inst.id)} onChange={() => toggle(inst.id)} style={{ width: 'auto' }} />
            <span>
              {inst.name} <span className="muted small">({inst.kind})</span>
            </span>
          </label>
        ))}
      </div>
    </details>
  );
}

/** Live view of one job: stage line, progress bar, counters, last log lines. */
function JobPanel({ job, onCancel }: { job: RosterJob; onCancel: () => void }) {
  const running = job.status === 'running';
  const counters = Object.entries(job.counters);
  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <strong>{STAGE_LABEL[job.kind]}</strong>{' '}
          <span className={`badge ${job.status === 'running' ? 'badge-pending' : job.status === 'completed' ? 'badge-approved' : job.status === 'failed' ? 'badge-rejected' : 'badge-neutral'}`}>{job.status}</span>
          <div className="small muted" style={{ marginTop: 4 }}>
            {job.stage}
            {job.finishedAt ? ` · finished ${formatDate(job.finishedAt)}` : ` · started ${formatDate(job.startedAt)}`}
          </div>
        </div>
        {running && (
          <button className="btn btn-sm btn-danger" onClick={onCancel}>
            Stop after current item
          </button>
        )}
      </div>
      {job.progress !== undefined && (
        <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, marginTop: 10, overflow: 'hidden' }}>
          <div style={{ width: `${Math.round(job.progress * 100)}%`, height: '100%', background: job.status === 'failed' ? 'var(--danger)' : 'var(--accent)', transition: 'width .4s' }} />
        </div>
      )}
      {counters.length > 0 && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
          {counters.map(([k, v]) => (
            <span key={k} className="small">
              <strong>{v}</strong> <span className="muted">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
            </span>
          ))}
        </div>
      )}
      {job.error && <div className="alert alert-error" style={{ marginTop: 10, marginBottom: 0 }}>{job.error}</div>}
      {job.log.length > 0 && (
        <details style={{ marginTop: 10 }} open={running}>
          <summary className="small muted" style={{ cursor: 'pointer' }}>
            Log ({job.log.length})
          </summary>
          <pre className="small" style={{ margin: '6px 0 0', maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
            {job.log.slice(-60).map((l, i) => (
              <div key={i} style={{ color: l.level === 'error' ? 'var(--danger)' : l.level === 'warn' ? 'var(--warning, #b7791f)' : undefined }}>
                {l.message}
              </div>
            ))}
          </pre>
        </details>
      )}
    </div>
  );
}

function Stage({ n, title, children, hint }: { n: number; title: string; hint: string; children: ReactNode }) {
  return (
    <div className="card card-pad" style={{ flex: '1 1 280px', minWidth: 260 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="badge badge-neutral">{n}</span>
        <strong>{title}</strong>
      </div>
      <p className="small muted" style={{ margin: '6px 0 10px' }}>
        {hint}
      </p>
      {children}
    </div>
  );
}

export function FacultyPage() {
  const { data: config } = useAsync(() => api.rosterConfig(), []);
  const { data: summary, reload: reloadSummary } = useAsync(() => api.rosterSummary(), []);

  // Filters
  const [status, setStatus] = useState<string>('eligible');
  const [domain, setDomain] = useState('');
  const [role, setRole] = useState('');
  const [institutionId, setInstitutionId] = useState('');
  const [affiliation, setAffiliation] = useState('');
  const [tag, setTag] = useState('');
  const [scored, setScored] = useState<'' | 'yes' | 'no'>('');
  const [missing, setMissing] = useState('');
  const [q, setQ] = useState('');
  const [minScore, setMinScore] = useState(0);
  const [sort, setSort] = useState<'score' | 'name' | 'newest'>('score');
  const [page, setPage] = useState(1);
  const params: RosterListParams = {
    status: status || undefined,
    domain: domain || undefined,
    role: role || undefined,
    institutionId: institutionId || undefined,
    affiliation: affiliation || undefined,
    tag: tag || undefined,
    scored: scored || undefined,
    missing: missing || undefined,
    q: q || undefined,
    minScore: minScore > 0 ? minScore : undefined,
    sort,
    page,
    limit: 50,
  };
  const { data, loading, error, reload } = useAsync(() => api.listRoster(params), [status, domain, role, institutionId, affiliation, tag, scored, missing, q, minScore, sort, page]);

  // Stage controls
  const [institutes, setInstitutes] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>(['openalex', 'orcid', 'faculty_pages', 'vidwan']);
  const [includeInferred, setIncludeInferred] = useState(true);
  const [threshold, setThreshold] = useState<number>(40);
  const [identifyInstruments, setIdentifyInstruments] = useState(true);
  const [useScraper, setUseScraper] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Jobs: poll while any is running.
  const [jobs, setJobs] = useState<RosterJob[]>([]);
  const pollRef = useRef<number | null>(null);
  async function refreshJobs() {
    try {
      const { jobs: list } = await api.rosterJobs();
      // The list endpoint trims logs; fetch the full record for running ones.
      const full = await Promise.all(list.slice(0, 6).map((j) => (j.status === 'running' ? api.rosterJob(j.id).catch(() => j) : j)));
      setJobs(full);
      if (!full.some((j) => j.status === 'running')) {
        if (pollRef.current) window.clearInterval(pollRef.current);
        pollRef.current = null;
        reload();
        reloadSummary();
      }
    } catch {
      // Best effort.
    }
  }
  function startPolling() {
    void refreshJobs();
    if (!pollRef.current) pollRef.current = window.setInterval(refreshJobs, 2500);
  }
  useEffect(() => {
    startPolling();
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (config) setThreshold(config.defaultThreshold);
  }, [config]);

  async function run(label: string, confirmText: string, start: () => Promise<{ job: RosterJob }>) {
    setActionError(null);
    setNotice(null);
    if (!window.confirm(confirmText)) return;
    try {
      await start();
      setNotice(`${label} started — progress below.`);
      startPolling();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    }
  }

  const running = jobs.find((j) => j.status === 'running');
  const instituteNames = (ids: string[]) => ids.map((id) => shortInstitute(config?.institutions.find((i) => i.id === id)?.name ?? id)).join(', ');

  // --- Stage handlers -------------------------------------------------------
  const build = () => {
    if (institutes.length === 0) {
      setActionError('Choose at least one institute for the build.');
      return;
    }
    const srcText = sources.map((s) => ({ openalex: 'OpenAlex author lists (≈1 credit per 200 authors)', orcid: 'ORCID (free; one lookup per record, thousands per large institute — minutes to an hour)', faculty_pages: 'institute faculty pages via the scraper (page fetches, robots.txt honoured)', vidwan: 'Vidwan national researcher database — search by institute name, one profile page per person (sequential, ~1.5 s each; stops if Vidwan refuses)' })[s]).join('\n  • ');
    void run(
      'Roster build',
      `Build the faculty roster for ${institutes.length} institute${institutes.length === 1 ? '' : 's'}:\n${instituteNames(institutes)}\n\nSources:\n  • ${srcText}\n\nKeeps professors, scientists, officers${includeInferred ? ' and OpenAlex-only authors whose record reads as senior (tagged)' : ''} in chemistry, biology, biotech, chemical/biochemical/materials/energy engineering, plus civil/mechanical with corrosion work. Students, postdocs and adjuncts are dropped.\n\nRe-running is safe: known people are updated, not duplicated. Proceed?`,
      () => api.rosterBuild({ institutionIds: institutes, sources, includeInferredRoles: includeInferred }),
    );
  };

  const verify = () =>
    void run(
      'Verification',
      `Re-check every eligible and promoted member against ORCID and OpenAlex (free, cached)?\n\nMovers are shown at their new institute with the discovered one kept as "previous"; anyone outside the IIT/NIT/IIIT list is tagged outside-target; anyone nobody can place has the institute blanked. Members checked in the last 30 days are skipped.`,
      () => api.rosterVerify({ freshDays: 30 }),
    );

  const score = async (rescore: boolean) => {
    setActionError(null);
    let est: { members: number; withOpenAlex: number; credits: number };
    try {
      est = await api.rosterScoreEstimate(rescore);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
      return;
    }
    void run(
      'Scoring',
      `Score ${est.members} member${est.members === 1 ? '' : 's'}${rescore ? ' (including already-scored ones)' : ' not yet scored'}.\n\nCost: ${est.credits} OpenAlex credits (one filter call per person with an OpenAlex record — ${est.withOpenAlex} of them; the rest are scored from ORCID titles or get 0). The daily allowance is 10,000; if it runs out the job stops and can be resumed tomorrow.\n\nProceed?`,
      () => api.rosterScore({ rescore }),
    );
  };

  const promote = async () => {
    setActionError(null);
    let est: { candidates: number; byInstrument: number; withOpenAlex: number; scanCreditsPerLead: { min: number; max: number } };
    try {
      est = await api.rosterPromoteEstimate(threshold);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
      return;
    }
    const scanCost = identifyInstruments ? `\n\nInstrument identification: ${est.scanCreditsPerLead.min}–${est.scanCreditsPerLead.max} credits per lead × ${est.withOpenAlex} leads with an OpenAlex record = ${est.scanCreditsPerLead.min * est.withOpenAlex}–${est.scanCreditsPerLead.max * est.withOpenAlex} credits. Stops cleanly if the allowance runs out.` : '\n\nInstrument identification is off — no credits.';
    void run(
      'Promotion',
      `Promote ${est.candidates} member${est.candidates === 1 ? '' : 's'} into the CRM as pending-review leads: everyone scoring ${threshold} or above, plus ${est.byInstrument} instrument owner${est.byInstrument === 1 ? '' : 's'} below that score.${scanCost}\n\nProceed?`,
      () => api.rosterPromote({ threshold, identifyInstruments }),
    );
  };

  const sweep = async () => {
    setActionError(null);
    const ids = institutes.length > 0 ? institutes : [...new Set((summary?.byInstitution ?? []).map((i) => config?.institutions.find((c) => c.name === i.name)?.id).filter((x): x is string => Boolean(x)))];
    if (ids.length === 0) {
      setActionError('Choose the institutes to sweep (stage 1 picker), or build a roster first.');
      return;
    }
    let est: { min: number; max: number; brands: number };
    try {
      est = await api.rosterSweepEstimate(ids.length);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
      return;
    }
    void run(
      'Instrument sweep',
      `Sweep ${ids.length} institute${ids.length === 1 ? '' : 's'} for instrument owners: one full-text query per brand (${est.brands} brands) across the whole institute, then one per known model for brands with hits. Every roster member seen on a matching paper gets the brand/model and is re-scored.\n\nCost: ${est.min}–${est.max} OpenAlex credits in total (not per person). Proceed?`,
      () => api.rosterSweep({ institutionIds: ids }),
    );
  };

  const fill = () =>
    void run(
      'Fill missing info',
      `Fill missing email, title, department, phone and website on every promoted lead.\n\nORCID first (free). ${useScraper ? 'Then the scraper reads the institute profile page, lab site and open-access papers for leads still missing something — roughly 20–60 s per lead, robots.txt honoured.' : 'Scraper off — ORCID only.'}\n\nProceed?`,
      () => api.rosterFill({ useScraper }),
    );

  const importCsv = async (file: File) => {
    setActionError(null);
    try {
      const text = await file.text();
      const r = await api.rosterImport(text, 'vidwan_import');
      setNotice(`Imported ${r.rows} rows: ${r.created} added, ${r.updated} updated, ${r.excludedRole} dropped by role, ${r.excludedDomain} by department, ${r.unknownInstitution} at unknown institutes.`);
      reload();
      reloadSummary();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const wipe = async () => {
    if (!window.confirm(`Delete all ${summary?.total ?? 0} roster members? CRM leads already promoted are NOT deleted (use the CRM wipe for those).`)) return;
    try {
      const r = await api.wipeRoster();
      setNotice(`Roster wiped (${r.deleted} removed).`);
      reload();
      reloadSummary();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const setStatusFor = async (m: FacultyMember, next: 'eligible' | 'excluded') => {
    try {
      await api.setRosterStatus(m.id, next, next === 'excluded' ? 'manual' : undefined);
      reload();
      reloadSummary();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / 50)) : 1;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Faculty</h1>
          <p>Every professor and scientist at the target institutes in the kept departments — built first, verified, scored, then promoted into the CRM.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
            Import CSV (Vidwan/IRINS export)
            <input type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && void importCsv(e.target.files[0])} />
          </label>
          <a className="btn btn-sm" href={api.rosterExportUrl(params)}>
            Download CSV (this view)
          </a>
          <button className="btn btn-sm btn-danger" onClick={wipe} disabled={Boolean(running)}>
            Wipe roster
          </button>
        </div>
      </div>

      {summary && (
        <div className="tiles">
          <div className="tile">
            <div className="tile-value">{summary.byStatus.eligible ?? 0}</div>
            <div className="tile-label">Eligible faculty</div>
          </div>
          <div className="tile">
            <div className="tile-value">{summary.byStatus.promoted ?? 0}</div>
            <div className="tile-label">Promoted to CRM</div>
          </div>
          <div className="tile">
            <div className="tile-value">{summary.byRole.inferred ?? 0}</div>
            <div className="tile-label">Role inferred (check)</div>
          </div>
          <div className="tile">
            <div className="tile-value">{summary.byInstitution.filter((i) => i.eligible + i.promoted > 0).length}</div>
            <div className="tile-label">Institutes covered</div>
          </div>
          <div className="tile">
            <div className="tile-value">{summary.byStatus.excluded ?? 0}</div>
            <div className="tile-label">Excluded (kept for audit)</div>
          </div>
        </div>
      )}

      {actionError && <ErrorBanner message={actionError} />}
      {notice && <div className="alert alert-info">{notice}</div>}
      {jobs.filter((j) => j.status === 'running' || Date.now() - new Date(j.finishedAt ?? j.startedAt).getTime() < 3600_000).slice(0, 3).map((j) => (
        <JobPanel key={j.id} job={j} onCancel={() => void api.cancelRosterJob(j.id).then(refreshJobs)} />
      ))}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <Stage n={1} title="Build roster" hint="Who is on the faculty. ORCID + OpenAlex + the institute's own pages. Free apart from ~1 credit per 200 OpenAlex authors.">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
            <InstitutePicker options={config?.institutions ?? []} selected={institutes} onChange={setInstitutes} />
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            {(['openalex', 'orcid', 'faculty_pages', 'vidwan'] as const).map((s) => (
              <label key={s} className="small" style={{ display: 'flex', gap: 4, alignItems: 'center', fontWeight: 400, textTransform: 'none', margin: 0 }}>
                <input type="checkbox" checked={sources.includes(s)} onChange={(e) => setSources(e.target.checked ? [...sources, s] : sources.filter((x) => x !== s))} style={{ width: 'auto' }} />
                {{ openalex: 'OpenAlex', orcid: 'ORCID', faculty_pages: 'Faculty pages', vidwan: 'Vidwan' }[s]}
              </label>
            ))}
            <label className="small" style={{ display: 'flex', gap: 4, alignItems: 'center', fontWeight: 400, textTransform: 'none', margin: 0 }} title="OpenAlex-only authors with no title anywhere, whose publication record reads as an established researcher (≥15 works, h ≥ 8, publishing ≥ 8 years, active). Tagged role-inferred.">
              <input type="checkbox" checked={includeInferred} onChange={(e) => setIncludeInferred(e.target.checked)} style={{ width: 'auto' }} />
              Include inferred roles
            </label>
          </div>
          <button className="btn btn-primary btn-sm" onClick={build} disabled={Boolean(running) || institutes.length === 0}>
            Build for {institutes.length || '…'} institute{institutes.length === 1 ? '' : 's'}
          </button>
        </Stage>

        <Stage n={2} title="Verify affiliations" hint="Still at that institute? ORCID employment beats the latest paper. Free.">
          <button className="btn btn-sm" onClick={verify} disabled={Boolean(running) || !summary?.total}>
            Verify eligible + promoted
          </button>
        </Stage>

        <Stage n={3} title="Score relevance" hint="Recent titles, abstracts and topics against the catalog — the same scorer discovery uses. 1 credit per person.">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-sm btn-primary" onClick={() => void score(false)} disabled={Boolean(running) || !summary?.byStatus.eligible}>
              Score unscored
            </button>
            <button className="btn btn-sm" onClick={() => void score(true)} disabled={Boolean(running) || !summary?.byStatus.eligible}>
              Re-score all
            </button>
            <button className="btn btn-sm" onClick={() => void sweep()} disabled={Boolean(running) || !summary?.total} title="One full-text query per brand across the whole institute — finds every roster member who has written up a PalmSens, Autolab, Gamry… at a fraction of the per-lead scan's cost">
              Instrument sweep
            </button>
          </div>
        </Stage>

        <Stage n={4} title="Promote to CRM" hint="Members at or above the threshold become pending-review leads; their instruments are then identified (10 credits per brand).">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <label className="small" style={{ margin: 0, fontWeight: 400, textTransform: 'none' }}>
              Threshold{' '}
              <input type="number" min={0} max={100} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} style={{ width: 70, display: 'inline-block' }} />
            </label>
            <label className="small" style={{ display: 'flex', gap: 4, alignItems: 'center', fontWeight: 400, textTransform: 'none', margin: 0 }}>
              <input type="checkbox" checked={identifyInstruments} onChange={(e) => setIdentifyInstruments(e.target.checked)} style={{ width: 'auto' }} />
              Identify instruments
            </label>
          </div>
          <button className="btn btn-sm btn-success" onClick={() => void promote()} disabled={Boolean(running) || !summary?.byStatus.eligible}>
            Promote ≥ {threshold}
          </button>
        </Stage>

        <Stage n={5} title="Fill missing info" hint="Email, title, department, phone, website — ORCID first, then institute/lab pages and open-access papers.">
          <label className="small" style={{ display: 'flex', gap: 4, alignItems: 'center', fontWeight: 400, textTransform: 'none', margin: '0 0 8px' }}>
            <input type="checkbox" checked={useScraper} onChange={(e) => setUseScraper(e.target.checked)} style={{ width: 'auto' }} />
            Use the scraper (pages + papers)
          </label>
          <button className="btn btn-sm" onClick={fill} disabled={Boolean(running) || !summary?.byStatus.promoted}>
            Fill promoted leads
          </button>
        </Stage>
      </div>

      <div className="toolbar">
        <input placeholder="Search name, email, department…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">Any status</option>
          <option value="eligible">Eligible</option>
          <option value="promoted">Promoted</option>
          <option value="excluded">Excluded</option>
        </select>
        <select value={institutionId} onChange={(e) => { setInstitutionId(e.target.value); setPage(1); }}>
          <option value="">All institutes</option>
          {(summary?.byInstitution ?? []).map((i) => {
            const id = config?.institutions.find((c) => c.name === i.name)?.id;
            return id ? (
              <option key={id} value={id}>
                {shortInstitute(i.name)} ({i.eligible + i.promoted})
              </option>
            ) : null;
          })}
        </select>
        <select value={domain} onChange={(e) => { setDomain(e.target.value); setPage(1); }}>
          <option value="">All departments</option>
          {Object.entries(config?.domains ?? {}).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}>
          <option value="">Any role</option>
          {Object.entries(ROLE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select value={affiliation} onChange={(e) => { setAffiliation(e.target.value); setPage(1); }}>
          <option value="">Any affiliation</option>
          <option value="current">Current</option>
          <option value="moved">Moved</option>
          <option value="unknown">Unknown (blanked)</option>
          <option value="unverified">Unverified</option>
        </select>
        <select value={scored} onChange={(e) => { setScored(e.target.value as '' | 'yes' | 'no'); setPage(1); }}>
          <option value="">Scored or not</option>
          <option value="yes">Scored</option>
          <option value="no">Not scored</option>
        </select>
        <select value={tag} onChange={(e) => { setTag(e.target.value); setPage(1); }}>
          <option value="">Any tag</option>
          <option value="role-inferred">role-inferred</option>
          <option value="outside-target">outside-target</option>
          <option value="review-role">review-role</option>
          <option value="instruments-scanned">instruments-scanned</option>
        </select>
        <select value={missing} onChange={(e) => { setMissing(e.target.value); setPage(1); }}>
          <option value="">Missing…</option>
          <option value="email">Missing email</option>
          <option value="title">Missing title</option>
          <option value="phone">Missing phone</option>
          <option value="websiteUrl">Missing website</option>
        </select>
        <label className="small" style={{ margin: 0, fontWeight: 400, textTransform: 'none' }}>
          Min score{' '}
          <input type="number" min={0} max={100} value={minScore} onChange={(e) => { setMinScore(Number(e.target.value)); setPage(1); }} style={{ width: 70, display: 'inline-block' }} />
        </label>
        <select value={sort} onChange={(e) => setSort(e.target.value as 'score' | 'name' | 'newest')}>
          <option value="score">Sort: score</option>
          <option value="name">Sort: name</option>
          <option value="newest">Sort: newest</option>
        </select>
        {data && <span className="muted small">{data.total} member{data.total === 1 ? '' : 's'}</span>}
      </div>

      {error && <ErrorBanner message={error} />}
      {loading && !data && <Loading />}
      {data && data.items.length === 0 && (
        <EmptyState>
          {summary?.total ? 'Nothing matches these filters.' : 'The roster is empty. Choose institutes and run stage 1.'}
        </EmptyState>
      )}
      {data && data.items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role / title</th>
                <th>Department</th>
                <th>Institute</th>
                <th>Contact</th>
                <th>Sources</th>
                <th>Score</th>
                <th>Instruments</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((m) => (
                <MemberRow key={m.id} m={m} onStatus={setStatusFor} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && totalPages > 1 && (
        <div className="pagination">
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ← Previous
          </button>
          <span className="small muted">
            Page {page} of {totalPages}
          </span>
          <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
            Next →
          </button>
        </div>
      )}
    </>
  );
}

function MemberRow({ m, onStatus }: { m: FacultyMember; onStatus: (m: FacultyMember, next: 'eligible' | 'excluded') => void }) {
  const [open, setOpen] = useState(false);
  const profile = m.person.profileUrl && !/openalex\.org/i.test(m.person.profileUrl) ? m.person.profileUrl : undefined;
  return (
    <>
      <tr>
        <td>
          <div style={{ fontWeight: 600 }}>
            {profile ? (
              <a href={profile} target="_blank" rel="noreferrer">
                {m.person.name}
              </a>
            ) : (
              m.person.name
            )}
          </div>
          <div className="small muted">
            {m.person.orcid && (
              <a href={`https://orcid.org/${m.person.orcid}`} target="_blank" rel="noreferrer">
                ORCID
              </a>
            )}
            {m.person.orcid && m.person.openAlexAuthorId && ' · '}
            {m.person.openAlexAuthorId && (
              <a href={`https://openalex.org/${m.person.openAlexAuthorId}`} target="_blank" rel="noreferrer">
                OpenAlex
              </a>
            )}
          </div>
        </td>
        <td>
          <div>{m.person.title ?? <span className="muted">—</span>}</div>
          <div className="small muted" title={m.role.basis}>
            {ROLE_LABELS[m.role.category] ?? m.role.category}
          </div>
        </td>
        <td>
          <div>{m.department.name ?? <span className="muted">—</span>}</div>
          <div className="small muted">
            {m.department.domain.replace(/_/g, ' ')}
            {m.department.gateTerms?.length ? ` · ${m.department.gateTerms.slice(0, 2).join(', ')}` : ''}
          </div>
        </td>
        <td>
          <div>{m.institution.name ? shortInstitute(m.institution.name) : <span className="muted">unknown</span>}</div>
          <div className="small">
            <AffiliationNote affiliation={m.institution.affiliation} institutionName={m.institution.name} />
            {m.institution.outsideTarget && <span className="badge badge-neutral" style={{ marginLeft: 4 }}>outside target</span>}
            {!m.institution.affiliation && <span className="muted">unverified</span>}
          </div>
        </td>
        <td className="small">
          {m.person.email ? <div className="mono">{m.person.email}</div> : <div className="muted">no email</div>}
          {m.person.phone && <div>{m.person.phone}</div>}
          {m.person.websiteUrl && (
            <a href={m.person.websiteUrl} target="_blank" rel="noreferrer">
              website
            </a>
          )}
        </td>
        <td className="small">{[...new Set(m.sources.map((s) => s.type.replace('_', ' ')))].join(', ')}</td>
        <td>
          <ScorePill score={m.relevance.score} />
        </td>
        <td>
          {m.research.instruments.length === 0 ? (
            <span className="muted small">—</span>
          ) : (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {m.research.instruments.slice(0, 4).map((i, idx) => (
                <InstrumentBadge key={idx} vendor={i.vendor} brand={i.brand} model={i.model} />
              ))}
            </div>
          )}
        </td>
        <td>
          {m.status === 'promoted' && m.leadId ? (
            <Link to={`/leads/${m.leadId}`} className="badge badge-approved">
              in CRM →
            </Link>
          ) : (
            <span className={`badge ${m.status === 'eligible' ? 'badge-pending' : 'badge-rejected'}`} title={m.exclusionReason}>
              {m.status}
            </span>
          )}
          {m.tags.filter((t) => t !== 'outside-target').map((t) => (
            <span key={t} className="tag" style={{ marginLeft: 4 }}>
              {t}
            </span>
          ))}
        </td>
        <td style={{ whiteSpace: 'nowrap' }}>
          <button className="btn btn-sm" onClick={() => setOpen(!open)}>
            {open ? 'Less' : 'More'}
          </button>{' '}
          {m.status === 'eligible' && (
            <button className="btn btn-sm" onClick={() => onStatus(m, 'excluded')} title="Not a prospect — drop from the roster">
              Exclude
            </button>
          )}
          {m.status === 'excluded' && (
            <button className="btn btn-sm" onClick={() => onStatus(m, 'eligible')}>
              Restore
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={10} style={{ background: 'var(--surface-2, #fafafa)' }}>
            <div className="detail-grid" style={{ padding: '6px 0' }}>
              <div>
                <div className="section-title">Sources</div>
                <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                  {m.sources.map((s, i) => (
                    <li key={i}>
                      <strong>{s.type.replace('_', ' ')}</strong>
                      {s.title ? ` — ${s.title}` : ''}
                      {s.department ? `, ${s.department}` : ''}{' '}
                      {s.url && (
                        <a href={s.url} target="_blank" rel="noreferrer">
                          open →
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
                {m.role.basis && (
                  <p className="small muted" style={{ marginTop: 6 }}>
                    Role basis: {m.role.basis}
                  </p>
                )}
                {m.exclusionReason && (
                  <p className="small muted" style={{ marginTop: 6 }}>
                    Excluded: {m.exclusionReason}
                  </p>
                )}
              </div>
              <div>
                <div className="section-title">Affiliation</div>
                {m.institution.affiliation ? (
                  <div className="small">
                    <div>
                      <strong>{m.institution.affiliation.status}</strong> via {m.institution.affiliation.source}, {formatDate(m.institution.affiliation.verifiedAt)}
                      {m.institution.affiliation.previousInstitution && <> · previously {m.institution.affiliation.previousInstitution}</>}
                    </div>
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {(m.institution.affiliation.evidence ?? []).map((e, i) => (
                        <li key={i}>
                          <strong>{e.source}</strong>: {e.institution ?? <span className="muted">{e.detail ?? 'nothing'}</span>}
                          {e.institution && e.detail && <span className="muted"> — {e.detail}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="small muted">Not yet verified (stage 2). Discovered at {m.institution.discoveredName}.</p>
                )}
              </div>
              <div>
                <div className="section-title">Research</div>
                <div className="small">
                  {m.research.worksCount !== undefined && (
                    <div className="muted">
                      {m.research.worksCount} works · h {m.research.hIndex ?? '?'} · {m.research.firstPublicationYear ?? '?'}–{m.research.lastPublicationYear ?? '?'}
                    </div>
                  )}
                  {m.research.topics.length > 0 && <div>{m.research.topics.slice(0, 8).join(' · ')}</div>}
                  {m.relevance.reasoning && (
                    <p style={{ margin: '6px 0 0' }}>
                      <strong>Score {m.relevance.score}</strong> — {m.relevance.reasoning}
                    </p>
                  )}
                  {m.research.recentPublications.length > 0 && (
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                      {m.research.recentPublications.slice(0, 5).map((p, i) => (
                        <li key={i}>
                          {p.url ? (
                            <a href={p.url} target="_blank" rel="noreferrer">
                              {p.title}
                            </a>
                          ) : (
                            p.title
                          )}
                          {p.year ? ` (${p.year})` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
