// Login page (auth mode, deployment plan §4.1): sign-in flow wiring, error
// surfacing, sign-up confirmation notice, password recovery, and the
// merge-blocking axe check.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
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

import { Login } from '../pages/Login';

function fillCredentials(email: string, password: string): void {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: password } });
}

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('signs in with the entered credentials', async () => {
    signInWithPassword.mockResolvedValueOnce({ error: null });
    render(<Login />);

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
    render(<Login />);

    fillCredentials('sam@example.com', 'wrong');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Invalid login credentials');
  });

  it('shows the confirmation notice after sign-up without a session', async () => {
    signUp.mockResolvedValueOnce({ data: { session: null }, error: null });
    render(<Login />);

    fireEvent.click(screen.getByRole('button', { name: /create an account/i }));
    fillCredentials('new@example.com', 'longenoughpw');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(/check your email/i);
    // Flips back to sign-in so the confirmed user can log in directly.
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('starts the Google OAuth flow', async () => {
    signInWithOAuth.mockResolvedValueOnce({ error: null });
    render(<Login />);

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
    render(<Login />);

    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('OAuth is misconfigured');
  });

  it('requests a reset link from the forgot-password flow', async () => {
    resetPasswordForEmail.mockResolvedValueOnce({ error: null });
    render(<Login />);

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
    render(<Login initialMode="update_password" />);

    fireEvent.change(screen.getByLabelText(/^new password/i), { target: { value: 'brandnewpw1' } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), {
      target: { value: 'brandnewpw1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: 'brandnewpw1' }));
  });

  it('rejects mismatched passwords in recovery mode without calling Supabase', async () => {
    render(<Login initialMode="update_password" />);

    fireEvent.change(screen.getByLabelText(/^new password/i), { target: { value: 'brandnewpw1' } });
    fireEvent.change(screen.getByLabelText(/confirm new password/i), {
      target: { value: 'mismatchpw1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/do not match/i);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Login />);
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
