// Tenant detail (PRD §5.3): contact card, lease terms, payment history, and
// the "Draft renewal" flow (proposal modal + mock e-sign send).
import { useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type { RenewalDraftResponse, TenantLease } from '@hearth/shared';
import { useParams } from 'react-router-dom';
import {
  useArchiveTenant,
  useDraftRenewal,
  useRestoreTenant,
  useTenantDetail,
  useTerminateLease,
} from '../api/queries';
import { DocumentsCard } from '../components/documents/DocumentsCard';
import { LeaseFormModal } from '../components/forms/LeaseFormModal';
import { LeaseTenantsModal } from '../components/forms/LeaseTenantsModal';
import { RenewalModal } from '../components/forms/RenewalModal';
import { TenantFormModal } from '../components/forms/TenantFormModal';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Table, Td, Th, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { formatDate, formatMonth } from '../lib/format';
import { leaseStatusBadge, rentStatusBadge } from '../lib/statusBadges';
import { usePageTitle } from '../lib/usePageTitle';

export function TenantDetail() {
  const { id } = useParams<{ id: string }>();
  const detail = useTenantDetail(id);
  const title = detail.data?.tenant.fullName ?? 'Tenant';
  usePageTitle(title);

  const [draft, setDraft] = useState<RenewalDraftResponse | null>(null);
  const [editTenant, setEditTenant] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [editingLease, setEditingLease] = useState<TenantLease | null>(null);
  const [coTenantsLeaseId, setCoTenantsLeaseId] = useState<string | null>(null);
  const [terminating, setTerminating] = useState<TenantLease | null>(null);
  const draftRenewal = useDraftRenewal();
  const archiveTenant = useArchiveTenant();
  const restoreTenant = useRestoreTenant();
  const terminateLease = useTerminateLease();
  const { toast } = useToast();

  if (detail.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Tenant"
          breadcrumbs={[{ label: 'Properties', to: '/properties' }, { label: 'Tenant' }]}
        />
        <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { tenant, leases, paymentHistory, documents } = detail.data;

  // With the standalone tenants list gone, the breadcrumb anchors to the
  // tenant's property (active lease first, else the most recent one).
  const breadcrumbLease = leases.find((lease) => lease.status === 'active') ?? leases[0];

  const startDraft = (lease: TenantLease) => {
    draftRenewal.mutate(lease.id, {
      onSuccess: (proposal) => setDraft(proposal),
      onError: () => toast('Could not draft a renewal. Try again.', 'danger'),
    });
  };

  const doArchiveTenant = () => {
    archiveTenant.mutate(tenant.id, {
      onSuccess: () => {
        toast(`${tenant.fullName} archived.`, 'positive');
        setConfirmArchive(false);
      },
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not archive the tenant.', 'danger'),
    });
  };

  const doRestoreTenant = () => {
    restoreTenant.mutate(tenant.id, {
      onSuccess: () => toast(`${tenant.fullName} restored.`, 'positive'),
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not restore the tenant.', 'danger'),
    });
  };

  const doTerminate = () => {
    if (!terminating) return;
    terminateLease.mutate(terminating.id, {
      onSuccess: () => {
        toast('Lease terminated.', 'positive');
        setTerminating(null);
      },
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not terminate the lease.', 'danger'),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={tenant.fullName}
        breadcrumbs={
          breadcrumbLease
            ? [
                { label: 'Properties', to: '/properties' },
                {
                  label: breadcrumbLease.propertyLabel,
                  to: `/properties/${breadcrumbLease.propertyId}`,
                },
                { label: tenant.fullName },
              ]
            : [{ label: 'Properties', to: '/properties' }, { label: tenant.fullName }]
        }
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditTenant(true)}>
              Edit tenant
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(true)}>
              Archive tenant
            </Button>
          </div>
        }
      />

      {tenant.archivedAt && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-warning-soft px-4 py-3 text-sm text-ink"
        >
          <span>This tenant is archived and hidden from your lists.</span>
          <Button variant="secondary" size="sm" busy={restoreTenant.isPending} onClick={doRestoreTenant}>
            Restore tenant
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">Contact</h2>
          <dl className="flex flex-col gap-2 text-sm">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">Email</dt>
              <dd>
                {tenant.email ? (
                  <a href={`mailto:${tenant.email}`} className="text-ink hover:text-brand">
                    {tenant.email}
                  </a>
                ) : (
                  <span className="text-ink-muted">Not on file</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">Phone</dt>
              <dd>
                {tenant.phone ? (
                  <a href={`tel:${tenant.phone}`} className="text-ink hover:text-brand">
                    {tenant.phone}
                  </a>
                ) : (
                  <span className="text-ink-muted">Not on file</span>
                )}
              </dd>
            </div>
            {tenant.notes && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">Notes</dt>
                <dd className="text-ink-muted">{tenant.notes}</dd>
              </div>
            )}
          </dl>
        </Card>

        <div className="flex flex-col gap-4 lg:col-span-2">
          {leases.length === 0 ? (
            <Card>
              <p className="text-sm text-ink-muted">No leases on file for this tenant.</p>
            </Card>
          ) : (
            leases.map((lease) => {
              const badge = leaseStatusBadge[lease.status] ?? leaseStatusBadge.ended;
              return (
                <Card key={lease.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold text-ink">
                        {lease.unitLabel} · {lease.propertyLabel}
                      </h2>
                      <p className="mt-1 text-sm text-ink-muted">
                        {formatUsd(lease.rentCents)}/mo · due day {lease.dueDay} ·{' '}
                        {formatDate(lease.startDate)} – {formatDate(lease.endDate)}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {badge && <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}
                        {lease.esignStatus && (
                          <StatusBadge tone={lease.esignStatus === 'signed' ? 'positive' : 'neutral'}>
                            E-sign: {lease.esignStatus}
                          </StatusBadge>
                        )}
                      </div>
                    </div>
                    {lease.status === 'active' && (
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button
                          variant="secondary"
                          size="sm"
                          busy={draftRenewal.isPending}
                          onClick={() => startDraft(lease)}
                        >
                          Draft renewal
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditingLease(lease)}>
                          Edit terms
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setCoTenantsLeaseId(lease.id)}
                        >
                          Co-tenants
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setTerminating(lease)}>
                          Terminate
                        </Button>
                      </div>
                    )}
                  </div>
                </Card>
              );
            })
          )}

          <DocumentsCard
            filter={{ tenantId: tenant.id }}
            uploadTarget={{ entityType: 'tenant', entityId: tenant.id }}
            prependedDocs={documents}
          />
        </div>
      </div>

      <section aria-label="Payment history" className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-ink">Payment history</h2>
        <Card flush>
          {paymentHistory.length === 0 ? (
            <p className="p-5 text-sm text-ink-muted">No rent payments recorded yet.</p>
          ) : (
            <Table caption={`${tenant.fullName} — rent payment history`}>
              <thead>
                <tr>
                  <Th>Period</Th>
                  <Th>Due date</Th>
                  <Th align="right">Amount</Th>
                  <Th>Status</Th>
                  <Th>Method</Th>
                  <Th>Paid</Th>
                </tr>
              </thead>
              <tbody>
                {paymentHistory.map((row) => {
                  const badge = rentStatusBadge[row.status] ?? rentStatusBadge.due;
                  return (
                    <Tr key={row.id}>
                      <Td>{formatMonth(row.period)}</Td>
                      <Td>{formatDate(row.dueDate)}</Td>
                      <Td align="right">{formatUsd(row.amountCents)}</Td>
                      <Td>
                        {badge && (
                          <StatusBadge tone={badge.tone}>
                            {row.status === 'late' && row.daysLate != null
                              ? `${row.daysLate} ${row.daysLate === 1 ? 'day' : 'days'} late`
                              : badge.label}
                          </StatusBadge>
                        )}
                      </Td>
                      <Td className="capitalize">{row.method ?? '—'}</Td>
                      <Td>
                        {row.paidAt ? (
                          formatDate(row.paidAt)
                        ) : row.lastDepositAt ? (
                          <>
                            {formatDate(row.lastDepositAt)}
                            <span className="text-xs text-ink-muted"> (partial)</span>
                          </>
                        ) : (
                          '—'
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      </section>

      <RenewalModal draft={draft} onClose={() => setDraft(null)} />

      <TenantFormModal
        mode="edit"
        open={editTenant}
        tenant={tenant}
        onClose={() => setEditTenant(false)}
      />
      <ConfirmDialog
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        onConfirm={doArchiveTenant}
        title="Archive tenant"
        confirmLabel="Archive"
        busy={archiveTenant.isPending}
        body={
          <>
            Archiving hides <strong>{tenant.fullName}</strong> from your lists but keeps their
            payment and lease history. You can restore them later.
          </>
        }
      />
      <LeaseFormModal
        mode="edit"
        open={editingLease !== null}
        lease={editingLease ?? undefined}
        onClose={() => setEditingLease(null)}
      />
      {coTenantsLeaseId && (
        <LeaseTenantsModal
          open
          leaseId={coTenantsLeaseId}
          onClose={() => setCoTenantsLeaseId(null)}
        />
      )}
      <ConfirmDialog
        open={terminating !== null}
        onClose={() => setTerminating(null)}
        onConfirm={doTerminate}
        title="Terminate lease"
        confirmLabel="Terminate"
        busy={terminateLease.isPending}
        body="This ends the active lease and marks the unit vacant. Payment history is retained."
      />
    </div>
  );
}
