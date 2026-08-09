// OAuth consent screen (Supabase's OAuth 2.1 server doesn't host its own —
// docs/PLAN, remote MCP connector): reads ?authorization_id=, shows the
// requesting client + requested scopes, and wires Approve/Deny to
// approveAuthorization/denyAuthorization + a redirect. Demo mode (no
// Supabase configured) and the already-granted / expired-link dead ends are
// covered too.
import type { OAuthAuthorizationDetails } from '@supabase/supabase-js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const oauthMocks = vi.hoisted(() => ({
  getAuthorizationDetails: vi.fn(),
  approveAuthorization: vi.fn(),
  denyAuthorization: vi.fn(),
}));

const supabaseState = vi.hoisted(() => ({
  current: null as null | { auth: { oauth: typeof oauthMocks } },
}));

vi.mock('../lib/supabase', () => ({
  get supabase() {
    return supabaseState.current;
  },
}));

import { OAuthConsent } from '../pages/OAuthConsent';

const clientDetails: OAuthAuthorizationDetails = {
  authorization_id: 'auth123',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  client: {
    id: 'client-1',
    name: 'Claude Desktop',
    uri: 'https://claude.ai',
    logo_uri: '',
  },
  user: { id: 'u1', email: 'owner@example.com' },
  scope: 'openid email offline_access',
};

function renderConsent(path = '/oauth/consent?authorization_id=auth123') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <OAuthConsent />
    </MemoryRouter>,
  );
}

let assignMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  assignMock = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign: assignMock },
  });
  supabaseState.current = { auth: { oauth: oauthMocks } };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('OAuthConsent — demo mode', () => {
  it('renders an explanatory dead end instead of crashing when Supabase is not configured', () => {
    supabaseState.current = null;
    renderConsent();
    expect(screen.getByText('Not available in demo mode')).toBeInTheDocument();
    expect(oauthMocks.getAuthorizationDetails).not.toHaveBeenCalled();
  });
});

describe('OAuthConsent — missing authorization_id', () => {
  it('shows a readable dead end, not a blank screen', () => {
    renderConsent('/oauth/consent');
    expect(screen.getByText("This link is incomplete")).toBeInTheDocument();
    expect(oauthMocks.getAuthorizationDetails).not.toHaveBeenCalled();
  });
});

describe('OAuthConsent — already granted', () => {
  it('skips the UI and redirects immediately when only a redirect_url comes back', async () => {
    oauthMocks.getAuthorizationDetails.mockResolvedValueOnce({
      data: { redirect_url: 'https://claude.ai/api/mcp/auth_callback?code=already' },
      error: null,
    });
    renderConsent();

    await waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith(
        'https://claude.ai/api/mcp/auth_callback?code=already',
      ),
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
});

describe('OAuthConsent — expired/invalid authorization', () => {
  it('shows the error message as a readable dead end', async () => {
    oauthMocks.getAuthorizationDetails.mockResolvedValueOnce({
      data: null,
      error: { message: 'Authorization request has expired' },
    });
    renderConsent();

    expect(await screen.findByText('Authorization request has expired')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to 554 properties/i })).toHaveAttribute(
      'href',
      '/',
    );
  });
});

describe('OAuthConsent — consent screen', () => {
  it('renders the client name, requested scopes, and a plain-English explanation', async () => {
    oauthMocks.getAuthorizationDetails.mockResolvedValueOnce({ data: clientDetails, error: null });
    renderConsent();

    expect(await screen.findByText('Claude Desktop wants to connect')).toBeInTheDocument();
    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
    expect(screen.getByText('Confirm who you are')).toBeInTheDocument();
    expect(screen.getByText('Your email address')).toBeInTheDocument();
    expect(screen.getByText('Stay connected between sessions')).toBeInTheDocument();
    expect(screen.getByText(/take any action your account permissions allow/i)).toBeInTheDocument();
  });

  it('approves and redirects to the returned URL', async () => {
    oauthMocks.getAuthorizationDetails.mockResolvedValueOnce({ data: clientDetails, error: null });
    oauthMocks.approveAuthorization.mockResolvedValueOnce({
      data: { redirect_url: 'https://claude.ai/api/mcp/auth_callback?code=abc&state=xyz' },
      error: null,
    });
    renderConsent();

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(oauthMocks.approveAuthorization).toHaveBeenCalledWith('auth123', {
        skipBrowserRedirect: true,
      }),
    );
    await waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith(
        'https://claude.ai/api/mcp/auth_callback?code=abc&state=xyz',
      ),
    );
  });

  it('denies and redirects to the returned URL', async () => {
    oauthMocks.getAuthorizationDetails.mockResolvedValueOnce({ data: clientDetails, error: null });
    oauthMocks.denyAuthorization.mockResolvedValueOnce({
      data: { redirect_url: 'https://claude.ai/api/mcp/auth_callback?error=access_denied' },
      error: null,
    });
    renderConsent();

    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));

    await waitFor(() =>
      expect(oauthMocks.denyAuthorization).toHaveBeenCalledWith('auth123', {
        skipBrowserRedirect: true,
      }),
    );
    await waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith(
        'https://claude.ai/api/mcp/auth_callback?error=access_denied',
      ),
    );
  });

  it('surfaces an approval error inline without navigating away', async () => {
    oauthMocks.getAuthorizationDetails.mockResolvedValueOnce({ data: clientDetails, error: null });
    oauthMocks.approveAuthorization.mockResolvedValueOnce({
      data: null,
      error: { message: 'Could not approve — try again' },
    });
    renderConsent();

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not approve — try again');
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('has no axe violations', async () => {
    oauthMocks.getAuthorizationDetails.mockResolvedValueOnce({ data: clientDetails, error: null });
    const { container } = renderConsent();

    await screen.findByText('Claude Desktop wants to connect');

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });
});
