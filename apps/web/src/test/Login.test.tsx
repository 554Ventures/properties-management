// Login page (auth mode, deployment plan §4.1): sign-in flow wiring, error
// surfacing, sign-up confirmation notice, password recovery, and the
// merge-blocking axe check.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signInWithPassword = vi.fn();
const signUp = vi.fn();
const resetPasswordForEmail = vi.fn();
const updateUser = vi.fn();
const signInWithOAuth = vi.fn();

vi.mock('../lib/supabase', () => ({
  authEnabled: true,
  supabase: {
    auth: {
      get signInWithPassword() {
        return signInWithPassword;
      },
      get signUp() {
        return signUp;
      },
      get resetPasswordForEmail() {
        return resetPasswordForEmail;
      },
      get updateUser() {
        return updateUser;
      },
      get signInWithOAuth() {
        return signInWithOAuth;
      },
    },
  },
  getAccessToken: async () => undefined,
}));

import { peekPendingConsentVersion, resetConsentStateForTests } from '../lib/consent';
import { Login } from '../pages/Login';

// Login now links to /privacy and /terms (react-router <Link>), which needs
// a Router context to render at all.
function renderLogin(props?: Parameters<typeof Login>[0]) {
  return render(
    <MemoryRouter>
      <Login {...props} />
    </MemoryRouter>,
  );
}

function fillCredentials(email: string, password: string): void {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: password } });
}

function agreeToPolicies(): void {
  fireEvent.click(screen.getByRole('checkbox'));
}

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetConsentStateForTests();
  });

  it('signs in with the entered credentials', async () => {
    signInWithPassword.mockResolvedValueOnce({ error: null });
    renderLogin();

    fillCredentials('sam@example.com', 'hunter2hunter2');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(signInWithPassword).toHaveBeenCalledWith({
        email: 'sam@example.com',
        password: 'hunter2hunter2',
      }),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces sign-in errors as an alert', async () => {
    signInWithPassword.mockResolvedValueOnce({ error: { message: 'Invalid login credentials' } });
    renderLogin();

    fillCredentials('sam@example.com', 'wrong');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Invalid login credentials');
  });

  it('shows the confirmation notice after sign-up without a session, and stashes consent for later', async () => {
    signUp.mockResolvedValueOnce({ data: { session: null }, error: null });
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: /create an account/i }));
    fillCredentials('new@example.com', 'longenoughpw');
    agreeToPolicies();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(/check your email/i);
    // Flips back to sign-in so the confirmed user can log in directly.
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    // signUp() returned no session (email confirmation on) — the consent
    // version is stashed for AuthProvider to record once a session appears.
    expect(peekPendingConsentVersion()).toBeTruthy();
  });

  it('disables account creation until the Privacy Policy / ToS checkbox is checked', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: /create an account/i }));
    fillCredentials('new@example.com', 'longenoughpw');

    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();
    expect(signUp).not.toHaveBeenCalled();

    agreeToPolicies();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();
  });

  it('links the sign-up checkbox to the canonical /privacy and /terms pages, opened in a new tab', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: /create an account/i }));

    const privacyLink = screen.getByRole('link', { name: 'Privacy Policy' });
    expect(privacyLink).toHaveAttribute('href', '/privacy');
    expect(privacyLink).toHaveAttribute('target', '_blank');
    expect(privacyLink).toHaveAttribute('rel', expect.stringContaining('noopener'));

    const termsLink = screen.getByRole('link', { name: 'Terms of Service' });
    expect(termsLink).toHaveAttribute('href', '/terms');
    expect(termsLink).toHaveAttribute('target', '_blank');
  });

  it('also gates Google sign-up on the consent checkbox', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: /create an account/i }));

    expect(screen.getByRole('button', { name: /continue with google/i })).toBeDisabled();
    agreeToPolicies();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeEnabled();
  });

  it('starts the Google OAuth flow', async () => {
    signInWithOAuth.mockResolvedValueOnce({ error: null });
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    await waitFor(() =>
      expect(signInWithOAuth).toHaveBeenCalledWith({
        provider: 'google',
        options: { redirectTo: expect.stringContaining('/') },
      }),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces Google OAuth errors as an alert', async () => {
    signInWithOAuth.mockResolvedValueOnce({ error: { message: 'OAuth is misconfigured' } });
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('OAuth is misconfigured');
  });

  it('requests a reset link from the forgot-password flow', async () => {
    resetPasswordForEmail.mockResolvedValueOnce({ error: null });
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: /forgot your password/i }));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'sam@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    await waitFor(() =>
      expect(resetPasswordForEmail).toHaveBeenCalledWith(
        'sam@example.com',
        expect.objectContaining({ redirectTo: expect.stringContaining('/') }),
      ),
    );
    // Neutral wording (no account enumeration) and a return to sign-in.
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(/reset link/i);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('sets a new password in recovery mode', async () => {
    updateUser.mockResolvedValueOnce({ error: null });
    renderLogin({ initialMode: "update_password" });

    fireEvent.change(screen.getByLabelText(/^new password/i), { target: { value: 'brandnewpw1' } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), {
      target: { value: 'brandnewpw1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: 'brandnewpw1' }));
  });

  it('rejects mismatched passwords in recovery mode without calling Supabase', async () => {
    renderLogin({ initialMode: "update_password" });

    fireEvent.change(screen.getByLabelText(/^new password/i), { target: { value: 'brandnewpw1' } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), {
      target: { value: 'mismatchpw1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/do not match/i);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('renders the decorative chicken art panel as aria-hidden, out of the a11y tree and tab order', () => {
    const { container } = renderLogin();
    const art = container.querySelector('img[src="/login-art.svg"]');
    expect(art).not.toBeNull();
    expect(art).toHaveAttribute('alt', '');
    // The whole panel (art + decorative circles), not just the <img>, must be
    // hidden — none of it is informational content.
    const panel = art?.closest('[aria-hidden="true"]');
    expect(panel).not.toBeNull();
    // Nothing inside the art panel should be reachable via the a11y tree —
    // confirm no role/label leaks through (it's purely decorative circles + image).
    expect(panel?.querySelectorAll('button, a, input, [tabindex]')).toHaveLength(0);
  });

  it('has no axe violations', async () => {
    const { container } = renderLogin();
    const results = await axe.run(container, {
      rules: {
        // jsdom does not lay out or paint — color-contrast can't be computed.
        'color-contrast': { enabled: false },
      },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });
});
