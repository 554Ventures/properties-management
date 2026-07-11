// Unit detail: the single-unit counterpart to Property/Tenant detail. Header +
// unit facts, MTD/YTD P&L scoped to the unit, current-lease management (create
// when vacant; edit terms / co-tenants / terminate when occupied), full lease
// history, rent payment history, and attached documents.
import { useState } from 'react';
import { formatUsd, formatUsdWhole } from '@hearth/shared';
import type { Lease, LeaseWithTenants, PropertyDetailUnit } from '@hearth/shared';
import { Link, useParams } from 'react-router-dom';
import {
  useArchiveUnit,
  useRestoreUnit,
  useTerminateLease,
  useUnitDetail,
} from '../api/queries';
import { DocumentsCard } from '../components/documents/DocumentsCard';
import { LeaseFormModal } from '../components/forms/LeaseFormModal';
import { LeaseTenantsModal } from '../components/forms/LeaseTenantsModal';
import { UnitFormModal } from '../components/forms/UnitFormModal';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge, type BadgeTone } from '../components/ui/StatusBadge';
import { Table, Td, Th, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { formatDate, formatMonth } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';

const leaseStatusBadge: Record<string, { tone: BadgeTone; label: string }> = {
  active: { tone: 'positive', label: 'Active' },
  pending_signature: { tone: 'warning', label: 'Pending signature' },
  ended: { tone: 'neutral', label: 'Ended' },
};

const rentStatusBadge: Record<string, { tone: BadgeTone; label: string }> = {
  paid: { tone: 'positive', label: 'Paid' },
  due: { tone: 'neutral', label: 'Due' },
  processing: { tone: 'neutral', label: 'Processing' },
  failed: { tone: 'danger', label: 'Failed' },
  late: { tone: 'danger', label: 'Late' },
};

type UnitModal =
  | { kind: 'edit-unit' }
  | { kind: 'create-lease' }
  | { kind: 'edit-lease'; lease: Lease }
  | { kind: 'co-tenants'; leaseId: string }
  | null;

export function UnitDetail() {
  const { id } = useParams<{ id: string }>();
  const detail = useUnitDetail(id);
  const title = detail.data ? detail.data.unit.label : 'Unit';
  usePageTitle(title);

  const { toast } = useToast();
  const archiveUnit = useArchiveUnit();
  const restoreUnit = useRestoreUnit();
  const terminateLease = useTerminateLease();

  const [modal, setModal] = useState<UnitModal>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [terminating, setTerminating] = useState<LeaseWithTenants | null>(null);

  if (detail.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Unit"
          breadcrumbs={[{ label: 'Properties', to: '/properties' }, { label: 'Detail' }]}
        />
        <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { unit, propertyId, propertyLabel, status, currentLease, leases, rentPayments, pnl } =
    detail.data;

  // UnitFormModal's edit mode expects a PropertyDetailUnit (unit + occupancy
  // context) — recompose it from the flat response fields.
  const detailUnit: PropertyDetailUnit = { ...unit, status, currentLease };

  const doArchiveUnit = () => {
    archiveUnit.mutate(
      { id: unit.id, propertyId },
      {
        onSuccess: () => {
          toast(`Unit ${unit.label} archived.`, 'positive');
          setConfirmArchive(false);
        },
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not archive the unit.', 'danger'),
      },
    );
  };

  const doRestoreUnit = () => {
    restoreUnit.mutate(
      { id: unit.id, propertyId },
      {
        onSuccess: () => toast(`Unit ${unit.label} restored.`, 'positive'),
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not restore the unit.', 'danger'),
      },
    );
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
        title={`${unit.label} — ${propertyLabel}`}
        breadcrumbs={[
          { label: 'Properties', to: '/properties' },
          { label: propertyLabel, to: `/properties/${propertyId}` },
          { label: unit.label },
        ]}
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setModal({ kind: 'edit-unit' })}>
              Edit unit
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(true)}>
              Archive unit
            </Button>
          </div>
        }
      />

      {unit.archivedAt && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-warning-soft px-4 py-3 text-sm text-ink"
        >
          <span>This unit is archived and hidden from your lists.</span>
          <Button variant="secondary" size="sm" busy={restoreUnit.isPending} onClick={doRestoreUnit}>
            Restore unit
          </Button>
        </div>
      )}

      <section aria-label="Unit details">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Bedrooms
                </dt>
                <dd className="text-ink">{unit.bedrooms ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Bathrooms
                </dt>
                <dd className="text-ink">{unit.bathrooms ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Market rent
                </dt>
                <dd className="text-ink">
                  {unit.marketRentCents != null ? `${formatUsdWhole(unit.marketRentCents)}/mo` : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Status
                </dt>
                <dd>
                  {unit.archivedAt ? (
                    <StatusBadge tone="neutral">Archived</StatusBadge>
                  ) : status === 'occupied' ? (
                    <StatusBadge tone="positive">Occupied</StatusBadge>
                  ) : (
                    <StatusBadge tone="warning">Vacant</StatusBadge>
                  )}
                </dd>
              </div>
            </dl>
          </div>

          <div className="mt-4 border-t border-border pt-4">
            {currentLease ? (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-ink">
                    <span className="font-medium">Current tenant: </span>
                    {currentLease.tenants.length > 0 ? (
                      currentLease.tenants.map((tenant, i) => (
                        <span key={tenant.id}>
                          {i > 0 && ', '}
                          <Link
                            to={`/tenants/${tenant.id}`}
                            className="text-ink transition-colors duration-fast hover:text-brand"
                          >
                            {tenant.fullName}
                          </Link>
                        </span>
                      ))
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </p>
                  <p className="mt-1 text-sm text-ink-muted">
                    {formatUsd(currentLease.rentCents)}/mo · due day {currentLease.dueDay} ·{' '}
                    {formatDate(currentLease.startDate)} – {formatDate(currentLease.endDate)}
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setModal({ kind: 'edit-lease', lease: currentLease })}
                  >
                    Edit terms
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setModal({ kind: 'co-tenants', leaseId: currentLease.id })}
                  >
                    Co-tenants
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setTerminating(currentLease)}>
                    Terminate
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-ink-muted">This unit is vacant — no active lease.</p>
                {!unit.archivedAt && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setModal({ kind: 'create-lease' })}
                  >
                    Create lease
                  </Button>
                )}
              </div>
            )}
          </div>
        </Card>
      </section>

      <section aria-label="Profit and loss summary">
        <Card flush>
          <Table
            caption={`${unit.label} — profit and loss, month to date and year to date`}
            captionVisible
            className="px-4"
          >
            <thead>
              <tr>
                <Th> </Th>
                <Th align="right">Month to date</Th>
                <Th align="right">Year to date</Th>
              </tr>
            </thead>
            <tbody>
              <Tr>
                <Th scope="row">Income</Th>
                <Td align="right">{formatUsd(pnl.mtd.incomeCents)}</Td>
                <Td align="right">{formatUsd(pnl.ytd.incomeCents)}</Td>
              </Tr>
              <Tr>
                <Th scope="row">Expenses</Th>
                <Td align="right">{formatUsd(pnl.mtd.expenseCents)}</Td>
                <Td align="right">{formatUsd(pnl.ytd.expenseCents)}</Td>
              </Tr>
              <Tr className="font-semibold">
                <Th scope="row">Net</Th>
                <Td align="right">{formatUsd(pnl.mtd.netCents)}</Td>
                <Td align="right">{formatUsd(pnl.ytd.netCents)}</Td>
              </Tr>
            </tbody>
          </Table>
        </Card>
      </section>

      <section aria-label="Lease history" className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-ink">Lease history</h2>
        <Card flush>
          {leases.length === 0 ? (
            <p className="p-5 text-sm text-ink-muted">No leases on file for this unit.</p>
          ) : (
            <Table caption={`${unit.label} — lease history`}>
              <thead>
                <tr>
                  <Th>Tenant</Th>
                  <Th align="right">Rent / mo</Th>
                  <Th>Term</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {leases.map((lease) => {
                  const badge = leaseStatusBadge[lease.status] ?? leaseStatusBadge.ended;
                  return (
                    <Tr key={lease.id}>
                      <Td>
                        {lease.tenants.length > 0 ? (
                          lease.tenants.map((tenant, i) => (
                            <span key={tenant.id}>
                              {i > 0 && ', '}
                              <Link
                                to={`/tenants/${tenant.id}`}
                                className="text-ink transition-colors duration-fast hover:text-brand"
                              >
                                {tenant.fullName}
                              </Link>
                            </span>
                          ))
                        ) : (
                          <span className="text-ink-muted">—</span>
                        )}
                      </Td>
                      <Td align="right">{formatUsd(lease.rentCents)}</Td>
                      <Td>
                        {formatDate(lease.startDate)} – {formatDate(lease.endDate)}
                      </Td>
                      <Td>
                        <div className="flex flex-wrap gap-2">
                          {badge && <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}
                          {lease.esignStatus && (
                            <StatusBadge tone={lease.esignStatus === 'signed' ? 'positive' : 'neutral'}>
                              E-sign: {lease.esignStatus}
                            </StatusBadge>
                          )}
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      </section>

      <section aria-label="Payment history" className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-ink">Payment history</h2>
        <Card flush>
          {rentPayments.length === 0 ? (
            <p className="p-5 text-sm text-ink-muted">No rent payments recorded yet.</p>
          ) : (
            <Table caption={`${unit.label} — rent payment history`}>
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
                {rentPayments.map((row) => {
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
                      <Td>{row.paidAt ? formatDate(row.paidAt) : '—'}</Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      </section>

      <section aria-label="Documents">
        <DocumentsCard
          filter={{ entityType: 'unit', entityId: unit.id }}
          uploadTarget={{ entityType: 'unit', entityId: unit.id }}
        />
      </section>

      {/* --- Modals & confirmations --- */}
      <UnitFormModal
        mode="edit"
        open={modal?.kind === 'edit-unit'}
        propertyId={propertyId}
        unit={detailUnit}
        onClose={() => setModal(null)}
      />
      <ConfirmDialog
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        onConfirm={doArchiveUnit}
        title="Archive unit"
        confirmLabel="Archive"
        busy={archiveUnit.isPending}
        body={
          <>
            Archiving hides unit <strong>{unit.label}</strong> but keeps its history.
          </>
        }
      />

      <LeaseFormModal
        mode="create"
        open={modal?.kind === 'create-lease'}
        unitId={modal?.kind === 'create-lease' ? unit.id : undefined}
        unitLabel={modal?.kind === 'create-lease' ? unit.label : undefined}
        suggestedRentCents={modal?.kind === 'create-lease' ? unit.marketRentCents : undefined}
        onClose={() => setModal(null)}
      />
      <LeaseFormModal
        mode="edit"
        open={modal?.kind === 'edit-lease'}
        lease={modal?.kind === 'edit-lease' ? modal.lease : undefined}
        onClose={() => setModal(null)}
      />
      {modal?.kind === 'co-tenants' && (
        <LeaseTenantsModal open leaseId={modal.leaseId} onClose={() => setModal(null)} />
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
