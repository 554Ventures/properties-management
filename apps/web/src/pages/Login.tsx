// Sign-in / sign-up screen, rendered by AuthGate only in auth mode
// (deployment plan §4.1). Email/password via supabase-js; the API provisions
// the Hearth account on the first authenticated request, so there is no
// separate signup call to our backend.
import { useState, type FormEvent } from 'react';
import { Button } from '../components/ui/Button';
import { FormField, Input } from '../components/ui/FormField';
import { supabase } from '../lib/supabase';
import { usePageTitle } from '../lib/usePageTitle';

type Mode = 'sign_in' | 'sign_up';

export function Login() {
  const [mode, setMode] = useState<Mode>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  usePageTitle(mode === 'sign_in' ? 'Sign in' : 'Create account');

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
      } else {
        const { data, error: err } = await supabase.auth.signUp({ email, password });
        if (err) {
          setError(err.message);
        } else if (!data.session) {
          // Email confirmation is on for this Supabase project.
          setNotice('Check your email for a confirmation link, then sign in.');
          setMode('sign_in');
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-app px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span
            aria-hidden="true"
            className="grid h-10 w-10 place-items-center rounded-md bg-brand text-lg font-bold text-ink-on-brand"
          >
            H
          </span>
          <span className="text-2xl font-semibold tracking-tight text-ink">Hearth</span>
        </div>
        <form
          onSubmit={submit}
          className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-6 shadow-card"
          aria-labelledby="login-heading"
        >
          <h1 id="login-heading" className="text-lg font-semibold text-ink">
            {mode === 'sign_in' ? 'Sign in' : 'Create your account'}
          </h1>
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
          <FormField label="Email" htmlFor="login-email" required>
            <Input
              type="email"
              name="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </FormField>
          <FormField
            label="Password"
            htmlFor="login-password"
            required
            hint={mode === 'sign_up' ? 'At least 8 characters.' : undefined}
          >
            <Input
              type="password"
              name="password"
              autoComplete={mode === 'sign_in' ? 'current-password' : 'new-password'}
              minLength={mode === 'sign_up' ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </FormField>
          <Button type="submit" busy={busy}>
            {mode === 'sign_in' ? 'Sign in' : 'Create account'}
          </Button>
          <button
            type="button"
            className="text-sm font-medium text-brand hover:underline"
            onClick={() => {
              setMode(mode === 'sign_in' ? 'sign_up' : 'sign_in');
              setError(null);
              setNotice(null);
            }}
          >
            {mode === 'sign_in'
              ? 'New to Hearth? Create an account'
              : 'Already have an account? Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
