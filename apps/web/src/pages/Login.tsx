// Sign-in / sign-up / password-recovery screen, rendered by AuthGate only in
// auth mode (deployment plan §4.1). Email/password via supabase-js; the API
// provisions the 554 Properties account on the first authenticated request, so
// there is no separate signup call to our backend.
//
// Four modes: sign_in, sign_up, forgot (request a reset link), and
// update_password (set a new one after following the link — AuthGate mounts us
// in this mode when a recovery session is active).
import { useState, type FormEvent } from 'react';
import { Button } from '../components/ui/Button';
import { FormField, Input } from '../components/ui/FormField';
import { supabase } from '../lib/supabase';
import { usePageTitle } from '../lib/usePageTitle';
import { useAuth } from '../state/auth';

type Mode = 'sign_in' | 'sign_up' | 'forgot' | 'update_password';

const TITLES: Record<Mode, string> = {
  sign_in: 'Sign in',
  sign_up: 'Create account',
  forgot: 'Reset password',
  update_password: 'Set new password',
};

const HEADINGS: Record<Mode, string> = {
  sign_in: 'Sign in',
  sign_up: 'Create your account',
  forgot: 'Reset your password',
  update_password: 'Set a new password',
};

export function Login({ initialMode = 'sign_in' }: { initialMode?: Mode }) {
  const { endRecovery, signOut } = useAuth();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  usePageTitle(TITLES[mode]);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setNotice(null);
    setPassword('');
    setConfirm('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabase || busy) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === 'sign_in') {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) setError(err.message);
        // Success: onAuthStateChange flips the session and AuthGate unmounts us.
      } else if (mode === 'sign_up') {
        const { data, error: err } = await supabase.auth.signUp({ email, password });
        if (err) {
          setError(err.message);
        } else if (!data.session) {
          // Email confirmation is on for this Supabase project.
          setNotice('Check your email for a confirmation link, then sign in.');
          setMode('sign_in');
        }
      } else if (mode === 'forgot') {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/`,
        });
        if (err) {
          setError(err.message);
        } else {
          // Neutral wording — never reveal whether an account exists.
          setNotice('If an account exists for that email, a reset link is on its way.');
          setMode('sign_in');
        }
      } else {
        // update_password — an active recovery session lets us set a new one.
        if (password.length < 8) {
          setError('Password must be at least 8 characters.');
          return;
        }
        if (password !== confirm) {
          setError('Passwords do not match.');
          return;
        }
        const { error: err } = await supabase.auth.updateUser({ password });
        if (err) {
          setError(err.message);
        } else {
          // Recovery complete; the existing session drops us into the app.
          endRecovery();
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const showEmail = mode !== 'update_password';
  const showPassword = mode !== 'forgot';
  const submitLabel =
    mode === 'sign_in'
      ? 'Sign in'
      : mode === 'sign_up'
        ? 'Create account'
        : mode === 'forgot'
          ? 'Send reset link'
          : 'Update password';

  return (
    <div className="grid min-h-screen place-items-center bg-app px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-3">
          <img src="/logo.svg" alt="" aria-hidden="true" className="h-11 w-11 rounded-lg" />
          <span className="text-2xl font-semibold tracking-tight text-ink">554 Properties</span>
        </div>
        <form
          onSubmit={submit}
          className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-6 shadow-card"
          aria-labelledby="login-heading"
        >
          <h1 id="login-heading" className="text-lg font-semibold text-ink">
            {HEADINGS[mode]}
          </h1>
          {mode === 'forgot' && (
            <p className="text-sm text-ink-muted">
              Enter your email and we&rsquo;ll send you a link to set a new password.
            </p>
          )}
          {mode === 'update_password' && (
            <p className="text-sm text-ink-muted">Choose a new password for your account.</p>
          )}
          {notice && (
            <p role="status" className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-ink">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          {showEmail && (
            <FormField label="Email" htmlFor="login-email" required>
              <Input
                type="email"
                name="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </FormField>
          )}
          {showPassword && (
            <FormField
              label={mode === 'update_password' ? 'New password' : 'Password'}
              htmlFor="login-password"
              required
              hint={mode === 'sign_up' || mode === 'update_password' ? 'At least 8 characters.' : undefined}
            >
              <Input
                type="password"
                name="password"
                autoComplete={mode === 'sign_in' ? 'current-password' : 'new-password'}
                minLength={mode === 'sign_up' || mode === 'update_password' ? 8 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </FormField>
          )}
          {mode === 'update_password' && (
            <FormField label="Confirm new password" htmlFor="login-confirm" required>
              <Input
                type="password"
                name="confirm"
                autoComplete="new-password"
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </FormField>
          )}
          <Button type="submit" busy={busy}>
            {submitLabel}
          </Button>

          {mode === 'sign_in' && (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="text-left text-sm font-medium text-brand hover:underline"
                onClick={() => switchMode('forgot')}
              >
                Forgot your password?
              </button>
              <button
                type="button"
                className="text-left text-sm font-medium text-brand hover:underline"
                onClick={() => switchMode('sign_up')}
              >
                New to 554 Properties? Create an account
              </button>
            </div>
          )}
          {mode === 'sign_up' && (
            <button
              type="button"
              className="text-sm font-medium text-brand hover:underline"
              onClick={() => switchMode('sign_in')}
            >
              Already have an account? Sign in
            </button>
          )}
          {mode === 'forgot' && (
            <button
              type="button"
              className="text-sm font-medium text-brand hover:underline"
              onClick={() => switchMode('sign_in')}
            >
              Back to sign in
            </button>
          )}
          {mode === 'update_password' && (
            <button
              type="button"
              className="text-sm font-medium text-brand hover:underline"
              onClick={() => void signOut()}
            >
              Back to sign in
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
