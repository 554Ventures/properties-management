// Sign-in / sign-up / password-recovery screen, rendered by AuthGate only in
// auth mode (deployment plan §4.1). Email/password via supabase-js; the API
// provisions the 554 Properties account on the first authenticated request, so
// there is no separate signup call to our backend.
//
// Four modes: sign_in, sign_up, forgot (request a reset link), and
// update_password (set a new one after following the link — AuthGate mounts us
// in this mode when a recovery session is active).
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { LoginArtPanel } from '../components/login/LoginArtPanel';
import { Button } from '../components/ui/Button';
import { FormField, Input } from '../components/ui/FormField';
import { CURRENT_POLICY_VERSION, markConsentPending } from '../lib/consent';
import { supabase } from '../lib/supabase';
import { usePageTitle } from '../lib/usePageTitle';
import { useAuth } from '../state/auth';

type Mode = 'sign_in' | 'sign_up' | 'forgot' | 'update_password';

/** Google's official multi-color "G" mark — kept as-is per Google's brand guidelines, not a design-token color. */
function GoogleIcon() {
  return (
    <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}

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
  const [agreedToPolicies, setAgreedToPolicies] = useState(false);
  usePageTitle(TITLES[mode]);

  // Required before creating an account (docs/SECURITY_PRIVACY_AUDIT.md §B5).
  const consentRequired = mode === 'sign_up' && !agreedToPolicies;

  const signInWithGoogle = async () => {
    if (!supabase || busy || consentRequired) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    if (mode === 'sign_up') markConsentPending(CURRENT_POLICY_VERSION);
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/` },
    });
    // On success the browser navigates to Google, so only the error path needs to clear `busy`.
    if (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setNotice(null);
    setPassword('');
    setConfirm('');
    setAgreedToPolicies(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabase || busy || consentRequired) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === 'sign_in') {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) setError(err.message);
        // Success: onAuthStateChange flips the session and AuthGate unmounts us.
      } else if (mode === 'sign_up') {
        // Stashed before the call: signUp() may return a session immediately
        // (email confirmation off) or not (confirmation required, session
        // arrives later after the user clicks the email link and signs in) —
        // AuthProvider records it server-side as soon as a session appears.
        markConsentPending(CURRENT_POLICY_VERSION);
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
    <div className="flex min-h-screen flex-col bg-app lg:flex-row">
      {/* Desktop (lg+): right 40%, full height, form on the left. Mobile/tablet:
          remaining space below the form, so the chicken still shows
          bottom-right of the screen — kept as a stacked layout through
          tablet-portrait widths, since a narrow-but-tall side panel there
          looked sparse/awkward. Order is order-2 (art) / order-1 (form) at
          every breakpoint, so no responsive override is needed. */}
      <div className="order-1 flex justify-center px-4 pb-6 pt-10 lg:w-3/5 lg:flex-1 lg:items-center lg:py-4">
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
                hint={
                  mode === 'sign_up' || mode === 'update_password'
                    ? 'At least 8 characters.'
                    : undefined
                }
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
            {mode === 'sign_up' && (
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={agreedToPolicies}
                  onChange={(e) => setAgreedToPolicies(e.target.checked)}
                  aria-describedby="consent-hint"
                  required
                />
                <span id="consent-hint">
                  I agree to the{' '}
                  <Link
                    to="/privacy"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-brand underline"
                  >
                    Privacy Policy
                  </Link>{' '}
                  and{' '}
                  <Link
                    to="/terms"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-brand underline"
                  >
                    Terms of Service
                  </Link>
                  .
                </span>
              </label>
            )}

            <Button type="submit" busy={busy} disabled={consentRequired}>
              {submitLabel}
            </Button>

            {(mode === 'sign_in' || mode === 'sign_up') && supabase && (
              <>
                <div className="flex items-center gap-3" role="presentation">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-xs text-ink-muted">or</span>
                  <div className="h-px flex-1 bg-border" />
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  busy={busy}
                  disabled={consentRequired}
                  onClick={() => void signInWithGoogle()}
                >
                  <GoogleIcon />
                  Continue with Google
                </Button>
              </>
            )}

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

      <LoginArtPanel className="order-2 min-h-[240px] flex-1 lg:min-h-0 lg:w-2/5 lg:flex-none" />
    </div>
  );
}
