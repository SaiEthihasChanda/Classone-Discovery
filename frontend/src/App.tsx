import { useEffect } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { HomePage } from './features/home/HomePage';
import { ProspectsPage } from './features/prospects/ProspectsPage';
import { LeadsPage } from './features/leads/LeadsPage';
import { NewLeadPage } from './features/leads/NewLeadPage';
import { OutreachPage } from './features/outreach/OutreachPage';
import { AdminPage } from './features/admin/AdminPage';
import { useAuth } from './auth/AuthProvider';
import { SignInScreen } from './auth/SignInScreen';
import { Icon } from './components/ui';
import { api } from './api/client';
import { MotionConfig } from './components/motion';
import { useAsync } from './hooks/useAsync';

/** Old /leads/:id links open the same lead in the side panel. */
function LeadRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/leads?status=all&open=${id}`} replace />;
}

function Sidebar() {
  const { me, signOut } = useAuth();
  const { pathname } = useLocation();
  // Small live counts on the two inboxes: refreshed on every page change and every 10 s,
  // so approving leads or sending drafts (here or by the conveyor) shows up without a reload.
  const { data: counts, reload } = useAsync(async () => {
    const [review, drafts] = await Promise.all([api.listLeads({ status: 'pending_review', limit: 1 }), api.listThreads('draft')]);
    return { review: review.total, drafts: drafts.items.length };
  }, [pathname]);
  useEffect(() => {
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, [reload]);

  const items: Array<{ to: string; label: string; icon: string; count?: number }> = [
    { to: '/home', label: 'Home', icon: 'home' },
    { to: '/prospects', label: 'Prospects', icon: 'prospects' },
    { to: '/leads', label: 'Leads', icon: 'leads', count: counts?.review },
    { to: '/outreach', label: 'Outreach', icon: 'mail', count: counts?.drafts },
    { to: '/admin', label: 'Admin', icon: 'admin' },
  ];
  const initials = (me?.name ?? me?.email ?? '?')
    .split(/[\s@.]+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('');

  return (
    <nav className="sidebar">
      <div className="sidebar-brand">
        <img src="/classone-logo.png" alt="Class One Systems" />
        <span>Sales</span>
      </div>
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} title={item.label}>
          <Icon name={item.icon} />
          <span className="label">{item.label}</span>
          {item.count ? <span className="nav-count">{item.count > 999 ? '999+' : item.count}</span> : null}
        </NavLink>
      ))}
      <div className="sidebar-footer">
        <div className="avatar">{me?.photoUrl ? <img src={me.photoUrl} alt="" referrerPolicy="no-referrer" /> : initials}</div>
        <div className="sidebar-user">
          <strong>{me?.name ?? me?.email}</strong>
          <span>{me?.role}</span>
        </div>
        {me?.authEnabled && (
          <button className="icon-btn" onClick={() => void signOut()} title="Sign out">
            <Icon name="logout" />
          </button>
        )}
      </div>
    </nav>
  );
}

export function App() {
  const { status } = useAuth();
  if (status !== 'ready') return <SignInScreen />;

  return (
    // Card animations follow the OS "reduce motion" setting.
    <MotionConfig reducedMotion="user">
    <div className="layout">
      <Sidebar />
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route path="/home" element={<HomePage />} />
          <Route path="/prospects" element={<ProspectsPage />} />
          <Route path="/leads" element={<LeadsPage />} />
          <Route path="/leads/new" element={<NewLeadPage />} />
          <Route path="/leads/:id" element={<LeadRedirect />} />
          <Route path="/outreach" element={<OutreachPage />} />
          <Route path="/admin" element={<AdminPage />} />

          {/* Old locations */}
          <Route path="/dashboard" element={<Navigate to="/home" replace />} />
          <Route path="/faculty" element={<Navigate to="/prospects" replace />} />
          <Route path="/discovery" element={<Navigate to="/prospects" replace />} />
          <Route path="/runs" element={<Navigate to="/prospects?view=history" replace />} />
          <Route path="/review" element={<Navigate to="/leads?status=pending_review" replace />} />
          <Route path="/catalog" element={<Navigate to="/admin" replace />} />
          <Route path="/settings" element={<Navigate to="/admin?tab=settings" replace />} />
          <Route path="/users" element={<Navigate to="/admin?tab=users" replace />} />

          <Route path="*" element={<div className="empty">Page not found.</div>} />
        </Routes>
      </main>
    </div>
    </MotionConfig>
  );
}
