import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from './components/shell/AppShell';
import { AddTransaction } from './pages/AddTransaction';
import { Dashboard } from './pages/Dashboard';
import { Insights } from './pages/Insights';
import { Money } from './pages/Money';
import { MoneyReview } from './pages/MoneyReview';
import { NotFound } from './pages/NotFound';
import { PropertiesList } from './pages/PropertiesList';
import { PropertyDetail } from './pages/PropertyDetail';
import { RentTracker } from './pages/RentTracker';
import { Reports } from './pages/Reports';
import { ReportViewer } from './pages/ReportViewer';
import { Settings } from './pages/Settings';
import { TenantDetail } from './pages/TenantDetail';
import { TenantsList } from './pages/TenantsList';

// Routes per ARCHITECTURE §8. The chat drawer is layout state (?chat=open),
// not a route — added in build-order task 9.
export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'properties', element: <PropertiesList /> },
      { path: 'properties/:id', element: <PropertyDetail /> },
      { path: 'tenants', element: <TenantsList /> },
      { path: 'tenants/:id', element: <TenantDetail /> },
      { path: 'money', element: <Money /> },
      { path: 'money/new', element: <AddTransaction /> },
      { path: 'money/review', element: <MoneyReview /> },
      { path: 'rent', element: <RentTracker /> },
      { path: 'reports', element: <Reports /> },
      { path: 'reports/:id', element: <ReportViewer /> },
      { path: 'insights', element: <Insights /> },
      { path: 'insights/:reportId', element: <Insights /> },
      { path: 'settings', element: <Settings /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
