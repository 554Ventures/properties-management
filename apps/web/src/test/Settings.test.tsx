// Settings integrations: (1) Stripe Financial Connections renders even with
// zero backend rows; Plaid is hidden by default (VITE_SHOW_PLAID unset) and
// resurfaces when the flag is on or the account already has a
// non-disconnected Plaid row, (2) each feed's mock mode still 1-click-connects
// without opening a modal, (3) real mode opens the provider modal (Plaid
// Link / Stripe.js) instead of auto-completing. Both provider SDKs are mocked
// so tests never load a real hosted iframe.
import type { AccountSettings } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, ToastViewport } from '../components/ui/Toast';
import { Settings } from '../pages/Settings';

const openMock = vi.fn();
let capturedOnSuccess: ((publicToken: string) => void) | undefined;

vi.mock('react-plaid-link', () => ({
  usePlaidLink: ({ onSuccess }: { onSuccess: (token: string) => void }) => {
    capturedOnSuccess = onSuccess;
    return { open: openMock, ready: true, error: null, exit: vi.fn(), submit: vi.fn() };
  },
}));

const collectAccountsMock = vi.fn();
const loadStripeMock = vi.fn(async () => ({
  collectFinancialConnectionsAccounts: collectAccountsMock,
}));

vi.mock('@stripe/stripe-js', () => ({
  loadStripe: (...args: unknown[]) => loadStripeMock(...(args as [])),
}));

const account: AccountSettings = {
  id: 'acc1',
  name: 'Test User',
  email: 'test@example.com',
  timezone: 'America/New_York',
  taxRatePct: 20,
  taxYearStartMonth: 1,
  graceDays: 0,
  createdAt: '2025-01-01T00:00:00.000Z',
  deletionRequestedAt: null,
};

const connectedPlaidIntegration = {
  id: 'i1',
  accountId: 'acc1',
  type: 'plaid',
  name: 'Plaid (bank import)',
  status: 'connected',
  externalRef: 'mock_item_id',
  scopes: [],
  createdAt: '2025-01-01T00:00:00.000Z',
};

const connectedStripeFcIntegration = {
  id: 'i2',
  accountId: 'acc1',
  type: 'stripe_fc',
  name: 'Stripe Financial Connections (bank import)',
  status: 'connected',
  externalRef: 'fcsess_real',
  scopes: [],
  createdAt: '2025-01-01T00:00:00.000Z',
};

interface RouteFixture {
  method: string;
  path: string;
  status?: number;
  body?: unknown;
}

