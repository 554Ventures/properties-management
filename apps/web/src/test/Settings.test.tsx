// Settings integrations: (1) all 4 known types render even with zero backend
// rows (closes the "No integrations configured" dead end), (2) Plaid's mock
// mode still 1-click-connects without opening Link, (3) real mode opens the
// actual Plaid Link modal instead of auto-exchanging. react-plaid-link is
// mocked so tests never load a real hosted iframe.
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

const account: AccountSettings = {
  id: 'acc1',
  name: 'Test User',
  email: 'test@example.com',
  timezone: 'America/New_York',
  taxRatePct: 20,
  taxYearStartMonth: 1,
  graceDays: 0,
  createdAt: '2025-01-01T00:00:00.000Z',
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
  openMock.mockClear();
  capturedOnSuccess = undefined;
});

describe('Settings integrations', () => {
  it('renders all 4 known integration types even when the account has zero rows', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { method: 'GET', path: '/api/v1/settings/account', body: account },
        { method: 'GET', path: '/api/v1/integrations', body: [] },
      ]),
    );

    const { container } = renderWithProviders(<Settings />);

    expect(await screen.findByText('Plaid (bank import)')).toBeInTheDocument();
    expect(screen.getByText('Stripe (rent payments)')).toBeInTheDocument();
    expect(screen.getByText('Docusign (e-sign)')).toBeInTheDocument();
    expect(screen.getByText('Email (reminders & reports)')).toBeInTheDocument();
    expect(screen.queryByText('No integrations configured.')).not.toBeInTheDocument();

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } }, // jsdom can't compute this
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });

  it('mock-mode Connect on Plaid exchanges immediately without opening Link', async () => {
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

  it('real-mode Connect on Plaid opens the Link modal, only exchanges after onSuccess fires', async () => {
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
});
