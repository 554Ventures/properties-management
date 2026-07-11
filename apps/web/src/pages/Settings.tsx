// Settings (PRD §5.9): account profile + tax rate, integrations (Plaid is a
// real Sandbox/Production Link flow; Stripe/Docusign/Email stay mock —
// docs/WHATS_NEXT.md §3). MCP is stdio/local-only (no remote transport
// exists yet — property-app-deployment-plan.md §8), so it has no UI here.
import { useEffect, useState, type FormEvent } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { AccountSettings, Integration, IntegrationType } from '@hearth/shared';
import {
  useCreatePlaidLinkToken,
  useDisconnectIntegration,
  useExchangePlaidPublicToken,
  useIntegrations,
  usePushDevices,
  useSettings,
  useUpdateSettings,
} from '../api/queries';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { FormField, Input } from '../components/ui/FormField';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge } from '../components/ui/StatusBadge';
import { useToast } from '../components/ui/Toast';
import { formatDateTime } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';
import {
  authenticateBiometric,
  isBiometricLockEnabled,
  setBiometricLockEnabled,
} from '../native/biometric';
import { isNativeApp } from '../native/platform';
import { reenablePush } from '../native/push';
import { useAuth } from '../state/auth';

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
];

export function Settings() {
  usePageTitle('Settings');
  const settings = useSettings();
  const integrations = useIntegrations();
  const location = useLocation();

  // createBrowserRouter doesn't scroll to a hash target on client-side
  // navigation (no <ScrollRestoration>), so do it ourselves — used by the
  // "Go to Settings" toast action on Money's bank-import error.
  useEffect(() => {
    if (!location.hash) return;
    const target = document.getElementById(location.hash.slice(1));
    target?.scrollIntoView({ block: 'start' });
  }, [location.hash]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        breadcrumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Settings' }]}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section aria-label="Account">
          {settings.isPending ? (
            <Card>
              <Skeleton className="h-64 w-full" />
            </Card>
          ) : settings.isError ? (
            <ErrorNotice error={settings.error} onRetry={() => void settings.refetch()} />
          ) : (
            <AccountForm account={settings.data} />
          )}
        </section>

        <div className="flex flex-col gap-6">
          <section id="integrations" aria-label="Integrations">
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-ink">Integrations</h2>
              {integrations.isPending ? (
                <Skeleton className="h-40 w-full" />
              ) : integrations.isError ? (
                <ErrorNotice
                  error={integrations.error}
                  onRetry={() => void integrations.refetch()}
                />
              ) : (
                <ul className="divide-y divide-border">
                  {KNOWN_INTEGRATIONS.map((known) => {
                    const row = integrations.data.find((i) => i.type === known.type) ?? known;
                    return <PlaidIntegrationRow key={known.type} row={row} />;
                  })}
                </ul>
              )}
            </Card>
          </section>

          <section aria-label="Legal">
            <Card>
              <h2 className="mb-3 text-sm font-semibold text-ink">Legal</h2>
              <ul className="flex flex-col gap-2 text-sm">
                <li>
                  <Link to="/privacy" className="font-medium text-brand underline">
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link to="/terms" className="font-medium text-brand underline">
                    Terms of Service
                  </Link>
                </li>
              </ul>
            </Card>
          </section>

          <MobileAppSection />

          <SessionSection />
        </div>
      </div>
    </div>
  );
}

/** iOS-shell-only card: Face ID lock toggle + push registration status.
 *  Renders nothing in plain browsers (isNativeApp is false there). */