function makeFetch(routes: RouteFixture[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const method = (init?.method ?? 'GET').toUpperCase();
    const match = routes.find((r) => r.path === url && r.method === method);
    if (!match) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: url } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(match.body === undefined ? null : JSON.stringify(match.body), {
      status: match.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function renderWithProviders(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          {ui}
          <ToastViewport />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  openMock.mockClear();
  loadStripeMock.mockClear();
  collectAccountsMock.mockReset();
  capturedOnSuccess = undefined;
});

describe('Settings integrations', () => {
  it('renders Stripe FC but hides Plaid by default when the account has zero rows', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { method: 'GET', path: '/api/v1/settings/account', body: account },
        { method: 'GET', path: '/api/v1/integrations', body: [] },
      ]),
    );

    const { container } = renderWithProviders(<Settings />);

    expect(
      await screen.findByText('Stripe Financial Connections (bank import)'),
    ).toBeInTheDocument();
    // Plaid is hidden (not removed) while Stripe FC is the preferred feed.
    expect(screen.queryByText('Plaid (bank import)')).not.toBeInTheDocument();
    // Stripe rent payments/Docusign/Email are deferred and must not be surfaced yet.
    expect(screen.queryByText('Stripe (rent payments)')).not.toBeInTheDocument();
    expect(screen.queryByText('Docusign (e-sign)')).not.toBeInTheDocument();
    expect(screen.queryByText('Email (reminders & reports)')).not.toBeInTheDocument();
    expect(screen.queryByText('No integrations configured.')).not.toBeInTheDocument();

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } }, // jsdom can't compute this
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });

  it('still shows a connected Plaid row while hidden-by-default, so Disconnect stays reachable', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { method: 'GET', path: '/api/v1/settings/account', body: account },
        { method: 'GET', path: '/api/v1/integrations', body: [connectedPlaidIntegration] },
      ]),
    );

    renderWithProviders(<Settings />);

    const plaidRow = (await screen.findByText('Plaid (bank import)')).closest('li') as HTMLElement;
    expect(within(plaidRow).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  it('mock-mode Connect on Plaid exchanges immediately without opening Link (VITE_SHOW_PLAID=true)', async () => {
    vi.stubEnv('VITE_SHOW_PLAID', 'true');
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/settings/account', body: account },
      { method: 'GET', path: '/api/v1/integrations', body: [] },
      {
        method: 'POST',
        path: '/api/v1/integrations/plaid/link-token',
        body: { linkToken: 'mock_link_token', mock: true },
      },
      { method: 'POST', path: '/api/v1/integrations/plaid/exchange', body: connectedPlaidIntegration },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<Settings />);

    const plaidRow = (await screen.findByText('Plaid (bank import)')).closest('li') as HTMLElement;
    fireEvent.click(within(plaidRow).getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('/integrations/plaid/exchange')),
      ).toBe(true);
    });
    expect(openMock).not.toHaveBeenCalled();
  });

  it('real-mode Connect on Plaid opens the Link modal, only exchanges after onSuccess fires (VITE_SHOW_PLAID=true)', async () => {
    vi.stubEnv('VITE_SHOW_PLAID', 'true');
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/settings/account', body: account },
      { method: 'GET', path: '/api/v1/integrations', body: [] },
      {
        method: 'POST',
        path: '/api/v1/integrations/plaid/link-token',
        body: { linkToken: 'link-real-abc', mock: false },
      },
      { method: 'POST', path: '/api/v1/integrations/plaid/exchange', body: connectedPlaidIntegration },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<Settings />);

    const plaidRow = (await screen.findByText('Plaid (bank import)')).closest('li') as HTMLElement;
    fireEvent.click(within(plaidRow).getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(openMock).toHaveBeenCalled());
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/integrations/plaid/exchange')),
    ).toBe(false);

    capturedOnSuccess?.('real-public-token-from-link');

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/integrations/plaid/exchange'),
      );
      expect(call).toBeDefined();
      expect(call?.[1]?.body).toBe(JSON.stringify({ publicToken: 'real-public-token-from-link' }));
    });
  });

  it('mock-mode Connect on Stripe FC completes immediately without loading Stripe.js', async () => {
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/settings/account', body: account },
      { method: 'GET', path: '/api/v1/integrations', body: [] },
      {
        method: 'POST',
        path: '/api/v1/integrations/stripe_fc/session',
        body: {
          clientSecret: 'mock_fc_client_secret',
          sessionId: 'mock_fc_session',
          publishableKey: 'pk_mock',
          mock: true,
        },
      },
      {
        method: 'POST',
        path: '/api/v1/integrations/stripe_fc/complete',
        body: connectedStripeFcIntegration,
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<Settings />);

    const fcRow = (
      await screen.findByText('Stripe Financial Connections (bank import)')
    ).closest('li') as HTMLElement;
    fireEvent.click(within(fcRow).getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/integrations/stripe_fc/complete'),
      );
      expect(call).toBeDefined();
      expect(call?.[1]?.body).toBe(JSON.stringify({ sessionId: 'mock_fc_session' }));
    });
    expect(loadStripeMock).not.toHaveBeenCalled();
  });

  it('real-mode Connect on Stripe FC opens the Stripe.js modal, only completes after accounts are collected', async () => {
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/settings/account', body: account },
      { method: 'GET', path: '/api/v1/integrations', body: [] },
      {
        method: 'POST',
        path: '/api/v1/integrations/stripe_fc/session',
        body: {
          clientSecret: 'fcsess_secret_real',
          sessionId: 'fcsess_real',
          publishableKey: 'pk_test_real',
          mock: false,
        },
      },
      {
        method: 'POST',
        path: '/api/v1/integrations/stripe_fc/complete',
        body: connectedStripeFcIntegration,
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    collectAccountsMock.mockResolvedValue({
      financialConnectionsSession: { accounts: [{ id: 'fca_1' }] },
    });

    renderWithProviders(<Settings />);

    const fcRow = (
      await screen.findByText('Stripe Financial Connections (bank import)')
    ).closest('li') as HTMLElement;
    fireEvent.click(within(fcRow).getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(collectAccountsMock).toHaveBeenCalledWith({ clientSecret: 'fcsess_secret_real' });
    });
    expect(loadStripeMock).toHaveBeenCalledWith('pk_test_real');

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/integrations/stripe_fc/complete'),
      );
      expect(call).toBeDefined();
      expect(call?.[1]?.body).toBe(JSON.stringify({ sessionId: 'fcsess_real' }));
    });
  });

  it('real-mode Stripe FC does not complete when the user closes the modal without linking', async () => {
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/settings/account', body: account },
      { method: 'GET', path: '/api/v1/integrations', body: [] },
      {
        method: 'POST',
        path: '/api/v1/integrations/stripe_fc/session',
        body: {
          clientSecret: 'fcsess_secret_real',
          sessionId: 'fcsess_real',
          publishableKey: 'pk_test_real',
          mock: false,
        },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    collectAccountsMock.mockResolvedValue({
      financialConnectionsSession: { accounts: [] },
    });

    renderWithProviders(<Settings />);

    const fcRow = (
      await screen.findByText('Stripe Financial Connections (bank import)')
    ).closest('li') as HTMLElement;
    fireEvent.click(within(fcRow).getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(collectAccountsMock).toHaveBeenCalled());
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/integrations/stripe_fc/complete')),
    ).toBe(false);
  });
});

describe('Settings legal section', () => {
  it('links to the canonical /privacy and /terms pages, not a duplicated modal', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { method: 'GET', path: '/api/v1/settings/account', body: account },
        { method: 'GET', path: '/api/v1/integrations', body: [] },
      ]),
    );
    renderWithProviders(<Settings />);

    const legal = (await screen.findByRole('heading', { name: 'Legal' })).closest('section')!;
    expect(within(legal).getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      '/privacy',
    );
    expect(within(legal).getByRole('link', { name: 'Terms of Service' })).toHaveAttribute(
      'href',
      '/terms',
    );
  });
});
