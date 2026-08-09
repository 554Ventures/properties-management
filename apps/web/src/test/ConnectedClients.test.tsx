// Settings → "Connected AI clients" section (remote MCP OAuth, docs/PLAN):
// owner-only list of granted OAuth clients (Supabase's OAuth 2.1 server)
// with a Revoke action. Pure client-side against Supabase — no 554
// Properties API route backs this — so, unlike TeamSection, it's mocked
// through '../lib/supabase' rather than fetch fixtures. useAuth is mocked
// so `enabled` is true (auth mode) without a real Supabase session;
// react-plaid-link is mocked so the integrations card doesn't load an iframe.
import type { OAuthGrant } from '@supabase/supabase-js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const oauthMocks = vi.hoisted(() => ({
  listGrants: vi.fn(),
  revokeGrant: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: { auth: { oauth: oauthMocks } },
  // api/client.ts imports getAccessToken from this module for every request
  // Settings makes (/settings/me, /team, ...) — mocking the module wholesale
  // means it has to be stubbed too, even though this file only cares about
  // the oauth namespace.
  getAccessToken: vi.fn().mockResolvedValue(undefined),
}));

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
  {
    method: 'GET',
    path: '/api/v1/settings/account',
    body: {
      id: 'acc1',
      name: 'Owner',
      email: 'owner@example.com',
      timezone: 'America/New_York',
      taxRatePct: 20,
      taxYearStartMonth: 1,
      graceDays: 0,
      graceDaysBasis: 'calendar',
      defaultLateFeeCents: 0,
      createdAt: '2025-01-01T00:00:00.000Z',
      deletionRequestedAt: null,
    },
  },
  { method: 'GET', path: '/api/v1/integrations', body: [] },
  {
    method: 'GET',
    path: '/api/v1/team',
    body: { members: [], pendingInvites: [], seatsUsed: 1, seatLimit: 2 },
  },
];

const ownerMe: RouteFixture = {
  method: 'GET',
  path: '/api/v1/settings/me',
  body: {
    userId: 'u-owner',
    role: 'owner',
    permissions: ['properties', 'tenants', 'money', 'rent', 'reports', 'ai'],
  },
};

const memberMe: RouteFixture = {
  method: 'GET',
  path: '/api/v1/settings/me',
  body: { userId: 'u-member', role: 'member', permissions: ['rent'] },
};

const grant: OAuthGrant = {
  client: { id: 'client-1', name: 'Claude Desktop', uri: 'https://claude.ai', logo_uri: '' },
  scopes: ['openid', 'email', 'offline_access'],
  granted_at: '2026-08-01T12:00:00.000Z',
};

beforeEach(() => {
  oauthMocks.listGrants.mockReset();
  oauthMocks.revokeGrant.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Settings Connected AI clients section', () => {
  it('an owner sees a granted client with a Revoke action, passing axe', async () => {
    vi.stubGlobal('fetch', makeFetch([...baseRoutes, ownerMe]));
    oauthMocks.listGrants.mockResolvedValueOnce({ data: [grant], error: null });

    const { container } = renderWithProviders(<Settings />);

    const section = (
      await screen.findByRole('heading', { name: 'Connected AI clients' })
    ).closest('section')!;
    expect(await within(section).findByText('Claude Desktop')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });

  it('shows an empty state when the owner has no connected clients', async () => {
    vi.stubGlobal('fetch', makeFetch([...baseRoutes, ownerMe]));
    oauthMocks.listGrants.mockResolvedValueOnce({ data: [], error: null });

    renderWithProviders(<Settings />);

    const section = (
      await screen.findByRole('heading', { name: 'Connected AI clients' })
    ).closest('section')!;
    expect(
      await within(section).findByText(/no ai clients are connected to this account yet/i),
    ).toBeInTheDocument();
  });

  it('revoking a grant calls revokeGrant with the client id and removes the row', async () => {
    vi.stubGlobal('fetch', makeFetch([...baseRoutes, ownerMe]));
    oauthMocks.listGrants.mockResolvedValueOnce({ data: [grant], error: null });
    oauthMocks.revokeGrant.mockResolvedValueOnce({ data: {}, error: null });

    renderWithProviders(<Settings />);

    const section = (
      await screen.findByRole('heading', { name: 'Connected AI clients' })
    ).closest('section')!;
    fireEvent.click(await within(section).findByRole('button', { name: 'Revoke' }));

    await waitFor(() =>
      expect(oauthMocks.revokeGrant).toHaveBeenCalledWith({ clientId: 'client-1' }),
    );
    await waitFor(() =>
      expect(within(section).queryByText('Claude Desktop')).not.toBeInTheDocument(),
    );
    expect(await screen.findByText('Claude Desktop disconnected.')).toBeInTheDocument();
  });

  it('a non-owner member sees a read-only note instead of the client list', async () => {
    vi.stubGlobal('fetch', makeFetch([...baseRoutes, memberMe]));

    renderWithProviders(<Settings />);

    const section = (
      await screen.findByRole('heading', { name: 'Connected AI clients' })
    ).closest('section')!;
    expect(
      await within(section).findByText(/only the account owner can manage ai clients/i),
    ).toBeInTheDocument();
    expect(oauthMocks.listGrants).not.toHaveBeenCalled();
  });
});
