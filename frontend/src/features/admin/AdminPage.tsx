import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { Tabs } from '../../components/ui';
import { CatalogPage } from '../catalog/CatalogPage';
import { SettingsPage } from '../settings/SettingsPage';
import { UsersPage } from '../users/UsersPage';
import { ActivityLogPage } from './ActivityLogPage';

type AdminTab = 'catalog' | 'settings' | 'users' | 'activity';

/** Admin — product catalog (everyone can read it), settings and users (admins only). */
export function AdminPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const isAdmin = can('admin');
  const requested = (params.get('tab') as AdminTab | null) ?? 'catalog';
  const tab: AdminTab = isAdmin ? requested : 'catalog';

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Admin</h1>
          <p>Products the AI matches against, how discovery behaves, who can sign in, and who did what.</p>
        </div>
      </div>
      <Tabs
        items={[
          { key: 'catalog', label: 'Product catalog' },
          ...(isAdmin
            ? ([
                { key: 'settings', label: 'Settings' },
                { key: 'users', label: 'Users' },
                { key: 'activity', label: 'Activity' },
              ] as const)
            : []),
        ]}
        value={tab}
        onChange={(k) => setParams(k === 'catalog' ? {} : { tab: k }, { replace: true })}
      />
      <div className="embedded">
        {tab === 'catalog' && <CatalogPage />}
        {tab === 'settings' && <SettingsPage />}
        {tab === 'users' && <UsersPage />}
        {tab === 'activity' && <ActivityLogPage />}
      </div>
    </>
  );
}
