// Login page (auth mode, deployment plan §4.1): sign-in flow wiring, error
// surfacing, sign-up confirmation notice, and the merge-blocking axe check.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';

const signInWithPassword = vi.fn();
const signUp = vi.fn();

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