function MobileAppSection() {
  const native = isNativeApp();
  const navigate = useNavigate();
  const devices = usePushDevices(native);
  const [faceIdEnabled, setFaceIdEnabled] = useState(() => isBiometricLockEnabled());
  const [faceIdError, setFaceIdError] = useState(false);
  const [reenabling, setReenabling] = useState(false);

  if (!native) return null;

  const toggleFaceId = async (next: boolean) => {
    setFaceIdError(false);
    if (next) {
      // Prove Face ID works before locking the app behind it.
      const ok = await authenticateBiometric('Confirm Face ID to enable the app lock');
      if (!ok) {
        setFaceIdError(true);
        return;
      }
    }
    setBiometricLockEnabled(next);
    setFaceIdEnabled(next);
  };

  const reenable = async () => {
    setReenabling(true);
    try {
      await reenablePush((path) => navigate(path));
      await devices.refetch();
    } finally {
      setReenabling(false);
    }
  };

  const deviceCount = devices.data?.length ?? 0;

  return (
    <section aria-label="Mobile app">
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-ink">Mobile app</h2>
        <div className="flex flex-col gap-4">
          <div>
            <label className="flex items-center justify-between gap-3 text-sm text-ink">
              <span className="font-medium">Require Face ID to open the app</span>
              <input
                type="checkbox"
                checked={faceIdEnabled}
                aria-describedby={faceIdError ? 'face-id-error' : undefined}
                onChange={(e) => void toggleFaceId(e.target.checked)}
              />
            </label>
            {faceIdError && (
              <p id="face-id-error" className="mt-1 text-sm text-danger">
                Face ID check failed — the lock stays off so you aren&rsquo;t locked out.
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-muted">
              {devices.isPending
                ? 'Checking notification status…'
                : deviceCount > 0
                  ? `Push notifications are on (${deviceCount} ${deviceCount === 1 ? 'device' : 'devices'}).`
                  : 'Push notifications are off on this device.'}
            </p>
            {!devices.isPending && deviceCount === 0 && (
              <Button variant="secondary" size="sm" busy={reenabling} onClick={() => void reenable()}>
                Enable notifications
              </Button>
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}

/** Signed-in identity + sign out; hidden in demo mode (no login exists). */
function SessionSection() {
  const { enabled, session, signOut } = useAuth();
  if (!enabled) return null;
  return (
    <section aria-label="Session">
      <Card>
        <h2 className="mb-2 text-sm font-semibold text-ink">Session</h2>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-ink-muted">
            Signed in as{' '}
            <span className="font-medium text-ink">{session?.user.email ?? 'unknown'}</span>
          </p>
          <Button variant="secondary" size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </Card>
    </section>
  );
}

function AccountForm({ account }: { account: AccountSettings }) {
  const update = useUpdateSettings();
  const { toast } = useToast();
  const [name, setName] = useState(account.name);
  const [email, setEmail] = useState(account.email);
  const [taxRatePct, setTaxRatePct] = useState(String(account.taxRatePct));
  const [timezone, setTimezone] = useState(account.timezone);

  const timezones = TIMEZONES.includes(account.timezone)
    ? TIMEZONES
    : [account.timezone, ...TIMEZONES];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      {
        name: name.trim() || undefined,
        email: email.trim() || undefined,
        taxRatePct: Math.min(100, Math.max(0, Math.round(Number(taxRatePct) || 0))),
        timezone,
      },
      {
        onSuccess: () => toast('Settings saved.', 'positive'),
        onError: () => toast('Could not save settings. Try again.', 'danger'),
      },
    );
  };

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-ink">Account</h2>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="Name" htmlFor="settings-name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </FormField>
        <FormField label="Email" htmlFor="settings-email" required>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </FormField>
        <FormField
          label="Tax set-aside rate (%)"
          htmlFor="settings-tax-rate"
          hint="Used for the dashboard tax estimate — not tax advice."
        >
          <Input
            type="number"
            min={0}
            max={100}
            value={taxRatePct}
            onChange={(e) => setTaxRatePct(e.target.value)}
          />
        </FormField>
        <FormField label="Timezone" htmlFor="settings-timezone">
          <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="flex justify-end">
          <Button type="submit" busy={update.isPending}>
            Save changes
          </Button>
        </div>
      </form>
    </Card>
  );
}

const integrationStatusBadge = {
  connected: { tone: 'positive' as const, label: 'Connected' },
  mock: { tone: 'neutral' as const, label: 'Mock' },
  disconnected: { tone: 'neutral' as const, label: 'Disconnected' },
};

/** Only Plaid is implemented today (Stripe/Docusign/Email are deferred —
 * docs/WHATS_NEXT.md §3), so we surface just the one connectable type.
 * Rendered even when the account has no matching DB row yet (a fresh
 * production account starts with zero). */
const KNOWN_INTEGRATIONS: { type: IntegrationType; name: string }[] = [
  { type: 'plaid', name: 'Plaid (bank import)' },
];

type IntegrationRowInput = Integration | { type: IntegrationType; name: string };

function isConnectedIntegration(row: IntegrationRowInput): row is Integration {
  return 'id' in row && row.status !== 'disconnected';
}

// The mock adapter asserts this exact literal (integrations/mock/mock-plaid.ts)
// so a real Plaid public token can never accidentally route through it.
const MOCK_PUBLIC_TOKEN = 'mock-public-token';

/** Plaid gets a real Link flow instead of a generic one-click mock connect:
 * in mock mode (no real Plaid keys configured server-side) it still behaves
 * like the other rows (immediate connect, no modal); once real keys are
 * configured, Connect launches Plaid's hosted Sandbox/Production Link modal. */
function PlaidIntegrationRow({ row }: { row: IntegrationRowInput }) {
  const { toast } = useToast();
  const createLinkToken = useCreatePlaidLinkToken();
  const exchange = useExchangePlaidPublicToken();
  const disconnect = useDisconnectIntegration();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const badge = integrationStatusBadge['id' in row ? row.status : 'disconnected'];

  const finishConnecting = (publicToken: string) => {
    exchange.mutate(publicToken, {
      onSuccess: () => toast('Plaid connected.', 'positive'),
      onError: () => toast('Could not finish connecting Plaid. Try again.', 'danger'),
    });
  };

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (publicToken) => finishConnecting(publicToken),
  });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  const handleConnect = () => {
    createLinkToken.mutate(undefined, {
      onSuccess: ({ linkToken: token, mock }) => {
        if (mock) {
          finishConnecting(MOCK_PUBLIC_TOKEN);
        } else {
          setLinkToken(token);
        }
      },
      onError: () => toast('Could not start the bank connection. Try again.', 'danger'),
    });
  };

  return (
    <li className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div>
        <p className="text-sm font-medium text-ink">{row.name}</p>
        <div className="mt-1">
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        </div>
        {'id' in row && row.lastSyncedAt && (
          <p className="mt-1 text-xs text-ink-muted">
            Last imported {formatDateTime(row.lastSyncedAt)}
          </p>
        )}
      </div>
      {isConnectedIntegration(row) ? (
        <Button
          variant="secondary"
          size="sm"
          busy={disconnect.isPending}
          onClick={() =>
            disconnect.mutate(row.id, {
              onSuccess: () => toast(`${row.name} disconnected.`, 'neutral'),
              onError: () => toast('Could not disconnect. Try again.', 'danger'),
            })
          }
        >
          Disconnect
        </Button>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          busy={createLinkToken.isPending || exchange.isPending}
          onClick={handleConnect}
        >
          Connect
        </Button>
      )}
    </li>
  );
}
