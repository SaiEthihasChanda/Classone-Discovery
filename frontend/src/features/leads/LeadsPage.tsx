import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type BrandOption, type LeadListParams } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import {
  AffiliationNote,
  EmptyState,
  ErrorBanner,
  InstrumentBadge,
  Loading,
  ScorePill,
  SourceBadge,
  StatusBadge,
  formatDate,
} from '../../components/common';

const PAGE_SIZE = 25;

/** Hands a blob to the browser as a file download. */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Multi-select of instrument brands, as a dropdown of checkboxes.
 *
 * A native `<details>` rather than a custom popover: it opens and closes
 * without any state, closes on Escape, and needs no outside-click handling.
 */
function BrandFilter({
  options,
  selected,
  onChange,
}: {
  options: BrandOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (key: string) =>
    onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);

  const label =
    selected.length === 0
      ? 'Device owners: any'
      : selected.length <= 2
        ? `Device owners: ${selected
            .map((k) => options.find((o) => o.key === k)?.brand ?? k)
            .join(', ')}`
        : `Device owners: ${selected.length} brands`;

  const group = (vendor: BrandOption['vendor'], heading: string) => {
    const items = options.filter((o) => o.vendor === vendor);
    if (items.length === 0) return null;
    return (
      <>
        <div className="dropdown-heading">{heading}</div>
        {items.map((o) => (
          <label key={o.key} className="dropdown-option">
            <input
              type="checkbox"
              checked={selected.includes(o.key)}
              onChange={() => toggle(o.key)}
              style={{ width: 'auto' }}
            />
            {o.brand}
          </label>
        ))}
      </>
    );
  };

  return (
    <details className="dropdown">
      <summary className={`btn btn-sm${selected.length > 0 ? ' btn-primary' : ''}`}>{label} ▾</summary>
      <div className="dropdown-menu">
        {group('classone', 'Class One brands')}
        {group('competitor', 'Competitors')}
        {selected.length > 0 && (
          <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => onChange([])}>
            Clear
          </button>
        )}
      </div>
    </details>
  );
}

/** One badge per brand in the table, carrying every model identified for it. */
function groupByBrand(
  items: Array<{ brandKey: string; brand: string; vendor: 'classone' | 'competitor'; model?: string }>,
): Array<{ brandKey: string; brand: string; vendor: 'classone' | 'competitor'; models: string[] }> {
  const out: Array<{ brandKey: string; brand: string; vendor: 'classone' | 'competitor'; models: string[] }> = [];
  for (const i of items) {
    let entry = out.find((e) => e.brandKey === i.brandKey);
    if (!entry) {
      entry = { brandKey: i.brandKey, brand: i.brand, vendor: i.vendor, models: [] };
      out.push(entry);
    }
    if (i.model && !entry.models.includes(i.model)) entry.models.push(i.model);
  }
  return out;
}

