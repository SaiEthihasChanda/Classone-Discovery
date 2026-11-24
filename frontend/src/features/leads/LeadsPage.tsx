import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type BrandOption, type LeadListParams } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import { EmptyState, ErrorBanner, InstrumentBadge, Loading, ScorePill, StatusBadge, shortInstitute } from '../../components/common';
import { Icon, Segmented } from '../../components/ui';
import { useAuth } from '../../auth/AuthProvider';
import { LeadRecord } from './LeadRecord';
import { AnimatePresence, cardMotion, motion } from '../../components/motion';

const PAGE_SIZE = 24;

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

type StatusKey = 'pending_review' | 'approved' | 'customer' | 'rejected' | 'all';

const STATUS_TABS: Array<{ key: StatusKey; label: string }> = [
  { key: 'pending_review', label: 'To review' },
  { key: 'approved', label: 'Approved' },
  { key: 'customer', label: 'Customers' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
];

/**
 * Every lead as a grid of compact cards — the review queue is just the "To
 * review" view. Clicking a card opens the record in a side panel
 * (`?open=<id>`), so the grid stays in place while you work through leads.
 */
export function LeadsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const status = (params.get('status') as StatusKey | null) ?? 'pending_review';

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [brands, setBrands] = useState<string[]>([]);
  const [minScore, setMinScore] = useState(0);
  const [sortBy, setSortBy] = useState<'createdAt' | 'score' | 'name'>('score');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const setQuery = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v === null ? next.delete(k) : next.set(k, v));
    setParams(next, { replace: true });
  };

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const filters: LeadListParams = {
    search: debouncedSearch || undefined,
    status: status === 'all' ? undefined : status,
    brands: brands.length > 0 ? brands : undefined,
    minScore: minScore > 0 ? minScore : undefined,
    sortBy,
    sortDir: sortBy === 'name' ? 'asc' : 'desc',
  };

  const { data: brandOptions } = useAsync(() => api.leadBrandOptions(), []);
  const { data: catalog } = useAsync(() => api.listProducts(), []);
  const productName = new Map((catalog?.items ?? []).flatMap((p) => [[p.productId, p.name] as const, [p.id, p.name] as const]));
  const { data, loading, error, reload } = useAsync(
    () => api.listLeads({ ...filters, limit: PAGE_SIZE, skip: page * PAGE_SIZE }),
    [debouncedSearch, status, brands.join(','), minScore, sortBy, page],
  );
  // Counts for the status tabs — one tiny request each.
  const { data: counts, reload: reloadCounts } = useAsync(async () => {
    const keys = ['pending_review', 'approved', 'customer', 'rejected'] as const;
    const results = await Promise.all(keys.map((s) => api.listLeads({ status: s, limit: 1 })));
    const out: Record<string, number> = {};
    keys.forEach((k, i) => (out[k] = results[i]!.total));
    out.all = Object.values(out).reduce((a, b) => a + b, 0);
    return out;
  }, []);

  const refresh = () => {
    reload();
    reloadCounts();
  };

  async function decide(id: string, decision: 'approved' | 'rejected') {
    let reason: string | undefined;
    if (decision === 'rejected') reason = window.prompt('Reason for rejecting? (optional)') ?? undefined;
    setBusy(id);
    setActionError(null);
    try {
      await api.reviewLead(id, decision, reason);
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not record the decision');
    } finally {
      setBusy(null);
    }
  }

  async function approveAll() {
    if (!data) return;
    const scope = minScore > 0 ? ` scoring ${minScore}+` : '';
    if (!window.confirm(`Approve all ${data.total} lead${data.total === 1 ? '' : 's'} waiting for review${scope}?\n\nApproved leads become eligible for outreach.`)) return;
    setBusy('bulk');
    setActionError(null);
    try {
      const r = await api.bulkReview({ decision: 'approved', ...(minScore > 0 ? { minScore } : {}) });
      setNote(`Approved ${r.updated} lead${r.updated === 1 ? '' : 's'}.`);
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Bulk approval failed');
    } finally {
      setBusy(null);
    }
  }

  async function exportCsv() {
    setBusy('export');
    try {
      const { blob, filename } = await api.exportLeadsCsv(filters);
      saveBlob(blob, filename);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setBusy(null);
    }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Leads</h1>
          <p>Researchers promoted from Prospects. Review them, then reach out from the lead itself.</p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={exportCsv} disabled={busy === 'export' || !data?.total}>
            Export CSV
          </button>
          {can('sales') && (
            <Link className="btn btn-primary" to="/leads/new">
              <Icon name="plus" size={16} /> Add lead
            </Link>
          )}
        </div>
      </div>

      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <Segmented
          items={STATUS_TABS.map((t) => ({ ...t, count: counts?.[t.key] }))}
          value={status}
          onChange={(k) => {
            setQuery({ status: k });
            setPage(0);
          }}
        />
        {status === 'pending_review' && can('sales') && data && data.total > 0 && (
          <button className="btn btn-success btn-sm" onClick={approveAll} disabled={busy === 'bulk'}>
            {busy === 'bulk' ? 'Approving…' : `Approve all ${data.total}${minScore > 0 ? ` (${minScore}+)` : ''}`}
          </button>
        )}
      </div>

      <div className="toolbar">
        <input className="search" placeholder="Search name, email or institution" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={minScore} onChange={(e) => { setMinScore(Number(e.target.value)); setPage(0); }} style={{ minWidth: 140 }}>
          <option value={0}>Any score</option>
          <option value={40}>Score 40+</option>
          <option value={60}>Score 60+</option>
          <option value={70}>Score 70+</option>
        </select>
        <BrandFilter options={brandOptions?.items ?? []} selected={brands} onChange={(next) => { setBrands(next); setPage(0); }} />
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} style={{ minWidth: 150 }}>
          <option value="score">Highest score</option>
          <option value="createdAt">Newest first</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>

      {note && <div className="alert alert-success">{note}</div>}
      {actionError && <ErrorBanner message={actionError} />}
      {error && <ErrorBanner message={error} />}
      {loading && !data && <Loading />}

      {data && data.items.length === 0 && (
        <div className="card">
          <EmptyState>{status === 'pending_review' ? 'Nothing waiting for review.' : 'No leads match.'}</EmptyState>
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="lead-grid">
          <AnimatePresence mode="popLayout" initial={false}>
          {data.items.map((lead) => {
            const instruments = groupByBrand(lead.research.instruments ?? []);
            const product = lead.aiScoring.recommendedProductIds.map((pid) => productName.get(pid)).find(Boolean);
            const open = () => setQuery({ open: lead.id });
            return (
              <motion.article
                key={lead.id}
                {...cardMotion}
                className={`lead-card${openId === lead.id ? ' selected' : ''}`}
                role="button"
                tabIndex={0}
                onClick={open}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    open();
                  }
                }}
              >
                <div className="head">
                  <div className="who">
                    <strong>{lead.person.name}</strong>
                    <div className="sub">{lead.person.title ?? lead.person.email ?? '—'}</div>
                  </div>
                  <ScorePill score={lead.aiScoring.relevanceScore} />
                </div>
                <div className="facts">
                  <span>
                    {lead.institution.name ? shortInstitute(lead.institution.name) : <span className="muted">Institute unknown</span>}
                    {lead.institution.department && <span className="muted"> · {lead.institution.department.replace(/^(Department|School) of /i, '')}</span>}
                  </span>
                  {product && (
                    <span>
                      <span className="muted">Pitch: </span>
                      {product}
                    </span>
                  )}
                </div>
                {instruments.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {instruments.slice(0, 2).map((inst) => (
                      <InstrumentBadge key={inst.brandKey} vendor={inst.vendor} brand={inst.brand} model={inst.models.join(' / ') || undefined} />
                    ))}
                  </div>
                )}
                {(status === 'all' || (status === 'pending_review' && can('sales'))) && (
                  <div className="foot" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    {status === 'all' && <StatusBadge status={lead.status} />}
                    {status === 'pending_review' && can('sales') && (
                      <>
                        <button className="btn btn-success btn-sm" disabled={busy === lead.id} onClick={() => void decide(lead.id, 'approved')}>
                          Approve
                        </button>
                        <button className="btn btn-ghost btn-sm" disabled={busy === lead.id} onClick={() => void decide(lead.id, 'rejected')}>
                          Reject
                        </button>
                      </>
                    )}
                  </div>
                )}
              </motion.article>
            );
          })}
          </AnimatePresence>
        </div>
      )}

      {totalPages > 1 && (
        <div className="pagination">
          <button className="btn btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span className="muted">
            Page {page + 1} of {totalPages}
          </span>
          <button className="btn btn-sm" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      )}

      {openId && <LeadRecord id={openId} onClose={() => setQuery({ open: null })} onChanged={refresh} />}
    </>
  );
}
