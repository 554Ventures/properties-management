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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// Auth defaults to demo mode (enabled: false) for every test below, matching
// the real useAuth() context value when no <AuthProvider> wraps the tree —
// so the vast majority of this file (written for demo mode) needs no change.
// Individual tests override via useAuthMock.mockReturnValue(...) to exercise
// AccountForm's owner-only gating (PATCH /settings/account is
// requireOwner()-gated server-side).
const { useAuthMock } = vi.hoisted(() => ({ useAuthMock: vi.fn() }));
vi.mock('../state/auth', () => ({ useAuth: useAuthMock }));

const demoAuth = {
  enabled: false,
  session: null,
  loading: false,
  recovering: false,
  endRecovery: vi.fn(),
  signOut: vi.fn(),
};

const account: AccountSettings = {
  id: 'acc1',
  name: 'Test User',
  email: 'test@example.com',
  timezone: 'America/New_York',
  taxRatePct: 20,
  taxYearStartMonth: 1,
  graceDays: 0,
  graceDaysBasis: 'calendar',
  defaultLateFeeCents: 0,
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

beforeEach(() => {
  useAuthMock.mockReturnValue(demoAuth);
});

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

  it('shows a "Last sync failed" line (icon + text) when the integration carries lastSyncErrorAt', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { method: 'GET', path: '/api/v1/settings/account', body: account },
        {
          method: 'GET',
          path: '/api/v1/integrations',
          body: [
            {
              ...connectedStripeFcIntegration,
              lastSyncedAt: '2026-07-14T09:00:00.000Z',
              lastSyncError: 'The bank connection needs to be reauthorized.',
              lastSyncErrorAt: '2026-07-15T03:00:00.000Z',
              syncFailureCount: 3,
            },
          ],
        },
      ]),
    );

    renderWithProviders(<Settings />);

    const fcRow = (
      await screen.findByText('Stripe Financial Connections (bank import)')
    ).closest('li') as HTMLElement;
    const note = await within(fcRow).findByText(
      /Last sync failed .*: The bank connection needs to be reauthorized\./,
    );
    expect(note).toBeInTheDocument();
    // Icon + text, not color alone (root CLAUDE.md a11y bar).
    expect(note.querySelector('svg')).toBeInTheDocument();
  });

  it('renders no last-sync-failed line when lastSyncErrorAt is null', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { method: 'GET', path: '/api/v1/settings/account', body: account },
        { method: 'GET', path: '/api/v1/integrations', body: [connectedStripeFcIntegration] },
      ]),
    );

    renderWithProviders(<Settings />);

    await screen.findByText('Stripe Financial Connections (bank import)');
    expect(screen.queryByText(/Last sync failed/)).not.toBeInTheDocument();
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

  it('mock-mode Connect on Stripe FC completes immediately, chains the first import, and offers the review-queue CTA', async () => {
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
      {
        method: 'POST',
        path: '/api/v1/transactions/import',
        body: { imported: 5, skipped: 0, updated: 0, removed: 0 },
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

    // Connect no longer dead-ends: the first import fires on its own and the
    // toast leads straight into the review queue.
    expect(
      await screen.findByText(
        'Bank connected. Imported 5 new bank transactions into the review queue.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review transactions' })).toBeInTheDocument();
  });

  it('mock-mode Connect with nothing to import explains the sync delay without a review CTA', async () => {
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
      {
        method: 'POST',
        path: '/api/v1/transactions/import',
        body: { imported: 0, skipped: 0, updated: 0, removed: 0 },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<Settings />);

    const fcRow = (
      await screen.findByText('Stripe Financial Connections (bank import)')
    ).closest('li') as HTMLElement;
    fireEvent.click(within(fcRow).getByRole('button', { name: 'Connect' }));

    expect(
      await screen.findByText(
        'Bank connected. No new transactions yet — bank sync can take a minute after connecting. Try again shortly.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review transactions' })).not.toBeInTheDocument();
  });

  it('a failed first import still reports the connection and points at the Money page', async () => {
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
      {
        method: 'POST',
        path: '/api/v1/transactions/import',
        status: 500,
        body: { error: { code: 'internal', message: 'boom' } },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<Settings />);

    const fcRow = (
      await screen.findByText('Stripe Financial Connections (bank import)')
    ).closest('li') as HTMLElement;
    fireEvent.click(within(fcRow).getByRole('button', { name: 'Connect' }));

    expect(
      await screen.findByText(
        'Bank connected, but the first import failed. Use "Import from bank" on the Money page.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to Money' })).toBeInTheDocument();
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
      {
        method: 'POST',
        path: '/api/v1/transactions/import',
        body: { imported: 2, skipped: 0, updated: 0, removed: 0 },
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

describe('Settings account form — default late fee (WS7)', () => {
  it('prefills the field from the account and PATCHes defaultLateFeeCents on save', async () => {
    const fetchMock = makeFetch([
      {
        method: 'GET',
        path: '/api/v1/settings/account',
        body: { ...account, defaultLateFeeCents: 5000 },
      },
      { method: 'GET', path: '/api/v1/integrations', body: [] },
      {
        method: 'PATCH',
        path: '/api/v1/settings/account',
        body: { ...account, defaultLateFeeCents: 7500 },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<Settings />);

    const input = await screen.findByLabelText('Default late fee (USD)');
    expect(input).toHaveValue(50);

    fireEvent.change(input, { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/settings/account' &&
          (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(call).toBeDefined();
      const body = JSON.parse((call![1] as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.defaultLateFeeCents).toBe(7500);
    });
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
  });

  it('explains that $0 disables late fees, and treats a blank field as $0', async () => {
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/settings/account', body: account },
      { method: 'GET', path: '/api/v1/integrations', body: [] },
      { method: 'PATCH', path: '/api/v1/settings/account', body: account },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<Settings />);

    const input = await screen.findByLabelText('Default late fee (USD)');
    expect(input).toHaveValue(0);
    expect(
      screen.getByText(
        "Applied when a lease doesn't set its own late fee. $0 disables late fees for those leases — applying one is always a manual action on the Rent Collection page, never automatic.",
      ),
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/settings/account' &&
          (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(call).toBeDefined();
      const body = JSON.parse((call![1] as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.defaultLateFeeCents).toBe(0);
    });
  });

  it('surfaces the server error verbatim when the save fails (owner still exercises the save path)', async () => {
    // Auth mode, role owner: the form stays editable and Save is exposed, so
    // this covers the API-level 403 surfacing path (e.g. a permission change
    // mid-session) independent of the client-side owner gate below.
    useAuthMock.mockReturnValue({ ...demoAuth, enabled: true, session: { user: { email: 'owner@example.com' } } });
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/settings/account', body: account },
      { method: 'GET', path: '/api/v1/integrations', body: [] },
      {
        method: 'GET',
        path: '/api/v1/settings/me',
        body: { userId: 'u-owner', role: 'owner', permissions: [] },
      },
      {
        method: 'GET',
        path: '/api/v1/team',
        body: {
          members: [
            {
              userId: 'u-owner',
              email: 'owner@example.com',
              role: 'owner',
              permissions: [],
              createdAt: '2025-01-01T00:00:00.000Z',
            },
          ],
          pendingInvites: [],
          seatsUsed: 1,
          seatLimit: 2,
        },
      },
      {
        method: 'PATCH',
        path: '/api/v1/settings/account',
        status: 403,
        body: { error: { code: 'forbidden', message: 'only the account owner can do this' } },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<Settings />);

    await screen.findByLabelText('Default late fee (USD)');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('only the account owner can do this')).toBeInTheDocument();
  });

  it('a non-owner member sees the account form read-only, with an explanatory note (icon + text) and no Save button', async () => {
    useAuthMock.mockReturnValue({ ...demoAuth, enabled: true, session: { user: { email: 'member@example.com' } } });
    const fetchMock = makeFetch([
      { method: 'GET', path: '/api/v1/settings/account', body: account },
      { method: 'GET', path: '/api/v1/integrations', body: [] },
      {
        method: 'GET',
        path: '/api/v1/settings/me',
        body: { userId: 'u-member', role: 'member', permissions: ['rent'] },
      },
      {
        method: 'GET',
        path: '/api/v1/team',
        body: { members: [], pendingInvites: [], seatsUsed: 1, seatLimit: 2 },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderWithProviders(<Settings />);

    const note = await screen.findByText('Only the account owner can change these settings.');
    expect(note.querySelector('svg')).toBeInTheDocument();

    // Name/Email are `required`, which appends a visually-hidden " *" to the
    // <label> textContent — match with exact: false rather than the full string.
    expect(screen.getByLabelText('Name', { exact: false })).toBeDisabled();
    expect(screen.getByLabelText('Email', { exact: false })).toBeDisabled();
    expect(screen.getByLabelText('Tax set-aside rate (%)')).toBeDisabled();
    expect(screen.getByLabelText('Grace period (days)')).toBeDisabled();
    expect(screen.getByLabelText('Grace period basis')).toBeDisabled();
    expect(screen.getByLabelText('Default late fee (USD)')).toBeDisabled();
    expect(screen.getByLabelText('Timezone')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } }, // jsdom can't compute this
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });
});

describe('Settings account form — grace period', () => {
  it('prefills days + basis from the account and PATCHes both on save', async () => {
    const fetchMock = makeFetch([
      {
        method: 'GET',
        path: '/api/v1/settings/account',
        body: { ...account, graceDays: 3, graceDaysBasis: 'business' },
      },
      { method: 'GET', path: '/api/v1/integrations', body: [] },
      {
        method: 'PATCH',
        path: '/api/v1/settings/account',
        body: { ...account, graceDays: 5, graceDaysBasis: 'calendar' },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<Settings />);

    const daysInput = await screen.findByLabelText('Grace period (days)');
    expect(daysInput).toHaveValue(3);
    const basisSelect = screen.getByLabelText('Grace period basis');
    expect(basisSelect).toHaveValue('business');
    expect(
      screen.getByText(
        "Rent isn't marked late until this many days after the due date. Late fees can only be applied once a charge is past grace.",
      ),
    ).toBeInTheDocument();

    fireEvent.change(daysInput, { target: { value: '5' } });
    fireEvent.change(basisSelect, { target: { value: 'calendar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/v1/settings/account' &&
          (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(call).toBeDefined();
      const body = JSON.parse((call![1] as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.graceDays).toBe(5);
      expect(body.graceDaysBasis).toBe('calendar');
    });
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
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
