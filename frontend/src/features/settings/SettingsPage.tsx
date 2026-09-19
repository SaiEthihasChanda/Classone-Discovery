import { useEffect, useState } from 'react';
import {
  api,
  type AppSettings,
  type DiscoveryConfig,
  type InstitutionKind,
  type InstrumentBrandConfig,
  type ScrapeTargetConfig,
  type SettingsResponse,
} from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import { ErrorBanner, Loading } from '../../components/common';

const KINDS: InstitutionKind[] = ['IIT', 'NIT', 'IIIT'];

type Tab = 'keywords' | 'institutions' | 'sources' | 'scraping' | 'danger';

/**
 * Settings — everything that governs discovery, editable without touching files.
 *
 * These values are stored in the database and take precedence over the seed
 * files, so a change here also governs the scheduled cron run (which passes no
 * options of its own).
 */
export function SettingsPage() {
  const { data, loading, error, reload } = useAsync<SettingsResponse>(
    () => api.getSettings(),
    [],
  );

  const [tab, setTab] = useState<Tab>('keywords');
  const [draft, setDraft] = useState<AppSettings | null>(null);
  // The derived keyword groups, topic groups and model names all live in code;
  // the discovery config endpoint is what serves them to this page.
  const { data: discoveryConfig } = useAsync(() => api.discoveryConfig(), []);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      const { institutions: _ignored, ...settings } = data;
      setDraft(settings);
    }
  }, [data]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBanner message={error} />;
  if (!data || !draft) return null;

  const dirty = JSON.stringify(draft) !== JSON.stringify(stripInstitutions(data));

  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    setMessage(null);
    try {
      await api.updateSettings({
        discovery: draft.discovery,
        scraping: draft.scraping,
        facultyTargets: draft.facultyTargets,
        newsTargets: draft.newsTargets,
      });
      setMessage('Settings saved. They apply to the next discovery run.');
      reload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save settings');
    } finally {
      setSaving(false);
    }
  }

  async function resetAll() {
    if (!window.confirm('Reset every setting back to the seed-file defaults?')) return;
    setSaving(true);
    try {
      await api.resetSettings();
      setMessage('Settings reset to defaults.');
      reload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not reset settings');
    } finally {
      setSaving(false);
    }
  }

  const update = (fn: (d: AppSettings) => AppSettings) => setDraft((prev) => (prev ? fn(prev) : prev));

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>
            Controls what discovery searches for. Saved here, these override the seed files and
            govern scheduled runs too.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={resetAll} disabled={saving}>
            Reset to defaults
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
            {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
          </button>
        </div>
      </div>

      {message && <div className="alert alert-success">{message}</div>}
      {saveError && <ErrorBanner message={saveError} />}
      {dirty && !saving && (
        <div className="alert alert-info">You have unsaved changes.</div>
      )}

      <div className="toolbar" style={{ gap: 6 }}>
        {(
          [
            ['keywords', 'Search keywords'],
            ['institutions', 'Institutions'],
            ['sources', 'Scrape sources'],
            ['scraping', 'Scraping behaviour'],
            ['danger', 'Danger zone'],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            className={`btn btn-sm${tab === key ? ' btn-primary' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'keywords' && (
        <KeywordsTab draft={draft} update={update} config={discoveryConfig} />
      )}
      {tab === 'institutions' && (
        <InstitutionsTab draft={draft} update={update} institutions={data.institutions} />
      )}
      {tab === 'sources' && <SourcesTab draft={draft} update={update} reload={reload} />}
      {tab === 'scraping' && <ScrapingTab draft={draft} update={update} />}
      {tab === 'danger' && <DangerZoneTab />}
    </>
  );
}

function stripInstitutions(data: SettingsResponse): AppSettings {
  const { institutions: _ignored, ...rest } = data;
  return rest;
}

// ---------------------------------------------------------------------------

/**
 * The keyword set, as it is actually searched.
 *
 * Read-only by design: these phrases are DERIVED from the website's subject
 * terms, the product catalog's application areas and per-product keywords, its
 * model names and the brand list. Typing the product range in by hand is what
 * let discovery drift out of step with the website; adding a product there and
 * re-running `npm run catalog:export` is what widens the search now. A group
 * can be switched off, and one-off terms can be added below.
 */
function KeywordsTab({
  draft,
  update,
  config,
}: {
  draft: AppSettings;
  update: (fn: (d: AppSettings) => AppSettings) => void;
  config: DiscoveryConfig | null;
}) {
  const [newQuery, setNewQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const setQueries = (queries: string[]) =>
    update((d) => ({ ...d, discovery: { ...d.discovery, queries } }));

  const disabled = new Set(draft.discovery.disabledKeywordGroups);
  const setDisabled = (next: Set<string>) =>
    update((d) => ({ ...d, discovery: { ...d.discovery, disabledKeywordGroups: [...next] } }));

  const groups = config?.keywordSearch.groups ?? [];
  // The authoritative figure, deduplicated across groups — the groups overlap
  // ("corrosion" is both a subject term and an application area), so summing
  // their counts overstates it.
  const searchedCount = config?.keywordSearch.phrases ?? 0;

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <section className="card card-pad">
        <h2 className="section-title">Search keywords</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Built automatically from five sources, so the search follows the catalogue instead of
          drifting from it. <strong>{searchedCount}</strong> distinct phrases (the groups overlap)
          are matched against paper titles and abstracts, five per 10-credit OpenAlex call;
          product and brand names are searched in paper full text by the instrument search
          instead, at no extra cost. Changes take effect once saved.
        </p>

        {groups.map((group) => (
          <div key={group.key} style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                fontWeight: 400,
                textTransform: 'none',
                fontSize: 13,
                color: 'var(--text)',
                marginBottom: 2,
              }}
            >
              <input
                type="checkbox"
                checked={group.searchedAs === 'fulltext' ? true : !disabled.has(group.key)}
                disabled={group.searchedAs === 'fulltext'}
                onChange={(e) => {
                  const next = new Set(disabled);
                  if (e.target.checked) next.delete(group.key);
                  else next.add(group.key);
                  setDisabled(next);
                }}
                style={{ width: 'auto', marginTop: 3 }}
              />
              <span style={{ flex: 1 }}>
                <strong style={{ fontWeight: 500 }}>{group.label}</strong>{' '}
                <span className="muted small">
                  {group.count}
                  {group.searchedAs === 'fulltext'
                    ? ' · searched in full text'
                    : ` · ${Math.ceil(group.count / 5) * 10} credits`}
                </span>
                <div className="muted small">{group.description}</div>
              </span>
              <button
                className="btn btn-sm"
                onClick={(e) => {
                  e.preventDefault();
                  setExpanded(expanded === group.key ? null : group.key);
                }}
              >
                {expanded === group.key ? 'Hide' : 'Show'}
              </button>
            </label>
            {expanded === group.key && (
              <div className="muted small" style={{ margin: '6px 0 0 24px', lineHeight: 1.9 }}>
                {group.phrases.map((phrase) => (
                  <span key={phrase} className="tag">
                    {phrase}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}

        <h3 className="section-title" style={{ marginTop: 18 }}>
          Additional keywords
        </h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          For a term the derived set does not cover. One to three words, matched as a phrase.
        </p>

        {draft.discovery.queries.map((query, index) => (
          <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input
              value={query}
              onChange={(e) => {
                const next = [...draft.discovery.queries];
                next[index] = e.target.value;
                setQueries(next);
              }}
            />
            <button
              className="btn btn-sm"
              onClick={() => setQueries(draft.discovery.queries.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
        ))}

        <form
          style={{ display: 'flex', gap: 8, marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            const value = newQuery.trim();
            if (value.length < 2) return;
            setQueries([...draft.discovery.queries, value]);
            setNewQuery('');
          }}
        >
          <input
            value={newQuery}
            onChange={(e) => setNewQuery(e.target.value)}
            placeholder="e.g. redox flow battery"
          />
          <button className="btn" type="submit" disabled={newQuery.trim().length < 2}>
            Add
          </button>
        </form>
      </section>

      <TopicGroupsCard groups={config?.topicSearch.groups ?? []} />
      <InstrumentBrandsCard draft={draft} update={update} config={config} />

      <section className="card card-pad">
        <h2 className="section-title">Run defaults</h2>

        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="sinceYear">Only work published since</label>
          <input
            id="sinceYear"
            type="number"
            min={1990}
            max={2100}
            value={draft.discovery.sinceYear ?? ''}
            placeholder="defaults to 3 years ago"
            onChange={(e) =>
              update((d) => ({
                ...d,
                discovery: {
                  ...d.discovery,
                  sinceYear: e.target.value ? Number(e.target.value) : undefined,
                },
              }))
            }
          />
        </div>

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontWeight: 400,
            textTransform: 'none',
            fontSize: 13,
            color: 'var(--text)',
          }}
        >
          <input
            type="checkbox"
            checked={draft.discovery.enrichFacultyFromOpenAlex}
            onChange={(e) =>
              update((d) => ({
                ...d,
                discovery: { ...d.discovery, enrichFacultyFromOpenAlex: e.target.checked },
              }))
            }
            style={{ width: 'auto' }}
          />
          Look up scraped faculty names in OpenAlex
        </label>
        <p className="muted small" style={{ margin: '4px 0 0' }}>
          Strongly recommended. Faculty pages give an email but no research evidence, so without
          this those leads score near zero despite being the only ones you can contact.
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** The OpenAlex topic groups every run searches. Informational — always on. */
function TopicGroupsCard({
  groups,
}: {
  groups: Array<{ key: string; label: string; productLine: string; topics: number }>;
}) {
  return (
    <section className="card card-pad">
      <h2 className="section-title">Research topic groups (OpenAlex)</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        OpenAlex tags every paper with machine-assigned topics. Every run searches all{' '}
        {groups.length} groups — 1 credit each, the cheapest and broadest part of discovery, and
        the only part that finds a group whose abstract never names a technique.
      </p>
      {groups.map((g) => (
        <div key={g.key} style={{ fontSize: 13, marginBottom: 6 }}>
          <strong style={{ fontWeight: 500 }}>{g.label}</strong>
          <span className="muted small">
            {' '}
            · {g.topics} topics · sells: {g.productLine}
          </span>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------

/**
 * Instrument brands.
 *
 * Nobody types model names here any more. Our own brands search for every model
 * in the catalog; a competitor is searched by company name, and which of their
 * instruments a researcher actually uses is read out of the paper text.
 */
function InstrumentBrandsCard({
  draft,
  update,
  config,
}: {
  draft: AppSettings;
  update: (fn: (d: AppSettings) => AppSettings) => void;
  config: DiscoveryConfig | null;
}) {
  const brands = draft.discovery.instrumentBrands;
  const [newBrand, setNewBrand] = useState('');

  const setBrands = (next: InstrumentBrandConfig[]) =>
    update((d) => ({ ...d, discovery: { ...d.discovery, instrumentBrands: next } }));
  const patchBrand = (index: number, patch: Partial<InstrumentBrandConfig>) =>
    setBrands(brands.map((b, i) => (i === index ? { ...b, ...patch } : b)));

  const searchedCount = brands.filter((b) => b.enabled && b.searchEnabled).length;
  const ourModels =
    config?.keywordSearch.groups.find((g) => g.key === 'product_names')?.phrases ?? [];
  /** The terms actually derived for one brand, so each row states its own count. */
  const termsFor = (key: string) =>
    config?.instrumentSearch.brands.find((b) => b.key === key)?.terms ?? [];
  const modelsFor = (key: string) =>
    config?.instrumentSearch.brands.find((b) => b.key === key)?.models ?? [];
  const modelQueryCount = brands
    .filter((b) => b.enabled && b.searchEnabled)
    .reduce((sum, b) => sum + modelsFor(b.key).length, 0);

  const checkboxLabel: React.CSSProperties = {
    display: 'flex',
    gap: 4,
    alignItems: 'center',
    fontWeight: 400,
    textTransform: 'none',
    marginBottom: 0,
  };

  const row = (brand: InstrumentBrandConfig, index: number) => (
    <div
      key={brand.key}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 0',
        borderTop: '1px solid var(--border)',
        flexWrap: 'wrap',
        opacity: brand.enabled ? 1 : 0.55,
      }}
    >
      <span style={{ flex: '1 1 190px', fontSize: 13 }}>{brand.brand}</span>
      <span
        className="muted small"
        style={{ flex: '2 1 280px' }}
        title={`Search: ${termsFor(brand.key).join(', ')}\nModels: ${modelsFor(brand.key).join(', ') || '—'}`}
      >
        {brand.vendor === 'classone'
          ? `${termsFor(brand.key).length} search terms from the catalog · ${modelsFor(brand.key).length} models identifiable`
          : `Company name · ${modelsFor(brand.key).length} known models identifiable`}
      </span>
      <label className="small" style={checkboxLabel}>
        <input
          type="checkbox"
          checked={brand.enabled}
          onChange={(e) => patchBrand(index, { enabled: e.target.checked })}
          style={{ width: 'auto' }}
        />
        detect
      </label>
      <label className="small" style={checkboxLabel}>
        <input
          type="checkbox"
          checked={brand.searchEnabled}
          disabled={!brand.enabled}
          onChange={(e) => patchBrand(index, { searchEnabled: e.target.checked })}
          style={{ width: 'auto' }}
        />
        search (10 cr)
      </label>
      <button className="btn btn-sm" onClick={() => setBrands(brands.filter((_, i) => i !== index))}>
        Remove
      </button>
    </div>
  );

  return (
    <section className="card card-pad">
      <h2 className="section-title">Instruments &amp; brands</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Searched in paper <em>full text</em> — methods sections name the instrument, abstracts
        rarely do. <strong>detect</strong> reads the brand and model out of text at no cost;{' '}
        <strong>search</strong> spends one 10-credit query to find that brand&rsquo;s users.
      </p>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontWeight: 400,
          textTransform: 'none',
          fontSize: 13,
          color: 'var(--text)',
        }}
      >
        <input
          type="checkbox"
          checked={draft.discovery.instrumentSearchEnabled}
          onChange={(e) =>
            update((d) => ({
              ...d,
              discovery: { ...d.discovery, instrumentSearchEnabled: e.target.checked },
            }))
          }
          style={{ width: 'auto' }}
        />
        Run brand full-text searches by default
        <span className="muted small">
          ({searchedCount} brands · {searchedCount * 10} credits per run)
        </span>
      </label>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontWeight: 400,
          textTransform: 'none',
          fontSize: 13,
          color: 'var(--text)',
          marginTop: 6,
          opacity: draft.discovery.instrumentSearchEnabled ? 1 : 0.55,
        }}
      >
        <input
          type="checkbox"
          checked={draft.discovery.identifyModels}
          disabled={!draft.discovery.instrumentSearchEnabled}
          onChange={(e) =>
            update((d) => ({ ...d, discovery: { ...d.discovery, identifyModels: e.target.checked } }))
          }
          style={{ width: 'auto' }}
        />
        Identify the specific model each researcher uses
        <span className="muted small">
          (up to {modelQueryCount} model queries · {modelQueryCount * 10} credits; brands nobody
          uses skip theirs)
        </span>
      </label>
      <p className="muted small" style={{ margin: '4px 0 0 24px' }}>
        The abstract we hold almost never names the instrument, so without this a lead reads
        “PalmSens” rather than “EmStat Pico”. Hover a brand row to see which models it can
        identify. Each brand and model query pages through up to 1,000 papers, so users past the
        first 200 are not missed.
      </p>

      <div className="field" style={{ maxWidth: 260, marginTop: 14 }}>
        <label htmlFor="lookback">Look back (years) for instrument use</label>
        <input
          id="lookback"
          type="number"
          min={1}
          max={30}
          value={draft.discovery.instrumentLookbackYears}
          onChange={(e) =>
            update((d) => ({
              ...d,
              discovery: {
                ...d.discovery,
                instrumentLookbackYears: Math.max(1, Math.min(30, Number(e.target.value) || 7)),
              },
            }))
          }
        />
        <p className="muted small" style={{ margin: '4px 0 0' }}>
          An instrument outlives the paper that first used it. Wider than the topic window on
          purpose; more years means more papers per query and more pages fetched.
        </p>
      </div>

      <h3 className="section-title" style={{ marginTop: 16 }}>
        Class One brands (existing users)
      </h3>
      {brands.map((b, i) => (b.vendor === 'classone' ? row(b, i) : null))}
      <p className="muted small" style={{ margin: '6px 0 0' }}>
        Model names come from the product catalog — {ourModels.slice(0, 8).join(', ')}
        {ourModels.length > 8 ? `, and ${ourModels.length - 8} more` : ''}. Add a product on the
        website and re-run <span className="mono">npm run catalog:export</span> to search for it.
      </p>

      <h3 className="section-title" style={{ marginTop: 16 }}>
        Competitors (proven buyers)
      </h3>
      {brands.map((b, i) => (b.vendor === 'competitor' ? row(b, i) : null))}

      <form
        style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}
        onSubmit={(e) => {
          e.preventDefault();
          const name = newBrand.trim();
          if (name.length < 2) return;
          const key = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
          if (!key || brands.some((b) => b.key === key)) return;
          setBrands([
            ...brands,
            { key, brand: name, vendor: 'competitor', enabled: true, searchEnabled: false },
          ]);
          setNewBrand('');
        }}
      >
        <input
          value={newBrand}
          onChange={(e) => setNewBrand(e.target.value)}
          placeholder="Add a competitor, e.g. Ivium"
          style={{ flex: '1 1 240px' }}
        />
        <button className="btn" type="submit" disabled={newBrand.trim().length < 2}>
          Add
        </button>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------

function InstitutionsTab({
  draft,
  update,
  institutions,
}: {
  draft: AppSettings;
  update: (fn: (d: AppSettings) => AppSettings) => void;
  institutions: SettingsResponse['institutions'];
}) {
  const [filter, setFilter] = useState<InstitutionKind | 'all'>('all');
  const [search, setSearch] = useState('');

  const disabled = new Set(draft.discovery.disabledInstitutionIds);

  const toggleKind = (kind: InstitutionKind) =>
    update((d) => ({
      ...d,
      discovery: {
        ...d.discovery,
        institutionKinds: d.discovery.institutionKinds.includes(kind)
          ? d.discovery.institutionKinds.filter((k) => k !== kind)
          : [...d.discovery.institutionKinds, kind],
      },
    }));

  const toggleInstitution = (id: string) =>
    update((d) => {
      const set = new Set(d.discovery.disabledInstitutionIds);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return {
        ...d,
        discovery: { ...d.discovery, disabledInstitutionIds: [...set] },
      };
    });

  const visible = institutions.items.filter((i) => {
    if (filter !== 'all' && i.kind !== filter) return false;
    if (search && !i.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const activeCount = institutions.items.filter(
    (i) => draft.discovery.institutionKinds.includes(i.kind) && !disabled.has(i.openAlexId),
  ).length;

  return (
    <>
      <section className="card card-pad" style={{ marginBottom: 16 }}>
        <h2 className="section-title">Institute types</h2>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {KINDS.map((kind) => (
            <label key={kind} className="checkbox-row" style={{ marginBottom: 0 }}>
              <input
                type="checkbox"
                checked={draft.discovery.institutionKinds.includes(kind)}
                onChange={() => toggleKind(kind)}
              />
              {kind}s <span className="muted small">({institutions.counts[kind]})</span>
            </label>
          ))}
        </div>
        <p className="muted small" style={{ margin: '10px 0 0' }}>
          <strong>{activeCount}</strong> of {institutions.total} institutions will be searched.
          Matching is by OpenAlex institution id, so it is exact — not name matching.
        </p>
      </section>

      <div className="toolbar">
        <input
          placeholder="Search institutions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 260 }}
        />
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">All types</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}s only
            </option>
          ))}
        </select>
        <span className="muted small" style={{ marginLeft: 'auto' }}>
          {visible.length} shown
        </span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 90 }}>Include</th>
              <th>Institution</th>
              <th style={{ width: 70 }}>Type</th>
              <th style={{ width: 110 }}>Indexed works</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((institution) => {
              const kindOff = !draft.discovery.institutionKinds.includes(institution.kind);
              const off = disabled.has(institution.openAlexId);
              return (
                <tr key={institution.openAlexId} style={kindOff ? { opacity: 0.45 } : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      checked={!off}
                      disabled={kindOff}
                      onChange={() => toggleInstitution(institution.openAlexId)}
                      style={{ width: 'auto' }}
                    />
                  </td>
                  <td>
                    {institution.name}
                    {kindOff && (
                      <span className="muted small"> — {institution.kind}s are turned off</span>
                    )}
                  </td>
                  <td>
                    <span className="badge badge-neutral">{institution.kind}</span>
                  </td>
                  <td className="small muted">{institution.worksCount.toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function SourcesTab({
  draft,
  update,
  reload,
}: {
  draft: AppSettings;
  update: (fn: (d: AppSettings) => AppSettings) => void;
  reload: () => void;
}) {
  const [adding, setAdding] = useState<'faculty' | 'news' | null>(null);
  const [form, setForm] = useState({ universityName: '', department: '', url: '' });
  const [addError, setAddError] = useState<string | null>(null);

  async function addTarget() {
    if (!adding) return;
    setAddError(null);
    try {
      await api.addTarget({
        kind: adding,
        universityName: form.universityName.trim(),
        department: form.department.trim() || undefined,
        url: form.url.trim(),
        enabled: true,
      });
      setForm({ universityName: '', department: '', url: '' });
      setAdding(null);
      reload();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Could not add the target');
    }
  }

  async function removeTarget(targetId: string) {
    if (!window.confirm('Remove this source?')) return;
    await api.deleteTarget(targetId);
    reload();
  }

  const renderList = (kind: 'faculty' | 'news', targets: ScrapeTargetConfig[]) => (
    <section className="card card-pad" style={{ marginBottom: 16 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <h2 className="section-title" style={{ margin: 0 }}>
          {kind === 'faculty' ? 'Faculty pages' : 'News feeds'}{' '}
          <span className="muted">({targets.filter((t) => t.enabled).length} enabled)</span>
        </h2>
        <button className="btn btn-sm" onClick={() => setAdding(adding === kind ? null : kind)}>
          {adding === kind ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {adding === kind && (
        <div className="card-pad" style={{ background: 'var(--surface-alt)', borderRadius: 6, marginBottom: 12 }}>
          {addError && <ErrorBanner message={addError} />}
          <div className="form-grid">
            <div className="field">
              <label>Institution name *</label>
              <input
                value={form.universityName}
                onChange={(e) => setForm({ ...form, universityName: e.target.value })}
                placeholder="Indian Institute of Technology Bombay"
              />
            </div>
            {kind === 'faculty' && (
              <div className="field">
                <label>Department</label>
                <input
                  value={form.department}
                  onChange={(e) => setForm({ ...form, department: e.target.value })}
                  placeholder="Chemistry"
                />
              </div>
            )}
          </div>
          <div className="field">
            <label>URL *</label>
            <input
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://chem.example.ac.in/faculty"
            />
          </div>
          <button
            className="btn btn-primary btn-sm"
            onClick={addTarget}
            disabled={!form.universityName.trim() || !form.url.trim()}
          >
            Add source
          </button>
          <p className="muted small" style={{ margin: '8px 0 0' }}>
            Add it, then run discovery to see whether it yields anything — many university sites
            block crawlers or render their directories with JavaScript.
          </p>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 60 }}>On</th>
              <th>Institution</th>
              <th>URL</th>
              <th style={{ width: 130 }}>Last result</th>
              <th style={{ width: 70 }}></th>
            </tr>
          </thead>
          <tbody>
            {targets.length === 0 && (
              <tr>
                <td colSpan={5} className="muted small" style={{ textAlign: 'center' }}>
                  No sources configured.
                </td>
              </tr>
            )}
            {targets.map((target) => (
              <tr key={target.targetId} style={target.enabled ? undefined : { opacity: 0.5 }}>
                <td>
                  <input
                    type="checkbox"
                    checked={target.enabled}
                    style={{ width: 'auto' }}
                    onChange={() =>
                      update((d) => {
                        const key = kind === 'faculty' ? 'facultyTargets' : 'newsTargets';
                        return {
                          ...d,
                          [key]: d[key].map((t) =>
                            t.targetId === target.targetId ? { ...t, enabled: !t.enabled } : t,
                          ),
                        };
                      })
                    }
                  />
                </td>
                <td>
                  {target.universityName}
                  {target.department && (
                    <div className="muted small">{target.department}</div>
                  )}
                  {target.note && (
                    <div className="muted small">
                      <em>{target.note}</em>
                    </div>
                  )}
                </td>
                <td className="small mono" style={{ wordBreak: 'break-all' }}>
                  <a href={target.url} target="_blank" rel="noreferrer">
                    {target.url}
                  </a>
                </td>
                <td className="small">
                  {target.lastCheckedAt ? (
                    <>
                      {target.lastPeopleFound ?? 0} found
                      {target.lastFetchTier && (
                        <div className="muted small">via {target.lastFetchTier}</div>
                      )}
                    </>
                  ) : (
                    <span className="muted">not run yet</span>
                  )}
                </td>
                <td>
                  <button
                    className="btn btn-sm"
                    onClick={() => removeTarget(target.targetId)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );

  return (
    <>
      {renderList('faculty', draft.facultyTargets)}
      {renderList('news', draft.newsTargets)}
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * Wipe the CRM: every lead, email thread and activity entry, gone.
 *
 * Two deliberate frictions — the live counts of what will be removed, and a
 * typed confirmation rather than an OK button — because there is no undo and
 * "clear the test data" and "delete every real lead" look identical to code.
 * Settings, the product catalog and the OpenAlex cache are not touched.
 */
function DangerZoneTab() {
  const { data: stats, reload } = useAsync(() => api.crmStats(), []);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const armed = typed.trim() === 'WIPE';

  async function wipe() {
    if (!armed) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const removed = await api.wipeCrm();
      setResult(
        `Removed ${removed.leads} lead${removed.leads === 1 ? '' : 's'}, ${removed.threads} email thread${removed.threads === 1 ? '' : 's'} and ${removed.activity} activity entries.`,
      );
      setTyped('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wipe failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="detail-grid">
      <section className="card card-pad" style={{ borderColor: 'var(--danger)' }}>
        <h2 className="section-title" style={{ color: 'var(--danger)' }}>
          Wipe the CRM
        </h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Deletes every lead, email thread and activity entry so discovery can start from
          nothing. There is no undo. Settings, the product catalog and the OpenAlex cache are
          kept, so the next run is configured exactly as this one and costs no more credits than
          it has to.
        </p>

        <dl className="kv" style={{ marginBottom: 14 }}>
          <dt>Leads</dt>
          <dd>{stats ? stats.leads.toLocaleString() : '…'}</dd>
          <dt>Email threads</dt>
          <dd>{stats ? stats.threads.toLocaleString() : '…'}</dd>
          <dt>Activity entries</dt>
          <dd>{stats ? stats.activity.toLocaleString() : '…'}</dd>
        </dl>

        <div className="field" style={{ maxWidth: 320 }}>
          <label htmlFor="wipe-confirm">
            Type <span className="mono">WIPE</span> to confirm
          </label>
          <input
            id="wipe-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="WIPE"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <button
          className="btn btn-danger"
          onClick={wipe}
          disabled={!armed || busy || !stats || stats.leads + stats.threads + stats.activity === 0}
        >
          {busy ? 'Wiping…' : 'Wipe all CRM data'}
        </button>

        {result && (
          <div className="alert alert-success" style={{ marginTop: 14 }}>
            {result}
          </div>
        )}
        {error && (
          <div style={{ marginTop: 14 }}>
            <ErrorBanner message={error} />
          </div>
        )}
      </section>

      <section className="card card-pad">
        <h2 className="section-title">What is not touched</h2>
        <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
          <li>Search keywords, topic groups, brands, institute list, scrape targets — everything on the other tabs.</li>
          <li>The product catalog (re-synced from the website with <span className="mono">npm run catalog:export</span>).</li>
          <li>The 24-hour OpenAlex response cache, so a re-run right after a wipe is nearly free.</li>
        </ul>
        <p className="muted small" style={{ marginBottom: 0 }}>
          To reset those as well, use <em>Reset to defaults</em> at the top of this page, or{' '}
          <span className="mono">npm run db:reset</span> from a terminal for a full local wipe.
        </p>
      </section>
    </div>
  );
}

function ScrapingTab({
  draft,
  update,
}: {
  draft: AppSettings;
  update: (fn: (d: AppSettings) => AppSettings) => void;
}) {
  const set = (key: keyof AppSettings['scraping'], value: boolean | number) =>
    update((d) => ({ ...d, scraping: { ...d.scraping, [key]: value } }));

  return (
    <div className="detail-grid">
      <section className="card card-pad">
        <h2 className="section-title">Fetch escalation</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Pages are fetched with plain HTTP first. When that returns nothing usable, the request
          escalates to a real browser, then to a proxied browser.
        </p>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draft.scraping.allowBrowser}
            onChange={(e) => set('allowBrowser', e.target.checked)}
          />
          Allow the browser tier (Playwright)
        </label>
        <p className="muted small" style={{ margin: '2px 0 12px 26px' }}>
          Needed for directories rendered in JavaScript, which return an empty page over plain
          HTTP. Costs roughly 10-30x a normal fetch, so it only runs when the cheap path fails.
        </p>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draft.scraping.allowProxy}
            onChange={(e) => set('allowProxy', e.target.checked)}
          />
          Allow the proxy tier
        </label>
        <p className="muted small" style={{ margin: '2px 0 0 26px' }}>
          Only does anything if proxy credentials are set in <span className="mono">.env</span>.
          Most sites that block us do so by IP reputation, which survives a real browser — a
          different egress IP is the only thing that changes the outcome.
        </p>
      </section>

      <section className="card card-pad">
        <h2 className="section-title">Per-lead web enrichment</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          “Enrich from web” on a lead reads the institute profile page (email, designation,
          phone), ORCID (lab website), the lab site’s facilities pages (instruments owned) and
          open-access copies of recent papers (the Methods section). Fills only blank fields
          and spends no OpenAlex credits — single-record lookups are free.
        </p>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draft.scraping.enrichFromLabSites}
            onChange={(e) => set('enrichFromLabSites', e.target.checked)}
          />
          Follow the lab / personal website and its facilities pages
        </label>

        <div className="field" style={{ maxWidth: 260, marginTop: 10 }}>
          <label htmlFor="maxEnrichPages">Page budget per lead</label>
          <input
            id="maxEnrichPages"
            type="number"
            min={1}
            max={30}
            value={draft.scraping.maxEnrichmentPagesPerLead}
            onChange={(e) => set('maxEnrichmentPagesPerLead', Math.max(1, Math.min(30, Number(e.target.value) || 8)))}
          />
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            Directory, profile and lab pages combined. Each page waits on the per-domain delay.
          </p>
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draft.scraping.readOpenAccessPapers}
            onChange={(e) => set('readOpenAccessPapers', e.target.checked)}
          />
          Read open-access papers for the Methods section
        </label>

        <div className="field" style={{ maxWidth: 260, marginTop: 10 }}>
          <label htmlFor="maxPapers">Papers per lead</label>
          <input
            id="maxPapers"
            type="number"
            min={0}
            max={10}
            value={draft.scraping.maxPapersPerLead}
            onChange={(e) => set('maxPapersPerLead', Math.max(0, Math.min(10, Number(e.target.value) || 0)))}
          />
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            Only papers OpenAlex marks as open access are ever fetched. This covers instruments
            OpenAlex has no full text for.
          </p>
        </div>
      </section>

      <section className="card card-pad">
        <h2 className="section-title">Email recovery</h2>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draft.scraping.followProfiles}
            onChange={(e) => set('followProfiles', e.target.checked)}
          />
          Follow profile links to find email addresses
        </label>
        <p className="muted small" style={{ margin: '2px 0 12px 26px' }}>
          Indian faculty index pages rarely publish emails, but the linked profile usually does.
          Role addresses like <span className="mono">registrar@</span> are rejected.
        </p>

        <div className="field" style={{ maxWidth: 200 }}>
          <label htmlFor="maxProfileFetches">Max profile fetches per source</label>
          <input
            id="maxProfileFetches"
            type="number"
            min={0}
            max={100}
            value={draft.scraping.maxProfileFetches}
            onChange={(e) => set('maxProfileFetches', Number(e.target.value))}
          />
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            Each fetch waits out the per-domain rate limit, so this is the main driver of how
            long a run takes.
          </p>
        </div>
      </section>
    </div>
  );
}
