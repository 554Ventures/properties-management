// Tenants & Leases list (PRD §5.3): portfolio renewal insight, per-tenant
// status (Current / Renew soon / N days late), and Remind for late tenants.
import { useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type { TenantListRow } from '@hearth/shared';
import { Link } from 'react-router-dom';
import { useInsights, useRentTracker, useSendReminders, useTenants } from '../api/queries';
import { TenantFormModal } from '../components/forms/TenantFormModal';
import { InsightCard } from '../components/ai/InsightCard';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { LiveRegion } from '../components/ui/LiveRegion';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Table, Td, Th, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { IconBell, IconPlus, IconUsers } from '../components/ui/icons';
import { currentPeriod, formatDate } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';

export function TenantsList() {
  usePageTitle('Tenants & Leases');
  const tenants = useTenants();
  const [createOpen, setCreateOpen] = useState(false);
  const insights = useInsights({ scope: 'portfolio', status: 'active' });
  // Rent tracker for the current period maps late tenants → rentPaymentIds so
  // "Remind" can send from this screen (contract has no per-tenant reminder).
  const tracker = useRentTracker(currentPeriod());
  const remind = useSendReminders();
  const { toast } = useToast();

  const renewalInsight = insights.data?.find((i) => i.type === 'renewal_window');
  const lateByTenant = new Map(
    (tracker.data?.rows ?? [])
      .filter((row) => row.status === 'late')
      .map((row) => [row.tenantId, row]),
  );

  const sendReminder = (row: TenantListRow) => {
    const trackerRow = lateByTenant.get(row.id);
    if (!trackerRow) return;
    remind.mutate(
      { rentPaymentIds: [trackerRow.rentPaymentId] },
      {
        onSuccess: (res) => {
          const sent = res.results.filter((r) => r.status === 'sent').length;
          toast(
            sent > 0
              ? `Reminder sent to ${row.fullName}.`
              : `Reminder skipped — ${res.results[0]?.reason ?? 'already reminded recently'}.`,
            sent > 0 ? 'positive' : 'neutral',
          );
        },
        onError: () => toast('Could not send the reminder. Try again.', 'danger'),
      },
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Tenants & Leases"
        breadcrumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Tenants & Leases' }]}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <IconPlus size={16} />
            Add tenant
          </Button>
        }
      />

      <LiveRegion>{renewalInsight && <InsightCard insight={renewalInsight} />}</LiveRegion>

      {tenants.isPending ? (
        <Card flush className="p-4">
          <Skeleton className="h-64 w-full" />
        </Card>
      ) : tenants.isError ? (
        <ErrorNotice error={tenants.error} onRetry={() => void tenants.refetch()} />
      ) : tenants.data.length === 0 ? (
        <Card flush>
          <EmptyState
            icon={<IconUsers size={28} />}
            title="No tenants yet"
            body="Add a tenant, then create a lease from a vacant unit on a property."
            action={
              <Button onClick={() => setCreateOpen(true)}>
                <IconPlus size={16} />
                Add tenant
              </Button>
            }
          />
        </Card>
      ) : (
        <Card flush>
          <Table caption="Tenants — unit, rent, lease end date, and status">
            <thead>
              <tr>
                <Th>Tenant</Th>
                <Th>Unit / property</Th>
                <Th align="right">Rent / mo</Th>
                <Th>Lease ends</Th>
                <Th>Status</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {tenants.data.map((row) => {
                const late = lateByTenant.get(row.id);
                return (
                  <Tr key={row.id} hover>
                    <Td>
                      <Link
                        to={`/tenants/${row.id}`}
                        className="font-medium text-ink transition-colors duration-fast hover:text-brand"
                      >
                        {row.fullName}
                      </Link>
                    </Td>
                    <Td>
                      {row.unitLabel ? (
                        <>
                          {row.unitLabel}
                          <span className="text-ink-muted"> · {row.propertyLabel}</span>
                        </>
                      ) : (
                        <span className="text-ink-muted">No active lease</span>
                      )}
                    </Td>
                    <Td align="right">{row.rentCents != null ? formatUsd(row.rentCents) : '—'}</Td>
                    <Td>{row.leaseEndDate ? formatDate(row.leaseEndDate) : '—'}</Td>
                    <Td>
                      {row.status === 'late' ? (
                        <StatusBadge tone="danger">
                          {late?.daysLate != null
                            ? `${late.daysLate} ${late.daysLate === 1 ? 'day' : 'days'} late`
                            : 'Late'}
                        </StatusBadge>
                      ) : row.status === 'renew_soon' ? (
                        <StatusBadge tone="warning">Renew soon</StatusBadge>
                      ) : (
                        <StatusBadge tone="positive">Current</StatusBadge>
                      )}
                    </Td>
                    <Td>
                      {row.status === 'late' && late && (
                        <Button
                          variant="secondary"
                          size="sm"
                          busy={remind.isPending}
                          onClick={() => sendReminder(row)}
                        >
                          <IconBell size={12} />
                          Remind
                        </Button>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}

      <TenantFormModal mode="create" open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
