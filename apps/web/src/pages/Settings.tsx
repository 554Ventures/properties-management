// Settings (PRD §5.9): account profile + tax rate, integrations (Plaid and
// Stripe Financial Connections are real bank-feed flows; Stripe rent
// payments/Docusign/Email stay mock — docs/WHATS_NEXT.md §3). MCP is
// stdio/local-only (no remote transport exists yet —
// property-app-deployment-plan.md §8), so it has no UI here.
import { useEffect, useState, type FormEvent } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type {
  AccountMember,
  AccountSettings,
  GraceDaysBasis,
  Integration,
  IntegrationType,
  MemberPermission,
  NotificationChannel,
  NotificationPrefs,
} from '@hearth/shared';
import { MemberPermissionSchema } from '@hearth/shared';
import {
  useCreatePlaidLinkToken,
  useCurrentUser,
  useDisconnectIntegration,
  useExchangePlaidPublicToken,
  useIntegrations,
  useInviteMember,
  useNotificationPrefs,
  usePushDevices,
  useRemoveMember,
  useRevokeInvite,
  useSettings,
  useTeam,
  useUpdateMember,
  useUpdateNotificationPrefs,
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
import { IconAlertCircle, IconAlertTriangle } from '../components/ui/icons';
import { formatDateTime } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';
import { useStripeFcConnect } from '../lib/useStripeFcConnect';
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
        <div className="flex flex-col gap-6">
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

          <NotificationsSection />
        </div>

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
                <>
                  <ul className="divide-y divide-border">
                    {visibleIntegrations(integrations.data).map((known) => {
                      const row = integrations.data.find((i) => i.type === known.type) ?? known;
                      return known.type === 'stripe_fc' ? (
                        <StripeFcIntegrationRow key={known.type} row={row} />
                      ) : (
                        <PlaidIntegrationRow key={known.type} row={row} />
                      );
                    })}
                  </ul>
                  {integrations.data.filter(
                    (i) => (i.type === 'plaid' || i.type === 'stripe_fc') && i.status === 'connected',
                  ).length > 1 && (
                    <p className="mt-3 text-xs text-warning">
                      Both bank feeds are connected. If they cover the same bank account, the same
                      transaction can import twice (each feed uses its own ids) — the review queue
                      flags likely duplicates, but connecting one feed per account is safer.
                    </p>
                  )}
                </>
              )}
            </Card>
          </section>

          <TeamSection />

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

const NOTIFICATION_CATEGORIES: {
  key: keyof NotificationPrefs;
  label: string;
  hint: string;
}[] = [
  {
    key: 'warning_insights',
    label: 'Warnings',
    hint: 'Late rent and other things that need your attention.',
  },
  {
    key: 'weekly_brief',
    label: 'Weekly brief',
    hint: 'The AI weekly digest: what changed and what to look at.',
  },
  {
    key: 'monthly_review',
    label: 'Monthly review',
    hint: 'When your monthly review report is ready.',
  },
];

const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannel, string> = {
  push: 'Push',
  email: 'Email',
};

/** Per-user notification delivery preferences (F2). Deliberately visible to
 *  every member, with no permission gating: the endpoints are self-service —
 *  the server scopes reads/writes to the signed-in user's own row (demo mode
 *  uses the account-level row), so there is nothing cross-member to protect. */
function NotificationsSection() {
  const prefs = useNotificationPrefs();

  return (
    <section aria-label="Notifications">
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-ink">Notifications</h2>
        {prefs.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : prefs.isError ? (
          <ErrorNotice error={prefs.error} onRetry={() => void prefs.refetch()} />
        ) : (
          <NotificationPrefsForm prefs={prefs.data} />
        )}
      </Card>
    </section>
  );
}

/** Channel toggles per category; every change saves immediately (full-object
 *  PUT — the shared contract is a full replace, not a patch). */