export function LeadsPage() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState('');
  const [brands, setBrands] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<'createdAt' | 'score' | 'name'>('createdAt');
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichNote, setEnrichNote] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  /** Re-check "still at this institute?" for everything matching the filter. Free. */
  async function verifyAffiliationsNow() {
    if (!data) return;
    if (
      !window.confirm(
        `Re-check the current institute of all ${data.total} lead${data.total === 1 ? '' : 's'} matching this filter?\n\n` +
          'Uses free OpenAlex and ORCID lookups — no credits. A lead found to have moved shows its new institute; one that cannot be placed shows none.',
      )
    ) {
      return;
    }
    const deep = window.confirm(
      'Also consult the institute directory and the IRINS/Vidwan registries?\n\n' +
        'Most current sources, but page fetches via the scraper service — roughly 20-60 seconds per lead. OK = yes, Cancel = free lookups only.',
    );
    setVerifying(true);
    setEnrichNote(null);
    setExportError(null);
    try {
      const r = await api.verifyAffiliations({
        ...(status ? { status } : {}),
        ...(brands.length > 0 ? { brands } : {}),
        limit: deep ? 100 : 2000,
        deep,
      });
      setEnrichNote(
        `Checked ${r.checked}: ${r.current} still there, ${r.moved} moved, ${r.unknown} could not be placed (institute cleared)` +
          (r.skipped > 0 ? `; ${r.skipped} skipped (no OpenAlex record).` : '.'),
      );
      reload();
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setVerifying(false);
    }
  }

  /** Web enrichment for the leads on this page — sequential, a few minutes at most. */
  async function enrichVisible() {
    if (!data || data.items.length === 0) return;
    const ids = data.items.map((l) => l.id);
    if (
      !window.confirm(
        `Read institute profile pages, lab websites and open-access papers for the ${ids.length} lead${ids.length === 1 ? '' : 's'} on this page?\n\n` +
          'Fills only blank fields. Uses the scraper service, not OpenAlex credits. Roughly 20-40 seconds per lead.',
      )
    ) {
      return;
    }
    setEnriching(true);
    setEnrichNote(null);
    setExportError(null);
    try {
      const { results } = await api.enrichLeadsFromWeb(ids);
      const ok = results.filter((r) => !r.error);
      const emails = ok.filter((r) => r.filled?.includes('email')).length;
      const withInst = ok.filter((r) => (r.instruments?.length ?? 0) > 0).length;
      const failed = results.filter((r) => r.error);
      setEnrichNote(
        `${ok.length} enriched — ${emails} new email${emails === 1 ? '' : 's'}, ${withInst} with instruments found.` +
          (failed.length > 0 ? ` ${failed.length} failed: ${failed[0]!.error}` : ''),
      );
      reload();
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Enrichment failed');
    } finally {
      setEnriching(false);
    }
  }

  const { data: brandOptions } = useAsync(() => api.leadBrandOptions(), []);

  // Debounced so a request is not fired on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(id);
  }, [search]);

  // The filters as sent to the API — shared by the list and the CSV export, so
  // "download what I am looking at" is exactly that.
  const filters: LeadListParams = {
    search: debouncedSearch || undefined,
    status: status || undefined,
    brands: brands.length > 0 ? brands : undefined,
    sortBy,
    sortDir: sortBy === 'name' ? 'asc' : 'desc',
  };
  const brandsKey = brands.join(',');

  const { data, loading, error, reload } = useAsync(
    () => api.listLeads({ ...filters, limit: PAGE_SIZE, skip: page * PAGE_SIZE }),
    [debouncedSearch, status, brandsKey, sortBy, page],
  );

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const hasFilters = Boolean(debouncedSearch || status || brands.length > 0);

  async function exportCsv() {
    setExporting(true);
    setExportError(null);
    try {
      const { blob, filename } = await api.exportLeadsCsv(filters);
      saveBlob(blob, filename);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Leads / CRM</h1>
          <p>One record per prospect — contact details, research, score and thread history.</p>
        </div>
        <Link className="btn btn-primary" to="/leads/new">
          + Add lead
        </Link>
      </div>

      <div className="toolbar">
        <input
          placeholder="Search name, email or institution…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 280 }}
        />
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(0);
          }}
        >
          <option value="">All statuses</option>
          <option value="pending_review">Pending review</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="customer">Customer</option>
        </select>
        <BrandFilter
          options={brandOptions?.items ?? []}
          selected={brands}
          onChange={(next) => {
            setBrands(next);
            setPage(0);
          }}
        />
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
          <option value="createdAt">Newest first</option>
          <option value="score">Highest score</option>
          <option value="name">Name (A–Z)</option>
        </select>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          {data && (
            <span className="muted small">
              {data.total} lead{data.total === 1 ? '' : 's'}
            </span>
          )}
          <button
            className="btn btn-sm"
            onClick={verifyAffiliationsNow}
            disabled={verifying || !data || data.total === 0}
            title="Re-check whether each lead is still at their institute (free OpenAlex lookups)"
          >
            {verifying ? 'Verifying…' : 'Verify affiliations'}
          </button>
          <button
            className="btn btn-sm"
            onClick={enrichVisible}
            disabled={enriching || !data || data.items.length === 0}
            title="Profile page, lab website and open-access papers for the leads on this page — fills blank emails, titles and instruments"
          >
            {enriching ? 'Enriching…' : `Enrich this page from web${data ? ` (${data.items.length})` : ''}`}
          </button>
          <button
            className="btn btn-sm"
            onClick={exportCsv}
            disabled={exporting || !data || data.total === 0}
            title="Download every lead matching the current filters"
          >
            {exporting ? 'Preparing…' : `Download CSV${data ? ` (${data.total})` : ''}`}
          </button>
        </div>
      </div>

      {exportError && <ErrorBanner message={exportError} />}
      {enrichNote && <div className="alert alert-success">{enrichNote}</div>}
      {error && <ErrorBanner message={error} />}
      {loading && !data && <Loading />}

      {data && data.items.length === 0 && (
        <EmptyState>
          {hasFilters ? (
            <>No leads match these filters.</>
          ) : (
            <>
              No leads yet. <Link to="/leads/new">Add your first lead</Link> to get started.
            </>
          )}
        </EmptyState>
      )}

      {data && data.items.length > 0 && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Institution</th>
                  <th>Email</th>
                  <th>Score</th>
                  <th>Instruments</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((lead) => (
                  <tr key={lead.id}>
                    <td>
                      <Link to={`/leads/${lead.id}`}>
                        <strong>{lead.person.name}</strong>
                      </Link>
                      {lead.person.title && (
                        <div className="muted small">{lead.person.title}</div>
                      )}
                    </td>
                    <td>
                      {lead.institution.name ?? <span className="muted">—</span>}
                      {lead.institution.department && (
                        <div className="muted small">{lead.institution.department}</div>
                      )}
                      <AffiliationNote
                        affiliation={lead.institution.affiliation}
                        institutionName={lead.institution.name}
                      />
                    </td>
                    <td className="small">
                      {lead.person.email ?? <span className="muted">—</span>}
                    </td>
                    <td>
                      <ScorePill score={lead.aiScoring.relevanceScore} />
                    </td>
                    <td>
                      {(lead.research.instruments ?? []).length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {groupByBrand(lead.research.instruments ?? []).map((inst) => (
                            <InstrumentBadge
                              key={inst.brandKey}
                              vendor={inst.vendor}
                              brand={inst.brand}
                              model={inst.models.join(' / ') || undefined}
                            />
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={lead.status} />
                    </td>
                    <td>
                      <SourceBadge source={lead.source.type} />
                    </td>
                    <td className="small muted">{formatDate(lead.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="pagination">
              <button
                className="btn btn-sm"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <span className="muted">
                Page {page + 1} of {totalPages}
              </span>
              <button
                className="btn btn-sm"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
