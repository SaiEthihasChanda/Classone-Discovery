import { api } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import { EmptyState, ErrorBanner, Loading } from '../../components/common';

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
 * The product catalog that grounds the AI.
 *
 * Read-only here: relevance scoring and product mapping compare a researcher's
 * work against these records, so what matters in Phase 1 is being able to see
 * what the AI will be reasoning against.
 */
export function CatalogPage() {
  const { data, loading, error } = useAsync(() => api.listProducts(), []);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBanner message={error} />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Product Catalog</h1>
          <p>What the AI matches leads against when recommending a product.</p>
        </div>
      </div>

      {!data || data.items.length === 0 ? (
        <EmptyState>
          Catalog is empty. Run <span className="mono">npm run seed:catalog</span> in the{' '}
          <span className="mono">backend/</span> directory to populate it.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th>Application areas</th>
                <th>SDKs</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((product) => (
                <tr key={product.id}>
                  <td>
                    <strong>{product.name}</strong>
                    {product.description && (
                      <div className="muted small">{product.description}</div>
                    )}
                  </td>
                  <td className="small">
                    {CATEGORY_LABELS[product.category] ?? product.category}
                  </td>
                  <td>
                    {product.applicationAreas.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      product.applicationAreas.map((area) => (
                        <span key={area} className="tag">
                          {area}
                        </span>
                      ))
                    )}
                  </td>
                  <td>
                    {product.sdkSupport.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      product.sdkSupport.map((sdk) => (
                        <span key={sdk} className="tag">
                          {sdk}
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
