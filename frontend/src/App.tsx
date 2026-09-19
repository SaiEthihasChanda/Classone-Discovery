import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { LeadsPage } from './features/leads/LeadsPage';
import { LeadDetailPage } from './features/leads/LeadDetailPage';
import { NewLeadPage } from './features/leads/NewLeadPage';
import { CatalogPage } from './features/catalog/CatalogPage';
import { DiscoveryPage } from './features/discovery/DiscoveryPage';
import { ReviewQueuePage } from './features/review/ReviewQueuePage';
import { SettingsPage } from './features/settings/SettingsPage';

const NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/discovery', label: 'Discovery' },
  { to: '/review', label: 'Review Queue' },
  { to: '/leads', label: 'Leads / CRM' },
  { to: '/catalog', label: 'Product Catalog' },
  { to: '/settings', label: 'Settings' },
];

export function App() {
  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="sidebar-brand">
          Class One
          <small>Sales Automation</small>
        </div>

        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
          >
            {item.label}
          </NavLink>
        ))}

        <div className="sidebar-footer">
          Phase 2 — discovery live.
          <br />
          Email outreach and follow-ups arrive in Phases 3-4.
        </div>
      </nav>

      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/discovery" element={<DiscoveryPage />} />
          <Route path="/review" element={<ReviewQueuePage />} />
          <Route path="/leads" element={<LeadsPage />} />
          <Route path="/leads/new" element={<NewLeadPage />} />
          <Route path="/leads/:id" element={<LeadDetailPage />} />
          <Route path="/catalog" element={<CatalogPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<div className="empty">Page not found.</div>} />
        </Routes>
      </main>
    </div>
  );
}
