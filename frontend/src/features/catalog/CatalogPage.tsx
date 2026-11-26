import { useState } from 'react';
import { api } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState, ErrorBanner, Loading, relativeTime } from '../../components/common';
import type { Product } from '../../types';

const CATEGORY_LABELS: Record<string, string> = {
  potentiostat_portable: 'Portable potentiostat',
  potentiostat_benchtop: 'Benchtop potentiostat',
  multi_channel_workstation: 'Multi-channel workstation',
  single_channel_workstation: 'Single-channel workstation',
  biosensor_kit: 'Biosensor kit',
  spectroelectrochemistry: 'Spectroelectrochemistry',
  application_kit: 'Application kit',
  oem_module: 'OEM module / dev kit',
  battery_equipment: 'Battery equipment (TOB)',
  thin_film_deposition: 'Thin film & coating (Nano)',
  electrode: 'Electrode / cell',
  software_sdk: 'Software / SDK',
  accessory: 'Accessory',
};

/**
 * The product catalog that grounds the AI — and drives discovery's keywords.
 *
 * Kept in step with classonesystems.in automatically (services/catalog/catalogWatcher.ts):
 * a product added there appears here within 30 minutes, its application areas and
 * keywords derived by the AI. Those can be corrected here; discovery and scoring use
 * the change from their next run.
 */
export function CatalogPage() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useAsync(() => api.listProducts(), []);
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'new' | 'inactive'>('all');

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBanner message={error} />;
  const items = (data?.items ?? []).filter((p) => (filter === 'new' ? p.aiDerived : filter === 'inactive' ? !p.isActive : true));

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Product Catalog</h1>
          <p>What the AI matches leads against and what discovery searches for. Kept in step with classonesystems.in automatically.</p>
        </div>
      </div>
      <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        {(['all', 'new', 'inactive'] as const).map((f) => (
          <button key={f} className={`chip${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'new' ? 'Added from the website' : 'No longer on the website'}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <EmptyState>{filter === 'all' ? 'Catalog is empty.' : 'Nothing here.'}</EmptyState>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th>Application areas</th>
                <th>Search keywords</th>
                {can('admin') && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((product) =>
                editing === product.id ? (
                  <EditRow key={product.id} product={product} onDone={() => (setEditing(null), reload())} />
                ) : (
                  <tr key={product.id} style={product.isActive ? undefined : { opacity: 0.55 }}>
                    <td>
                      <strong>{product.name}</strong>
                      {product.aiDerived && <span className="launch-tag" style={{ marginLeft: 6 }}>From website · AI</span>}
                      {!product.isActive && <span className="tag-dnc" style={{ marginLeft: 6 }}>Inactive</span>}
                      {product.description && <div className="muted small clamp-2">{product.description}</div>}
                      {product.lastSyncedAt && <div className="muted small">Checked {relativeTime(product.lastSyncedAt)}</div>}
                    </td>
                    <td className="small">{CATEGORY_LABELS[product.category] ?? product.category}</td>
                    <td>{product.applicationAreas.length === 0 ? <span className="muted">—</span> : product.applicationAreas.map((a) => <span key={a} className="tag">{a}</span>)}</td>
                    <td>{product.tags.length === 0 ? <span className="muted">—</span> : product.tags.slice(0, 8).map((t) => <span key={t} className="tag">{t}</span>)}</td>
                    {can('admin') && (
                      <td>
                        <button className="btn btn-sm btn-ghost" onClick={() => setEditing(product.id)}>
                          Edit
                        </button>
                      </td>
                    )}
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function EditRow({ product, onDone }: { product: Product; onDone: () => void }) {
  const [areas, setAreas] = useState(product.applicationAreas.join(', '));
  const [tags, setTags] = useState(product.tags.join(', '));
  const [active, setActive] = useState(product.isActive);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = (s: string) => [...new Set(s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.updateProduct(product.id, { applicationAreas: list(areas), tags: list(tags), isActive: active });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
      setBusy(false);
    }
  };
  return (
    <tr>
      <td>
        <strong>{product.name}</strong>
        <label className="switch-row" style={{ marginTop: 6 }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active (used for matching and discovery)
        </label>
        {error && <div className="composer-error">{error}</div>}
      </td>
      <td className="small">{CATEGORY_LABELS[product.category] ?? product.category}</td>
      <td>
        <textarea rows={3} style={{ width: '100%' }} value={areas} onChange={(e) => setAreas(e.target.value)} placeholder="comma-separated" />
      </td>
      <td>
        <textarea rows={3} style={{ width: '100%' }} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma-separated" />
      </td>
      <td>
        <div style={{ display: 'grid', gap: 6 }}>
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void save()}>
            Save
          </button>
          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={onDone}>
            Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}
