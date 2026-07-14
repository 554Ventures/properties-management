import { createBrowserRouter, Navigate, useParams } from 'react-router-dom';
import { AppShell } from './components/shell/AppShell';
import { NativeBridge } from './native/NativeBridge';
import { AddTransaction } from './pages/AddTransaction';
import { ContractorDetail } from './pages/ContractorDetail';
import { ContractorsPage } from './pages/ContractorsPage';
import { Dashboard } from './pages/Dashboard';
import { DocumentsPage } from './pages/DocumentsPage';
import { Money } from './pages/Money';
import { MoneyReview } from './pages/MoneyReview';
import { NotFound } from './pages/NotFound';
import { PrivacyPolicy } from './pages/PrivacyPolicy';
import { PropertiesList } from './pages/PropertiesList';
import { PropertyDetail } from './pages/PropertyDetail';
import { RentTracker } from './pages/RentTracker';
import { Reports } from './pages/Reports';
import { ReportViewer } from './pages/ReportViewer';
import { Settings } from './pages/Settings';
import { TenantDetail } from './pages/TenantDetail';
import { TermsOfService } from './pages/TermsOfService';
import { UnitDetail } from './pages/UnitDetail';
import { AuthGate } from './state/auth';

// /insights/:reportId used to render the monthly review directly; report ids
// are shared, so the same review renders at /reports/:id. Exported for tests.
export function LegacyInsightRedirect() {
  const { reportId } = useParams<{ reportId: string }>();
  return <Navigate to={`/reports/${reportId}`} replace />;
}

// Routes per ARCHITECTURE §8. The chat drawer is layout state (?chat=open),
// not a route — added in build-order task 9.
//
// /privacy and /terms are top-level siblings of the app tree, deliberately
// OUTSIDE <AuthGate> — they must render for signed-out visitors (the Google
// OAuth consent screen, app-store listings, and email footers all link here
// directly). AuthGate wraps only AppShell now, not the whole router, so the
// app's own routes are unaffected.
export const router = createBrowserRouter([
  { path: '/privacy', element: <PrivacyPolicy /> },
  { path: '/terms', element: <TermsOfService /> },
  {
    path: '/',
    element: (
      <AuthGate>
        {/* Inside AuthGate so push registration runs with a session; inside
            the router so notification deep links can navigate. Renders null
            in plain browsers. */}
        <NativeBridge />
        <AppShell />
      </AuthGate>
    ),
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'properties', element: <PropertiesList /> },
      { path: 'properties/:id', element: <PropertyDetail /> },
      { path: 'units/:id', element: <UnitDetail /> },
      // The standalone tenants list is gone — tenants are reached via
      // Properties → Unit (and the "Tenants without a lease" section on
      // Properties). Old bookmarks and push deep links land on Properties;
      // /tenants/:id detail pages remain.
      { path: 'tenants', element: <Navigate to="/properties" replace /> },
      { path: 'tenants/:id', element: <TenantDetail /> },
      // Maintenance has one screen today; the index redirect keeps the
      // "Maintenance" breadcrumb from 404ing.
      { path: 'maintenance', element: <Navigate to="/maintenance/contractors" replace /> },
      { path: 'maintenance/contractors', element: <ContractorsPage /> },
      { path: 'maintenance/contractors/:id', element: <ContractorDetail /> },
      { path: 'money', element: <Money /> },
      { path: 'money/new', element: <AddTransaction /> },
      { path: 'money/review', element: <MoneyReview /> },
      { path: 'rent', element: <RentTracker /> },
      { path: 'documents', element: <DocumentsPage /> },
      { path: 'reports', element: <Reports /> },
      { path: 'reports/:id', element: <ReportViewer /> },
      // The standalone AI Insights page is gone — monthly reviews live on
      // Reports & Tax now, and insight cards surface contextually per page.
      // Old bookmarks and push deep links keep working via these redirects.
      { path: 'insights', element: <Navigate to="/reports" replace /> },
      { path: 'insights/:reportId', element: <LegacyInsightRedirect /> },
      { path: 'settings', element: <Settings /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
