// Settings (PRD §5.9): account profile + tax rate, integrations with mock
// connect/disconnect, and plain copy about MCP access.
import { useState, type FormEvent } from 'react';
import type { AccountSettings, Integration } from '@hearth/shared';
import {
  useConnectIntegration,
  useDisconnectIntegration,
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
              ) : integrations.data.length === 0 ? (
                <p className="text-sm text-ink-muted">No integrations configured.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {integrations.data.map((integration) => (
                    <IntegrationRow key={integration.id} integration={integration} />
                  ))}
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
                Hearth exposes your portfolio to AI tools you run yourself — Claude Desktop, Claude
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

function IntegrationRow({ integration }: { integration: Integration }) {
  const connect = useConnectIntegration();
  const disconnect = useDisconnectIntegration();
  const { toast } = useToast();
  const badge = integrationStatusBadge[integration.status];
  const isConnected = integration.status !== 'disconnected';

  return (
    <li className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div>
        <p className="text-sm font-medium text-ink">{integration.name}</p>
        <div className="mt-1">
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        </div>
      </div>
      {isConnected ? (
        <Button
          variant="secondary"
          size="sm"
          busy={disconnect.isPending}
          onClick={() =>
            disconnect.mutate(integration.id, {
              onSuccess: () => toast(`${integration.name} disconnected.`, 'neutral'),
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
            connect.mutate(integration.type, {
              onSuccess: () => toast(`${integration.name} connected.`, 'positive'),
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