function NotificationPrefsForm({ prefs }: { prefs: NotificationPrefs }) {
  const update = useUpdateNotificationPrefs();
  const { toast } = useToast();

  const toggle = (
    category: keyof NotificationPrefs,
    channel: NotificationChannel,
    enabled: boolean,
  ) => {
    update.mutate(
      { ...prefs, [category]: { ...prefs[category], [channel]: enabled } },
      {
        onSuccess: () => toast('Notification preferences saved.', 'positive'),
        onError: (err) =>
          toast(
            err instanceof Error
              ? err.message
              : 'Could not save notification preferences. Try again.',
            'danger',
          ),
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {NOTIFICATION_CATEGORIES.map(({ key, label, hint }) => (
        <fieldset key={key}>
          <legend className="text-sm font-medium text-ink">{label}</legend>
          <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
            {(Object.keys(NOTIFICATION_CHANNEL_LABELS) as NotificationChannel[]).map((channel) => (
              <label key={channel} className="flex items-center gap-1.5 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={prefs[key][channel]}
                  disabled={update.isPending}
                  onChange={(e) => toggle(key, channel, e.target.checked)}
                />
                {NOTIFICATION_CHANNEL_LABELS[channel]}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <p className="text-xs text-ink-muted">
        Email notifications go to your sign-in email address.
      </p>
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

const PERMISSION_LABELS: Record<MemberPermission, string> = {
  properties: 'Properties & units',
  tenants: 'Tenants & leases',
  money: 'Money & transactions',
  rent: 'Rent & reminders',
  reports: 'Reports',
  ai: 'AI assistant actions',
};

const ALL_PERMISSIONS = MemberPermissionSchema.options;

/** Team / multi-user account management (docs/WHATS_NEXT.md §4). Owner-only
 *  controls; members see their own access; demo mode shows a sign-in note. */
function TeamSection() {
  const { enabled } = useAuth();
  const me = useCurrentUser();
  const team = useTeam();

  // Demo mode has no login / User rows — team management isn't meaningful.
  if (!enabled) {
    return (
      <section aria-label="Team">
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-ink">Team</h2>
          <p className="text-sm text-ink-muted">
            Sign in to invite teammates and manage what they can do.
          </p>
        </Card>
      </section>
    );
  }

  return (
    <section aria-label="Team">
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-ink">Team</h2>
        {me.isPending || team.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : me.isError ? (
          <ErrorNotice error={me.error} onRetry={() => void me.refetch()} />
        ) : me.data.role !== 'owner' ? (
          <MemberTeamView permissions={me.data.permissions} />
        ) : team.isError ? (
          <ErrorNotice error={team.error} onRetry={() => void team.refetch()} />
        ) : (
          <OwnerTeamView
            members={team.data.members}
            pendingInvites={team.data.pendingInvites}
            seatsUsed={team.data.seatsUsed}
            seatLimit={team.data.seatLimit}
          />
        )}
      </Card>
    </section>
  );
}

/** What a non-owner member sees: their own granted access, read-only. */
function MemberTeamView({ permissions }: { permissions: MemberPermission[] }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">
        You&rsquo;re a member of this account. The owner controls what you can do.
      </p>
      <div>
        <p className="mb-1 text-sm font-medium text-ink">Your access</p>
        {permissions.length === 0 ? (
          <p className="text-sm text-ink-muted">View-only — no edit permissions granted yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {permissions.map((p) => (
              <li key={p}>
                <StatusBadge tone="positive">{PERMISSION_LABELS[p]}</StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function OwnerTeamView({
  members,
  pendingInvites,
  seatsUsed,
  seatLimit,
}: {
  members: AccountMember[];
  pendingInvites: { id: string; email: string; permissions: MemberPermission[] }[];
  seatsUsed: number;
  seatLimit: number;
}) {
  const removeMember = useRemoveMember();
  const revokeInvite = useRevokeInvite();
  const { toast } = useToast();
  const seatsFull = seatsUsed >= seatLimit;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-muted">
        {seatsUsed} of {seatLimit} seats used.
      </p>

      <ul className="flex flex-col divide-y divide-border">
        {members.map((m) => (
          <MemberRow key={m.userId} member={m} onRemove={() => removeMember.mutate(m.userId)} />
        ))}
        {pendingInvites.map((inv) => (
          <li key={inv.id} className="flex flex-col gap-1 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-ink">{inv.email}</span>
              <div className="flex items-center gap-2">
                <StatusBadge tone="warning" icon="clock">
                  Invite pending
                </StatusBadge>
                <Button
                  variant="ghost"
                  size="sm"
                  busy={revokeInvite.isPending}
                  onClick={() => revokeInvite.mutate(inv.id)}
                >
                  Revoke
                </Button>
              </div>
            </div>
            {inv.permissions.length > 0 && (
              <p className="text-xs text-ink-muted">
                Will get: {inv.permissions.map((p) => PERMISSION_LABELS[p]).join(', ')}
              </p>
            )}
          </li>
        ))}
      </ul>

      {seatsFull ? (
        <div className="rounded-md bg-neutral-soft p-3">
          <p className="text-sm font-medium text-ink">You&rsquo;ve used all your seats.</p>
          <p className="mt-0.5 text-sm text-ink-muted">
            Upgrade your plan to add more teammates.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => toast('Seat upgrades are coming soon — contact us to add more.', 'neutral')}
          >
            Upgrade for more seats
          </Button>
        </div>
      ) : (
        <InviteForm />
      )}
    </div>
  );
}

/** One active member with editable permission toggles (owner shows full access). */
function MemberRow({ member, onRemove }: { member: AccountMember; onRemove: () => void }) {
  const updateMember = useUpdateMember();
  const isOwner = member.role === 'owner';

  const toggle = (permission: MemberPermission, checked: boolean) => {
    const next = checked
      ? [...member.permissions, permission]
      : member.permissions.filter((p) => p !== permission);
    updateMember.mutate({ userId: member.userId, input: { permissions: next } });
  };

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink">{member.email}</span>
        {isOwner ? (
          <StatusBadge tone="ai">Owner</StatusBadge>
        ) : (
          <Button variant="ghost" size="sm" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
      {isOwner ? (
        <p className="text-xs text-ink-muted">Full access to everything.</p>
      ) : (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5">
          <legend className="sr-only">Permissions for {member.email}</legend>
          {ALL_PERMISSIONS.map((p) => (
            <label key={p} className="flex items-center gap-1.5 text-sm text-ink">
              <input
                type="checkbox"
                checked={member.permissions.includes(p)}
                disabled={updateMember.isPending}
                onChange={(e) => toggle(p, e.target.checked)}
              />
              {PERMISSION_LABELS[p]}
            </label>
          ))}
        </fieldset>
      )}
    </li>
  );
}

/** Invite a teammate by email with an initial set of permissions. */
function InviteForm() {
  const invite = useInviteMember();
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [permissions, setPermissions] = useState<MemberPermission[]>([]);

  const toggle = (permission: MemberPermission, checked: boolean) => {
    setPermissions((prev) =>
      checked ? [...prev, permission] : prev.filter((p) => p !== permission),
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    invite.mutate(
      { email: email.trim(), permissions },
      {
        onSuccess: () => {
          toast('Invite sent — they join when they sign in with this email.', 'positive');
          setEmail('');
          setPermissions([]);
        },
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not send the invite.', 'danger'),
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border-t border-border pt-4">
      <p className="text-sm font-medium text-ink">Invite a teammate</p>
      <FormField label="Email" htmlFor="invite-email" required>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
          placeholder="teammate@example.com"
        />
      </FormField>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5">
        <legend className="mb-1 text-sm font-medium text-ink">Permissions</legend>
        {ALL_PERMISSIONS.map((p) => (
          <label key={p} className="flex items-center gap-1.5 text-sm text-ink">
            <input
              type="checkbox"
              checked={permissions.includes(p)}
              onChange={(e) => toggle(p, e.target.checked)}
            />
            {PERMISSION_LABELS[p]}
          </label>
        ))}
      </fieldset>
      <div className="flex justify-end">
        <Button type="submit" size="sm" busy={invite.isPending} disabled={!email.trim()}>
          Send invite
        </Button>
      </div>
    </form>
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

/** PATCH /settings/account is requireOwner()-gated server-side (it steers
 *  account-wide money math: timezone, taxRatePct, defaultLateFeeCents) — a
 *  non-owner member would only 403 on save. Mirrors TeamSection's
 *  enabled + role check: demo mode (no login) has a single operator who is
 *  always the owner, so the form stays fully editable there. */
function AccountForm({ account }: { account: AccountSettings }) {
  const update = useUpdateSettings();
  const { toast } = useToast();
  const { enabled } = useAuth();
  const me = useCurrentUser();
  const [name, setName] = useState(account.name);
  const [email, setEmail] = useState(account.email);
  const [taxRatePct, setTaxRatePct] = useState(String(account.taxRatePct));
  const [timezone, setTimezone] = useState(account.timezone);
  // Dollar string; $0 disables late fees account-wide (WS7). A lease's own
  // override (set on the lease form) takes precedence over this default.
  const [defaultLateFee, setDefaultLateFee] = useState(
    (account.defaultLateFeeCents / 100).toString(),
  );
  // Grace period: how many days after the due date rent goes from due to
  // late, and whether those days are calendar or business days.
  const [graceDays, setGraceDays] = useState(String(account.graceDays));
  const [graceDaysBasis, setGraceDaysBasis] = useState<GraceDaysBasis>(account.graceDaysBasis);

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
        defaultLateFeeCents: Math.max(0, Math.round(Number(defaultLateFee) * 100) || 0),
        graceDays: Math.max(0, Math.round(Number(graceDays) || 0)),
        graceDaysBasis,
      },
      {
        onSuccess: () => toast('Settings saved.', 'positive'),
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not save settings. Try again.', 'danger'),
      },
    );
  };

  // While the role is unresolved (auth mode only), default to read-only
  // rather than briefly flashing an editable form that would 403 on save.
  if (enabled && me.isPending) {
    return (
      <Card>
        <Skeleton className="h-64 w-full" />
      </Card>
    );
  }
  const readOnly = enabled && me.data?.role !== 'owner';

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-ink">Account</h2>
      {readOnly && (
        <p className="mb-3 flex items-start gap-1.5 text-xs text-ink-muted">
          <IconAlertCircle size={12} className="mt-0.5 shrink-0" />
          Only the account owner can change these settings.
        </p>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="Name" htmlFor="settings-name" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            disabled={readOnly}
          />
        </FormField>
        <FormField label="Email" htmlFor="settings-email" required>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            disabled={readOnly}
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
            disabled={readOnly}
          />
        </FormField>
        <FormField
          label="Grace period (days)"
          htmlFor="settings-grace-days"
          hint="Rent isn't marked late until this many days after the due date. Late fees can only be applied once a charge is past grace."
        >
          <Input
            type="number"
            inputMode="numeric"
            min="0"
            step="1"
            value={graceDays}
            onChange={(e) => setGraceDays(e.target.value)}
            disabled={readOnly}
          />
        </FormField>
        <FormField label="Grace period basis" htmlFor="settings-grace-days-basis">
          <Select
            value={graceDaysBasis}
            onChange={(e) => setGraceDaysBasis(e.target.value as GraceDaysBasis)}
            disabled={readOnly}
          >
            <option value="calendar">Calendar days</option>
            <option value="business">Business days (Mon–Fri)</option>
          </Select>
        </FormField>
        <FormField
          label="Default late fee (USD)"
          htmlFor="settings-late-fee"
          hint="Applied when a lease doesn't set its own late fee. $0 disables late fees for those leases — applying one is always a manual action on the Rent Collection page, never automatic."
        >
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={defaultLateFee}
            onChange={(e) => setDefaultLateFee(e.target.value)}
            disabled={readOnly}
          />
        </FormField>
        <FormField label="Timezone" htmlFor="settings-timezone">
          <Select value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={readOnly}>
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </FormField>
        {!readOnly && (
          <div className="flex justify-end">
            <Button type="submit" busy={update.isPending}>
              Save changes
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

const integrationStatusBadge = {
  connected: { tone: 'positive' as const, label: 'Connected' },
  mock: { tone: 'neutral' as const, label: 'Mock' },
  disconnected: { tone: 'neutral' as const, label: 'Disconnected' },
};

/** Plaid and Stripe Financial Connections are the two implemented bank feeds
 * (Stripe rent payments/Docusign/Email are deferred — docs/WHATS_NEXT.md §3).
 * Rendered even when the account has no matching DB row yet (a fresh
 * production account starts with zero). */
const KNOWN_INTEGRATIONS: { type: IntegrationType; name: string }[] = [
  { type: 'plaid', name: 'Plaid (bank import)' },
  { type: 'stripe_fc', name: 'Stripe Financial Connections (bank import)' },
];

/** Plaid is hidden (not removed) while Stripe Financial Connections is the
 * preferred bank feed — set VITE_SHOW_PLAID=true to resurface the row. The
 * whole Plaid stack (API routes, adapter, sync) stays live either way, and an
 * account that already has a non-disconnected Plaid row always sees it so
 * imports stay explainable and Disconnect stays reachable. The env read lives
 * inside the function (not a module constant) so tests can vi.stubEnv it. */
function visibleIntegrations(rows: Integration[]): typeof KNOWN_INTEGRATIONS {
  const showPlaid = import.meta.env.VITE_SHOW_PLAID === 'true';
  return KNOWN_INTEGRATIONS.filter((known) => {
    if (known.type !== 'plaid' || showPlaid) return true;
    const plaidRow = rows.find((i) => i.type === 'plaid');
    return plaidRow !== undefined && plaidRow.status !== 'disconnected';
  });
}

type IntegrationRowInput = Integration | { type: IntegrationType; name: string };

function isConnectedIntegration(row: IntegrationRowInput): row is Integration {
  return 'id' in row && row.status !== 'disconnected';
}

/** Shown under a bank feed row once its nightly sync starts failing
 * (WS5 — jobs.service stamps lastSyncError/At and bumps syncFailureCount;
 * three failures also raise a bank_sync_failing insight). Icon + text, not
 * color alone, matching the row's existing secondary-text convention. */
function LastSyncErrorNote({ row }: { row: IntegrationRowInput }) {
  if (!('id' in row) || !row.lastSyncErrorAt) return null;
  return (
    <p className="mt-1 flex items-start gap-1 text-xs text-warning">
      <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
      Last sync failed {formatDateTime(row.lastSyncErrorAt)}
      {row.lastSyncError ? `: ${row.lastSyncError}` : ''}
    </p>
  );
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
        <LastSyncErrorNote row={row} />
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

/** Stripe Financial Connections mirrors the Plaid row. The connect flow
 * (mock = immediate, real keys = Stripe.js hosted bank-auth modal) lives in
 * the shared `useStripeFcConnect` hook, reused by the onboarding wizard. */
function StripeFcIntegrationRow({ row }: { row: IntegrationRowInput }) {
  const { toast } = useToast();
  const { connect, busy } = useStripeFcConnect();
  const disconnect = useDisconnectIntegration();
  const badge = integrationStatusBadge['id' in row ? row.status : 'disconnected'];

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
        <LastSyncErrorNote row={row} />
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
        <Button variant="secondary" size="sm" busy={busy} onClick={connect}>
          Connect
        </Button>
      )}
    </li>
  );
}
