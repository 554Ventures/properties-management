// Settings → Team section (docs/WHATS_NEXT.md §4): owner sees the member list,
// per-area permission toggles, seat counter and invite form; a full account
// swaps the form for the upgrade CTA; a non-owner member sees a read-only view.
// useAuth is mocked so `enabled` is true (auth mode) without a real Supabase
// session; react-plaid-link is mocked so the integrations card doesn't load an
// iframe.
import type { AccountSettings } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, ToastViewport } from '../components/ui/Toast';
import { Settings } from '../pages/Settings';

vi.mock('react-plaid-link', () => ({
  usePlaidLink: () => ({ open: vi.fn(), ready: true, error: null, exit: vi.fn(), submit: vi.fn() }),
}));

vi.mock('../state/auth', () => ({
  useAuth: () => ({
    enabled: true,
    session: { user: { email: 'owner@example.com' } },
    signOut: vi.fn(),
  }),
}));

const account: AccountSettings = {
  id: 'acc1',
  name: 'Owner',
  email: 'owner@example.com',
  timezone: 'America/New_York',
  taxRatePct: 20,
  taxYearStartMonth: 1,
  graceDays: 0,
  defaultLateFeeCents: 0,
  createdAt: '2025-01-01T00:00:00.000Z',
  deletionRequestedAt: null,
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

const baseRoutes: RouteFixture[] = [
  { method: 'GET', path: '/api/v1/settings/account', body: account },
  { method: 'GET', path: '/api/v1/integrations', body: [] },
];

const ownerMe = {
  method: 'GET',
  path: '/api/v1/settings/me',
  body: { userId: 'u-owner', role: 'owner', permissions: ['properties', 'tenants', 'money', 'rent', 'reports', 'ai'] },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Settings Team section', () => {
  it('owner sees the seat count, a pending invite, and the invite form', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        ...baseRoutes,
        ownerMe,
        {
          method: 'GET',
          path: '/api/v1/team',
          body: {
            members: [
              { userId: 'u-owner', email: 'owner@example.com', role: 'owner', permissions: [], createdAt: '2025-01-01T00:00:00.000Z' },
            ],
            pendingInvites: [
              { id: 'inv1', email: 'teammate@example.com', permissions: ['rent'], createdAt: '2025-01-02T00:00:00.000Z' },
            ],
            seatsUsed: 2,
            seatLimit: 2,
          },
        },
      ]),
    );

    renderWithProviders(<Settings />);

    expect(await screen.findByText('2 of 2 seats used.')).toBeInTheDocument();
    const team = screen.getByRole('heading', { name: 'Team' }).closest('section')!;
    expect(within(team).getByText('teammate@example.com')).toBeInTheDocument();
    expect(within(team).getByText('Invite pending')).toBeInTheDocument();
    // Seats full → upgrade CTA, no invite form.
    expect(within(team).getByRole('button', { name: 'Upgrade for more seats' })).toBeInTheDocument();
    expect(within(team).queryByRole('button', { name: 'Send invite' })).not.toBeInTheDocument();
  });

  it('owner with a free seat sees the invite form with permission toggles', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        ...baseRoutes,
        ownerMe,
        {
          method: 'GET',
          path: '/api/v1/team',
          body: {
            members: [
              { userId: 'u-owner', email: 'owner@example.com', role: 'owner', permissions: [], createdAt: '2025-01-01T00:00:00.000Z' },
            ],
            pendingInvites: [],
            seatsUsed: 1,
            seatLimit: 2,
          },
        },
      ]),
    );

    renderWithProviders(<Settings />);

    expect(await screen.findByText('1 of 2 seats used.')).toBeInTheDocument();
    const team = screen.getByRole('heading', { name: 'Team' }).closest('section')!;
    expect(within(team).getByRole('button', { name: 'Send invite' })).toBeInTheDocument();
    // Permission toggles are labelled checkboxes.
    expect(within(team).getAllByRole('checkbox', { name: 'Rent & reminders' }).length).toBeGreaterThan(0);
    expect(within(team).queryByRole('button', { name: 'Upgrade for more seats' })).not.toBeInTheDocument();
  });

  it('a non-owner member sees a read-only view of their access', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        ...baseRoutes,
        {
          method: 'GET',
          path: '/api/v1/settings/me',
          body: { userId: 'u-member', role: 'member', permissions: ['rent'] },
        },
        // A member may still GET /team, but the member view doesn't use it.
        {
          method: 'GET',
          path: '/api/v1/team',
          status: 200,
          body: { members: [], pendingInvites: [], seatsUsed: 1, seatLimit: 2 },
        },
      ]),
    );

    renderWithProviders(<Settings />);

    expect(await screen.findByText(/You’re a member of this account/)).toBeInTheDocument();
    const team = screen.getByRole('heading', { name: 'Team' }).closest('section')!;
    expect(within(team).getByText('Rent & reminders')).toBeInTheDocument();
    // Members can't invite.
    expect(within(team).queryByRole('button', { name: 'Send invite' })).not.toBeInTheDocument();
  });
});
