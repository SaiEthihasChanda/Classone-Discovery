import { useState } from 'react';
import { api, type Role } from '../../api/client';
import { useAsync } from '../../hooks/useAsync';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState, ErrorBanner, Loading, relativeTime } from '../../components/common';

const ROLE_HELP: Record<Role, string> = {
  admin: 'Everything, including settings, deletes and user roles',
  sales: 'Run the pipeline, edit leads, draft and send outreach',
  viewer: 'Read only',
  pending: 'Signed in, no access yet',
};

/** Admin-only: who has signed in, and what each person may do. */
export function UsersPage() {
  const { me } = useAuth();
  const { data, loading, error, reload } = useAsync(() => api.listUsers(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function change(uid: string, role: Role) {
    setBusy(uid);
    setActionError(null);
    try {
      await api.setUserRole(uid, role);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not change the role');
    } finally {
      setBusy(null);
    }
  }

  const pending = data?.items.filter((u) => u.role === 'pending').length ?? 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Users</h1>
          <p>Anyone who signs in starts as pending. Give them a role here.</p>
        </div>
      </div>

      {pending > 0 && (
        <div className="alert alert-info">
          {pending} {pending === 1 ? 'person is' : 'people are'} waiting for access.
        </div>
      )}
      {actionError && <ErrorBanner message={actionError} />}
      {error && <ErrorBanner message={error} />}
      {loading && !data && <Loading />}
      {data && data.items.length === 0 && <EmptyState>No one has signed in yet.</EmptyState>}

      {data && data.items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((u) => (
                <tr key={u.uid}>
                  <td>
                    <strong>{u.name ?? u.email}</strong>
                    <div className="muted small">{u.email}</div>
                  </td>
                  <td>
                    <select
                      value={u.role}
                      disabled={busy === u.uid || u.uid === me?.uid}
                      onChange={(e) => void change(u.uid, e.target.value as Role)}
                      style={{ width: 'auto', minWidth: 140 }}
                      title={u.uid === me?.uid ? "You can't change your own role" : ROLE_HELP[u.role]}
                    >
                      {(['admin', 'sales', 'viewer', 'pending'] as Role[]).map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <div className="muted small">{ROLE_HELP[u.role]}</div>
                  </td>
                  <td className="muted small">{u.lastSeenAt ? relativeTime(u.lastSeenAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
