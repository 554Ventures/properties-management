// Settings (PRD §5.9): account profile + tax rate, integrations (Plaid is a
// real Sandbox/Production Link flow; Stripe/Docusign/Email stay mock —
// docs/WHATS_NEXT.md §3), and plain copy about MCP access.
import { useEffect, useState, type FormEvent } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import type { AccountSettings, Integration, IntegrationType } from '@hearth/shared';
import {
  useConnectIntegration,
  useCreatePlaidLinkToken,
  useDisconnectIntegration,
  useExchangePlaidPublicToken,
  useIntegrations,
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
import { usePageTitle } from '../lib/usePageTitle';
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
          <section aria-label="Integrations">
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
                    return known.type === 'plaid' ? (
                      <PlaidIntegrationRow key={known.type} row={row} />
                    ) : (
                      <IntegrationRow key={known.type} row={row} />
                    );
                  })}
                </ul>
              )}
            </Card>
          </section>

          <section aria-label="External AI access">
            <Card>
              <h2 className="mb-2 text-sm font-semibold text-ink">
                External AI access (MCP)
              </h2>
              <p className="text-sm leading-relaxed text-ink-muted">
                554 Properties exposes your portfolio to AI tools you run yourself — Claude Desktop, Claude
                Code, or any MCP-aware client — through a built-in Model Context Protocol server.
                Access is <strong className="font-medium text-ink">read-only by default</strong>:
                external tools can view your portfolio summary, properties, rent status,
                transactions, and reports. Write actions (sending reminders, categorizing
                transactions, generating reports) are only available when the server is started
                with{' '}
                <code className="rounded bg-surface-sunken px-1.5 py-0.5 text-xs">
                  HEARTH_MCP_ENABLE_WRITE=true
                </code>
                , and every write is recorded in the audit log.
              </p>
            </Card>
          </section>

          <SessionSection />
        </div>
      </div>
    </div>
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

/** All 4 connectable types, rendered even when the account has no matching
 * DB row yet (a fresh production account starts with zero — the "No
 * integrations configured" dead end this list replaces). */
const KNOWN_INTEGRATIONS: { type: IntegrationType; name: string }[] = [
  { type: 'plaid', name: 'Plaid (bank import)' },
  { type: 'stripe', name: 'Stripe (rent payments)' },
  { type: 'docusign', name: 'Docusign (e-sign)' },
  { type: 'email', name: 'Email (reminders & reports)' },
];

type IntegrationRowInput = Integration | { type: IntegrationType; name: string };

function isConnectedIntegration(row: IntegrationRowInput): row is Integration {
  return 'id' in row && row.status !== 'disconnected';
}

// The mock adapter asserts this exact literal (integrations/mock/mock-plaid.ts)
// so a real Plaid public token can never accidentally route through it.
const MOCK_PUBLIC_TOKEN = 'mock-public-token';

function IntegrationRow({ row }: { row: IntegrationRowInput }) {
  const connect = useConnectIntegration();
  const disconnect = useDisconnectIntegration();
  const { toast } = useToast();
  const badge = integrationStatusBadge['id' in row ? row.status : 'disconnected'];

  return (
    <li className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div>
        <p className="text-sm font-medium text-ink">{row.name}</p>
        <div className="mt-1">
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        </div>
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
          busy={connect.isPending}
          onClick={() =>
            connect.mutate(row.type, {
              onSuccess: () => toast(`${row.name} connected.`, 'positive'),
              onError: () => toast('Could not connect. Try again.', 'danger'),
            })
          }
        >
          Connect
        </Button>
      )}
    </li>
  );
}

/** Plaid gets a real Link flow instead of the generic one-click mock connect:
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
