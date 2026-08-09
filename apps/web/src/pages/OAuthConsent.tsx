// Supabase's OAuth 2.1 server (docs/PLAN — remote MCP connector) does not
// host its own consent screen: its /authorize endpoint redirects here with
// ?authorization_id=, and we own the approve/deny UI. Rendered at
// /oauth/consent (router.tsx) as a top-level sibling of /privacy, wrapped in
// its own <AuthGate> — it needs a signed-in session but not the app chrome.
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { OAuthAuthorizationDetails } from '@supabase/supabase-js';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { IconAlertCircle, IconSparkle } from '../components/ui/icons';
import { supabase } from '../lib/supabase';
import { usePageTitle } from '../lib/usePageTitle';

// Supabase's OAuth server only advertises this fixed scope list (no custom
// scopes) — plain-English labels for the ones we might see requested.
const SCOPE_LABELS: Record<string, string> = {
  openid: 'Confirm who you are',
  profile: 'Your name',
  email: 'Your email address',
  phone: 'Your phone number',
  offline_access: 'Stay connected between sessions',
};

type ViewState =
  | { kind: 'loading' }
  | { kind: 'demo' }
  | { kind: 'missing_id' }
  | { kind: 'redirecting' }
  | { kind: 'error'; message: string }
  | { kind: 'consent'; details: OAuthAuthorizationDetails };

function ConsentShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-app px-4 py-10">
      <div className="flex items-center gap-3">
        <img src="/logo.svg" alt="" aria-hidden="true" className="h-9 w-9 rounded-lg" />
        <span className="text-xl font-semibold tracking-tight text-ink">554 Properties</span>
      </div>
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

function DeadEnd({ title, body }: { title: string; body: string }) {
  return (
    <Card flush>
      <EmptyState
        icon={<IconAlertCircle size={28} />}
        title={title}
        body={body}
        action={
          <Link to="/" className="text-sm font-medium text-brand hover:underline">
            Back to 554 Properties
          </Link>
        }
      />
    </Card>
  );
}

export function OAuthConsent() {
  usePageTitle('Connect an AI client');
  const [searchParams] = useSearchParams();
  const authorizationId = searchParams.get('authorization_id');
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [actionBusy, setActionBusy] = useState<'approve' | 'deny' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) {
      setState({ kind: 'demo' });
      return;
    }
    if (!authorizationId) {
      setState({ kind: 'missing_id' });
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    void supabase.auth.oauth.getAuthorizationDetails(authorizationId).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setState({ kind: 'error', message: error.message });
        return;
      }
      if ('authorization_id' in data) {
        setState({ kind: 'consent', details: data });
        return;
      }
      // Only redirect_url came back — consent was already granted for this
      // request. Skip the UI and send the browser straight back to the client.
      setState({ kind: 'redirecting' });
      window.location.assign(data.redirect_url);
    });
    return () => {
      cancelled = true;
    };
  }, [authorizationId]);

  const decide = async (action: 'approve' | 'deny') => {
    if (!supabase || !authorizationId) return;
    setActionBusy(action);
    setActionError(null);
    const { data, error } =
      action === 'approve'
        ? await supabase.auth.oauth.approveAuthorization(authorizationId, {
            skipBrowserRedirect: true,
          })
        : await supabase.auth.oauth.denyAuthorization(authorizationId, {
            skipBrowserRedirect: true,
          });
    if (error) {
      setActionError(error.message);
      setActionBusy(null);
      return;
    }
    window.location.assign(data.redirect_url);
  };

  if (state.kind === 'demo') {
    return (
      <ConsentShell>
        <DeadEnd
          title="Not available in demo mode"
          body="This preview is running without Supabase authentication configured, so there's no account to connect an AI client to."
        />
      </ConsentShell>
    );
  }

  if (state.kind === 'missing_id') {
    return (
      <ConsentShell>
        <DeadEnd
          title="This link is incomplete"
          body="We couldn't find an authorization request in this link. Go back to the AI client and start the connection again."
        />
      </ConsentShell>
    );
  }

  if (state.kind === 'error') {
    return (
      <ConsentShell>
        <DeadEnd
          title="This request can't be completed"
          body={state.message || 'The authorization request is invalid or has expired. Go back to the AI client and start again.'}
        />
      </ConsentShell>
    );
  }

  if (state.kind === 'loading' || state.kind === 'redirecting') {
    return (
      <ConsentShell>
        <Card>
          <Skeleton className="h-48 w-full" />
          <p className="sr-only" role="status">
            {state.kind === 'redirecting' ? 'Redirecting…' : 'Loading…'}
          </p>
        </Card>
      </ConsentShell>
    );
  }

  const { details } = state;
  const scopes = details.scope.split(/\s+/).filter(Boolean);

  return (
    <ConsentShell>
      <Card>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-ink-ai">
            <IconSparkle size={18} />
            <span className="text-xs font-semibold uppercase tracking-wide">
              AI client connection request
            </span>
          </div>
          <div>
            <h1 className="text-lg font-semibold text-ink">
              {details.client.name} wants to connect
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              Signed in as <span className="font-medium text-ink">{details.user.email}</span>
            </p>
          </div>

          {scopes.length > 0 && (
            <div>
              <p className="mb-1.5 text-sm font-medium text-ink">Requesting:</p>
              <ul className="flex flex-col gap-1 text-sm text-ink-muted">
                {scopes.map((scope) => (
                  <li key={scope} className="flex items-start gap-1.5">
                    <span aria-hidden="true">&middot;</span>
                    {SCOPE_LABELS[scope] ?? scope}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="rounded-md bg-surface-sunken px-3 py-2.5 text-sm text-ink-muted">
            Approving this grants {details.client.name} the same access you have in 554
            Properties: it can see your properties, tenants, leases, and financial data, and take
            any action your account permissions allow — such as creating transactions or updating
            rent records — on your behalf. Every action it takes is recorded in your account's
            audit trail, and you can revoke access anytime from Settings &rarr; Connected AI
            clients.
          </p>

          {actionError && (
            <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
              {actionError}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              busy={actionBusy === 'deny'}
              disabled={actionBusy !== null && actionBusy !== 'deny'}
              onClick={() => void decide('deny')}
            >
              Deny
            </Button>
            <Button
              type="button"
              variant="primary"
              busy={actionBusy === 'approve'}
              disabled={actionBusy !== null && actionBusy !== 'approve'}
              onClick={() => void decide('approve')}
            >
              Approve
            </Button>
          </div>
        </div>
      </Card>
    </ConsentShell>
  );
}
