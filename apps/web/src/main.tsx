import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { ToastProvider } from './components/ui/Toast';
import { router } from './router';
// AuthGate now wraps only the app route tree (router.tsx) — /privacy and
// /terms are top-level siblings that must render whether or not there's a
// session, so it can't wrap the whole RouterProvider anymore.
import { AuthProvider } from './state/auth';
import './styles/tokens.css';
import './styles/index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      // Financial surfaces must refresh when the user returns to the tab
      // (e.g. a payment recorded elsewhere shouldn't sit stale on the
      // dashboard); the 30s staleTime below bounds how often a refocus can
      // actually trigger a refetch.
      refetchOnWindowFocus: true,
      staleTime: 30_000,
    },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
