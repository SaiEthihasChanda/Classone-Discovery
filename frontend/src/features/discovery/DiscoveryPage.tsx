import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  api,
  type BatchNameResult,
  type DiscoveryRunSummary,
  type Institution,
  type InstitutionKind,
  type RunDiscoveryPayload,
} from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import { ErrorBanner, Loading } from '../../components/common';

type SourceKey = 'openalex' | 'nih' | 'nsf' | 'faculty' | 'news';

const SOURCE_LABELS: Record<SourceKey, string> = {
  openalex: 'OpenAlex (research papers)',
  nih: 'NIH RePORTER (grants)',
  nsf: 'NSF Award Search (grants)',
  faculty: 'Faculty pages (scraped)',
  news: 'University news (RSS)',
};

const INSTITUTION_KINDS: InstitutionKind[] = ['IIT', 'NIT', 'IIIT'];

/** Option value meaning "no institute pinned" in the by-name lookups. */
const ALL_INSTITUTES = '';

/**
 * Institute picker — a checklist in a `<details>` popover.
 *
 * Nothing selected means every institute, which is what a weekly run wants;
 * selecting a few narrows both the OpenAlex filter and the scrape targets.
 */
function InstituteFilter({
  options,
  selected,
  onChange,
}: {
  options: Institution[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [filter, setFilter] = useState('');
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const label =
    selected.length === 0
      ? 'All institutes'
      : selected.length === 1
        ? (options.find((o) => o.openAlexId === selected[0])?.name ?? '1 institute')
        : `${selected.length} institutes`;

  const term = filter.trim().toLowerCase();
  const matching = term
    ? options.filter((o) => o.name.toLowerCase().includes(term))
    : options;

  return (
    <details className="dropdown">
      <summary className={`btn btn-sm${selected.length > 0 ? ' btn-primary' : ''}`}>
        {label} ▾
      </summary>
      <div className="dropdown-menu" style={{ minWidth: 380 }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name…"
          style={{ marginBottom: 8 }}
        />
        <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          {INSTITUTION_KINDS.map((kind) => (
            <button
              key={kind}
              className="btn btn-sm"
              onClick={() =>
                onChange([
                  ...new Set([
                    ...selected,
                    ...options.filter((o) => o.kind === kind).map((o) => o.openAlexId),
                  ]),
                ])
              }
            >
              + all {kind}s
            </button>
          ))}
          {selected.length > 0 && (
            <button className="btn btn-sm" onClick={() => onChange([])}>
              Clear
            </button>
          )}
        </div>
        {matching.map((inst) => (
          <label key={inst.openAlexId} className="dropdown-option">
            <input
              type="checkbox"
              checked={selected.includes(inst.openAlexId)}
              onChange={() => toggle(inst.openAlexId)}
              style={{ width: 'auto' }}
            />
            <span>
              {inst.name} <span className="muted small">({inst.kind})</span>
            </span>
          </label>
        ))}
        {matching.length === 0 && <p className="muted small">No institute matches “{filter}”.</p>}
      </div>
    </details>
  );
}

export function DiscoveryPage() {
  const navigate = useNavigate();
  const { data: config, loading, error, reload: reloadConfig } = useAsync(() => api.discoveryConfig(), []);
  // Loaded once; ~72 rows, sorted by research output on the server.
  const { data: institutionList } = useAsync(() => api.listInstitutions(), []);

  // Empty = every institute, which is the default a weekly run wants.
  const [institutionIds, setInstitutionIds] = useState<string[]>([]);
  const [instrumentSearch, setInstrumentSearch] = useState<boolean | null>(null);
  const [sources, setSources] = useState<SourceKey[]>(['openalex', 'faculty', 'news']);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<DiscoveryRunSummary | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupNote, setLookupNote] = useState<string | null>(null);

  const [batchText, setBatchText] = useState('');
  const [batchInstitutionId, setBatchInstitutionId] = useState<string>(ALL_INSTITUTES);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchResult, setBatchResult] = useState<BatchNameResult | null>(null);

  const batchNames = batchText
    .split(/\r?\n/)
    .map((n) => n.trim())
    .filter((n) => n.length >= 3);

  async function handleBatch(event: React.FormEvent) {
    event.preventDefault();
    setBatchBusy(true);
    setBatchError(null);
    setBatchResult(null);
    try {
      setBatchResult(
        await api.discoverByNames(
          batchNames.slice(0, 50),
          batchInstitutionId === ALL_INSTITUTES ? undefined : batchInstitutionId,
        ),
      );
    } catch (err) {
      setBatchError(err instanceof Error ? err.message : 'Batch lookup failed');
    } finally {
      setBatchBusy(false);
    }
  }

  function toggleSource(key: SourceKey) {
    setSources((prev) =>
      prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key],
    );
  }

  async function handleRun() {
    setRunning(true);
    setRunError(null);
    setSummary(null);

    const payload: RunDiscoveryPayload = {
      sources,
      // Nothing selected means every institute — the backend's default.
      ...(institutionIds.length > 0 ? { institutionIds } : {}),
      // null = leave it to the saved setting; only send an explicit override.
      ...(instrumentSearch === null ? {} : { includeInstrumentSearch: instrumentSearch }),
    };

    try {
      setSummary(await api.runDiscovery(payload));
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Discovery run failed');
    } finally {
      setRunning(false);
      // The credit balance moved; show the new figure without a manual refresh.
      reloadConfig();
    }
  }

  // Credits this run will spend, as the toggles currently stand.
  const effectiveInstrument = instrumentSearch ?? config?.instrumentSearch.enabledByDefault ?? true;
  const creditsForRun = config
    ? config.topicSearch.groups.length +
      Math.ceil(config.keywordSearch.phrases / 5) * 10 +
      (effectiveInstrument ? config.instrumentSearch.searchedBrands.length * 10 : 0) +
      (effectiveInstrument && config.instrumentSearch.identifyModels
        ? config.instrumentSearch.modelQueries * 10
        : 0)
    : null;
  const notEnoughCredits =
    creditsForRun !== null &&
    config?.openAlexBudget.creditsRemaining !== null &&
    config?.openAlexBudget.creditsRemaining !== undefined &&
    sources.includes('openalex') &&
    creditsForRun > config.openAlexBudget.creditsRemaining;

  async function handleLookup(event: React.FormEvent) {
    event.preventDefault();
    setLookupBusy(true);
    setLookupError(null);
    setLookupNote(null);

    try {
      const result = await api.discoverByName(name.trim());
      if (!result.lead) {
        setLookupError(`No researcher found matching "${name}"`);
        return;
      }
      if (result.wasDuplicate) {
        setLookupNote('Already in the CRM — opening the existing record…');
      }
      setTimeout(() => navigate(`/leads/${result.lead!.id}`), result.wasDuplicate ? 1200 : 0);
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : 'Lookup failed');
    } finally {
      setLookupBusy(false);
    }
  }

  if (loading && !config) return <Loading />;
  if (error) return <ErrorBanner message={error} />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Discovery</h1>
          <p>Find new prospects from research papers, grant awards, faculty pages and news.</p>
        </div>
      </div>

      {config?.openAlexBudget.exhausted && (
        <div className="alert alert-error">
          <strong>OpenAlex daily allowance used up — discovery runs will fail until it resets</strong>
          {config.openAlexBudget.resetInSeconds
            ? ` (about ${Math.round(config.openAlexBudget.resetInSeconds / 3600)}h from now, at midnight UTC)`
            : ''}
          . {config.openAlexApiKeyConfigured ? '' : 'A free OpenAlex API key raises the allowance from 1,000 to 10,000 credits a day: set OPENALEX_API_KEY in .env. '}
          Prepaid credits are available at{' '}
          <a href="https://openalex.org/pricing" target="_blank" rel="noreferrer">
            openalex.org/pricing
          </a>
          .
        </div>
      )}

      {config &&
        !config.openAlexBudget.exhausted &&
        config.openAlexBudget.creditsRemaining !== null &&
        config.openAlexBudget.creditsRemaining < Math.max(200, config.estimatedCreditsPerRun) && (
          <div className="alert alert-info">
            OpenAlex credits running low: <strong>{config.openAlexBudget.creditsRemaining}</strong>{' '}
            of {config.openAlexBudget.creditsLimit ?? 1000} left today; a default run needs about{' '}
            {config.estimatedCreditsPerRun}. Topic searches cost 1 credit, keyword and brand searches 10.
            {!config.openAlexApiKeyConfigured && (
              <>
                {' '}
                A free API key gives 10× the allowance — set <span className="mono">OPENALEX_API_KEY</span>.
              </>
            )}
          </div>
        )}

      {config && !config.aiProvider.billable && (
        <div className="alert alert-info">
          <strong>Free scoring mode.</strong> No OpenAI key is configured, so leads are scored by
          the keyword heuristic (<span className="mono">{config.aiProvider.name}</span>). Discovery
          works and costs nothing; add <span className="mono">OPENAI_API_KEY</span> to{' '}
          <span className="mono">.env</span> for higher-quality scoring and summaries.
        </div>
      )}

      <div className="detail-grid">
        <div style={{ display: 'grid', gap: 18 }}>
          <section className="card card-pad">
            <h2 className="section-title">Run discovery now</h2>

            <div className="field">
              <label>Institutes to search</label>
              <InstituteFilter
                options={institutionList?.items ?? []}
                selected={institutionIds}
                onChange={setInstitutionIds}
              />
              <p className="muted small" style={{ margin: '6px 0 0' }}>
                {institutionIds.length === 0
                  ? `Searching all ${config?.institutions.total ?? 72} IITs, NITs and IIITs.`
                  : `Searching ${institutionIds.length} selected institute${institutionIds.length === 1 ? '' : 's'} — papers, plus their faculty and news pages where configured.`}
              </p>
            </div>

            <div className="alert alert-info" style={{ fontSize: 12, padding: '8px 12px' }}>
              Every run searches the {config?.topicSearch.groups.length ?? 6} research topic groups
              and {config?.keywordSearch.phrases ?? 0} keyword phrases derived from the product
              catalogue. NIH and NSF fund US institutions almost exclusively, so they are excluded.
            </div>
            <div className="field">
              <label>Sources</label>
              {(Object.keys(SOURCE_LABELS) as SourceKey[]).map((key) => {
                const unavailable =
                  (key === 'faculty' && config?.scrapeTargets.faculty === 0) ||
                  (key === 'news' && config?.scrapeTargets.news === 0);

                return (
                  <label
                    key={key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontWeight: 400,
                      textTransform: 'none',
                      fontSize: 13,
                      marginBottom: 6,
                      color: 'var(--text)',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={sources.includes(key)}
                      disabled={unavailable || key === 'nih' || key === 'nsf'}
                      onChange={() => toggleSource(key)}
                      style={{ width: 'auto' }}
                    />
                    {SOURCE_LABELS[key]}
                    {key === 'faculty' && config && (
                      <span className="muted small">({config.scrapeTargets.faculty} targets)</span>
                    )}
                    {key === 'news' && config && (
                      <span className="muted small">({config.scrapeTargets.news} feeds)</span>
                    )}
                  </label>
                );
              })}
              <p className="muted small" style={{ margin: '6px 0 0' }}>
                Faculty and news need the Python scraper service running on port 8000.
              </p>
            </div>

            <div className="field">
              <label>Instruments in use</label>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontWeight: 400,
                  textTransform: 'none',
                  fontSize: 13,
                  marginBottom: 6,
                  color: 'var(--text)',
                }}
              >
                <input
                  type="checkbox"
                  checked={instrumentSearch ?? config?.instrumentSearch.enabledByDefault ?? true}
                  disabled={!sources.includes('openalex')}
                  onChange={(e) => setInstrumentSearch(e.target.checked)}
                  style={{ width: 'auto' }}
                />
                Search paper full text for instrument brands
                {config && (
                  <span className="muted small">
                    ({config.instrumentSearch.searchedBrands.length} brands ·{' '}
                    {config.instrumentSearch.searchedBrands.length * 10} credits)
                  </span>
                )}
              </label>
              <p className="muted small" style={{ margin: '0 0 0' }}>
                {config && config.instrumentSearch.searchedBrands.length > 0
                  ? config.instrumentSearch.searchedBrands.map((b) => b.brand).join(', ')
                  : 'No brands enabled for search'}{' '}
                — leads get tagged with the potentiostat they already use (Class One brand or
                competitor)
                {config?.instrumentSearch.identifyModels &&
                  `, then identified down to the model — up to ${config.instrumentSearch.modelQueries} model queries, skipped for brands nobody uses`}
                . Edit the list in Settings → Search keywords.
              </p>
            </div>


            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary"
                onClick={handleRun}
                disabled={running || sources.length === 0 || config?.openAlexBudget.exhausted}
              >
                {running ? 'Running… (this can take a few minutes)' : 'Run discovery'}
              </button>
              {creditsForRun !== null && sources.includes('openalex') && (
                <span className={`small ${notEnoughCredits ? '' : 'muted'}`} style={notEnoughCredits ? { color: 'var(--danger)' } : undefined}>
                  ~{creditsForRun} OpenAlex credits
                  {config?.openAlexBudget.creditsRemaining !== null &&
                    ` · ${config?.openAlexBudget.creditsRemaining} left today`}
                  {notEnoughCredits && ' — not enough; the run will stop part-way'}
                </span>
              )}
            </div>

            {runError && (
              <div style={{ marginTop: 14 }}>
                <ErrorBanner message={runError} />
              </div>
            )}

            {summary?.openAlexExhausted && (
              <div className="alert alert-error" style={{ marginTop: 14 }}>
                <strong>OpenAlex credits ran out part-way through this run.</strong> The results
                below are partial — later topic groups, keywords and brand searches were skipped.
                Re-run after the daily reset{config?.openAlexApiKeyConfigured ? '' : ', or add a free OPENALEX_API_KEY for 10× the allowance'}.
              </div>
            )}

            {summary && (
              <div className={`alert ${summary.openAlexExhausted ? 'alert-info' : 'alert-success'}`} style={{ marginTop: 14 }}>
                <strong>
                  {summary.leadsCreated} new lead{summary.leadsCreated === 1 ? '' : 's'}
                </strong>{' '}
                from {summary.candidatesFound} candidates ({summary.duplicatesSkipped} duplicates
                skipped) in {(summary.durationMs / 1000).toFixed(1)}s.
                {summary.instrumentsDetected > 0 &&
                  ` Instrument identified on ${summary.instrumentsDetected} of them.`}
                {summary.estimatedCostUsd > 0 &&
                  ` Estimated cost $${summary.estimatedCostUsd.toFixed(4)}.`}
                {summary.leadsCreated > 0 && (
                  <>
                    {' '}
                    <Link to="/review">Review them now →</Link>
                  </>
                )}
                {summary.errors.length > 0 && (
                  <details style={{ marginTop: 8 }}>
                    <summary>{summary.errors.length} source warning(s)</summary>
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                      {summary.errors.map((e, i) => (
                        <li key={i} className="small">
                          {e}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </section>

          <section className="card card-pad">
            <h2 className="section-title">Look up one researcher by name</h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              Heard about someone? Type their name and the discovery engine will find, score and
              add them.
            </p>

            <form onSubmit={handleLookup} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. John Goodenough"
                style={{ flex: '1 1 260px' }}
              />
              <button
                className="btn btn-primary"
                type="submit"
                disabled={lookupBusy || name.trim().length < 3}
              >
                {lookupBusy ? 'Searching…' : 'Find & add'}
              </button>
            </form>

            {lookupNote && (
              <div className="alert alert-info" style={{ marginTop: 12 }}>
                {lookupNote}
              </div>
            )}
            {lookupError && (
              <div style={{ marginTop: 12 }}>
                <ErrorBanner message={lookupError} />
              </div>
            )}
          </section>

          <section className="card card-pad">
            <h2 className="section-title">Look up many researchers at once</h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              Paste a faculty list — one name per line, up to 50. Pinning them to an institute
              makes common names unambiguous. Each name costs about 10 OpenAlex credits.
            </p>

            <form onSubmit={handleBatch} style={{ display: 'grid', gap: 10 }}>
              <textarea
                value={batchText}
                onChange={(e) => setBatchText(e.target.value)}
                rows={6}
                placeholder={'Siddharth Tallur\nKiran Kondabagil\nShruti Ahuja'}
                style={{ fontFamily: 'inherit', fontSize: 13, resize: 'vertical' }}
              />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <select
                  value={batchInstitutionId}
                  onChange={(e) => setBatchInstitutionId(e.target.value)}
                  style={{ flex: '1 1 260px' }}
                >
                  <option value={ALL_INSTITUTES}>Any institution (name only)</option>
                  {INSTITUTION_KINDS.map((kind) => {
                    const items = (institutionList?.items ?? []).filter((i) => i.kind === kind);
                    if (items.length === 0) return null;
                    return (
                      <optgroup key={kind} label={`${kind}s`}>
                        {items.map((inst: Institution) => (
                          <option key={inst.openAlexId} value={inst.openAlexId}>
                            {inst.name}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={batchBusy || batchNames.length === 0}
                >
                  {batchBusy
                    ? `Looking up ${Math.min(batchNames.length, 50)}…`
                    : `Find & add ${Math.min(batchNames.length, 50) || ''}`.trim()}
                </button>
              </div>
              {batchNames.length > 50 && (
                <p className="muted small" style={{ margin: 0 }}>
                  Only the first 50 names will be sent; run the rest as a second batch.
                </p>
              )}
            </form>

            {batchError && (
              <div style={{ marginTop: 12 }}>
                <ErrorBanner message={batchError} />
              </div>
            )}

            {batchResult && (
              <div style={{ marginTop: 14 }}>
                <div className="alert alert-success">
                  <strong>{batchResult.created} added</strong>
                  {batchResult.duplicates > 0 && ` · ${batchResult.duplicates} already in the CRM`}
                  {batchResult.notFound > 0 && ` · ${batchResult.notFound} not found`}
                  {batchResult.skipped > 0 && ` · ${batchResult.skipped} skipped (credits exhausted)`}
                  {batchResult.errors > 0 && ` · ${batchResult.errors} failed`}
                  {batchResult.created > 0 && (
                    <>
                      {' '}
                      <Link to="/review">Review them →</Link>
                    </>
                  )}
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Result</th>
                        <th>Matched</th>
                        <th>Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchResult.outcomes.map((o, i) => (
                        <tr key={`${o.name}-${i}`}>
                          <td>{o.name}</td>
                          <td className="small">
                            {o.status === 'created' && 'Added'}
                            {o.status === 'duplicate' && 'Already in CRM'}
                            {o.status === 'not_found' && <span className="muted">Not found</span>}
                            {o.status === 'skipped' && <span className="muted">Skipped — {o.message}</span>}
                            {o.status === 'error' && <span style={{ color: 'var(--danger)' }}>{o.message}</span>}
                          </td>
                          <td className="small">
                            {o.lead ? (
                              <Link to={`/leads/${o.lead.id}`}>
                                {o.lead.person.name}
                                {o.lead.institution.name && (
                                  <span className="muted"> · {o.lead.institution.name}</span>
                                )}
                              </Link>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td>{o.lead?.aiScoring.relevanceScore ?? <span className="muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        </div>

        <section className="card card-pad">
          <h2 className="section-title">Configuration</h2>
          <dl className="kv">
            <dt>Target institutes</dt>
            <dd>
              {config?.institutions.total} indexed
              <div className="muted small">
                {config &&
                  INSTITUTION_KINDS.map((k) => `${config.institutions.counts[k]} ${k}s`).join(
                    ' · ',
                  )}
              </div>
            </dd>
            <dt>AI provider</dt>
            <dd>
              <span className="mono">{config?.aiProvider.name}</span>
              <div className="muted small">
                {config?.aiProvider.billable ? 'Billable (OpenAI)' : 'Free (no API key set)'}
              </div>
            </dd>
            <dt>Run budget</dt>
            <dd>${config?.budgetUsd.toFixed(2)}</dd>
            <dt>OpenAlex credits</dt>
            <dd>
              {config?.openAlexBudget.creditsRemaining === null ? (
                <span className="muted">not yet measured</span>
              ) : (
                <>
                  {config?.openAlexBudget.creditsRemaining} /{' '}
                  {config?.openAlexBudget.creditsLimit ?? 1000}
                  <div className="muted small">10 per query, resets midnight UTC</div>
                </>
              )}
            </dd>
            <dt>Faculty targets</dt>
            <dd>{config?.scrapeTargets.faculty}</dd>
            <dt>News feeds</dt>
            <dd>{config?.scrapeTargets.news}</dd>
            <dt>Scheduled runs</dt>
            <dd>
              {config?.cronEnabled ? (
                <span className="mono">{config.discoverySchedule}</span>
              ) : (
                <span className="muted">Disabled</span>
              )}
            </dd>
          </dl>

          <p className="muted small" style={{ marginTop: 14, marginBottom: 0 }}>
            Discovered leads always land in the review queue as <em>pending review</em> — nothing
            is contacted without a human approving it first.
          </p>
        </section>
      </div>
    </>
  );
}
