// Unit detail: the single-unit counterpart to the Property hub. Header with the
// unit facts as a subtitle, a derived "Needs attention" triage card, then a
// two-column grid — current-lease management (create when vacant; draft
// renewal / edit terms / co-tenants / terminate when occupied, with this
// month's rent snapshot) alongside the unit-scoped MTD/YTD P&L — followed by
// full lease history, rent payment history, and attached documents. Write
// controls hide behind usePermissions; reads stay visible.
import { useState } from 'react';
import { formatUsd, formatUsdWhole } from '@hearth/shared';
import type { Lease, LeaseWithTenants, RenewalDraftResponse } from '@hearth/shared';
import { Link, useParams } from 'react-router-dom';
import {
  useArchiveUnit,
  useDraftRenewal,
  useRestoreUnit,
  useTerminateLease,
  useUnitDetail,
} from '../api/queries';
import { DocumentsCard } from '../components/documents/DocumentsCard';
import { LeaseFormModal, type LeasePrefill } from '../components/forms/LeaseFormModal';
import { LeaseTenantsModal } from '../components/forms/LeaseTenantsModal';
import { RenewalModal } from '../components/forms/RenewalModal';
import { UnitFormModal } from '../components/forms/UnitFormModal';
import { LeaseHistoryTable } from '../components/property/LeaseHistoryTable';
import { NeedsAttention } from '../components/property/NeedsAttention';
import { RentSnapshotBadge } from '../components/property/RentSnapshotBadge';
import { PageHeader } from '../components/shell/PageHeader';
import { Button, buttonClasses } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Table, Td, Th, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { formatDate, formatMonth } from '../lib/format';
import { rentStatusBadge } from '../lib/statusBadges';
import { usePageTitle } from '../lib/usePageTitle';
import { usePermissions } from '../lib/usePermissions';

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
  const { can } = usePermissions();
  const canProperties = can('properties');
  const canTenants = can('tenants');
  const archiveUnit = useArchiveUnit();
  const restoreUnit = useRestoreUnit();
  const terminateLease = useTerminateLease();
  const draftRenewal = useDraftRenewal();

  const [modal, setModal] = useState<UnitModal>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [terminating, setTerminating] = useState<LeaseWithTenants | null>(null);
  const [renewalDraft, setRenewalDraft] = useState<RenewalDraftResponse | null>(null);

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

  const { unit, propertyId, propertyLabel, leases, rentPayments, pnl } = detail.data;
  // The embedded unit carries the canonical occupancy fields; the response's
  // top-level status/currentLease exist only for older clients.
  const currentLease = unit.currentLease;

  // Unit facts as the header subtitle — "2 bd · 1 ba · market rent $1,350/mo",
  // omitting any part the unit doesn't record.
  const facts = [
    unit.bedrooms != null && `${unit.bedrooms} bd`,
    unit.bathrooms != null && `${unit.bathrooms} ba`,
    unit.marketRentCents != null && `market rent ${formatUsdWhole(unit.marketRentCents)}/mo`,
  ]
    .filter(Boolean)
    .join(' · ');

  // Re-lease starting point: seed Create lease from the most recent ended
  // lease (LeaseFormModal only applies it while the form is untouched).
  const priorLease = leases.find((l) => l.status === 'ended');
  const leasePrefill: LeasePrefill | null = priorLease
    ? {
        rentCents: priorLease.rentCents,
        dueDay: priorLease.dueDay,
        tenantIds: priorLease.tenants.map((t) => t.id),
        tenantName: priorLease.tenants[0]?.fullName,
      }
    : null;

  const startRenewalDraft = (lease: Lease | LeaseWithTenants) => {
    draftRenewal.mutate(lease.id, {
      onSuccess: (proposal) => setRenewalDraft(proposal),
      onError: () => toast('Could not draft a renewal. Try again.', 'danger'),
    });
  };

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
        description={facts || undefined}
        actions={
          canProperties ? (
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setModal({ kind: 'edit-unit' })}>
                Edit unit
              </Button>
              {!unit.archivedAt && (
                <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(true)}>
                  Archive unit
                </Button>
              )}
            </div>
          ) : undefined
        }
      />

      {unit.archivedAt && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-warning-soft px-4 py-3 text-sm text-ink"
        >
          <span>This unit is archived and hidden from your lists.</span>
          {canProperties && (
            <Button
              variant="secondary"
              size="sm"
              busy={restoreUnit.isPending}
              onClick={doRestoreUnit}
            >
              Restore unit
            </Button>
          )}
        </div>
      )}

      {/* Triage over just this unit — hidden while archived so an archived unit
          never reads as an all-clear. */}
      {!unit.archivedAt && (
        <NeedsAttention
          title={`${unit.label} · ${propertyLabel}`}
          units={[unit]}
          canTenants={canTenants}
          draftBusy={draftRenewal.isPending}
          onDraftRenewal={startRenewalDraft}
          onCreateLease={() => setModal({ kind: 'create-lease' })}
        />
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section aria-label="Current lease" className="lg:col-span-2">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-ink">Current lease</h2>
              {unit.archivedAt ? (
                <StatusBadge tone="neutral">Archived</StatusBadge>
              ) : unit.status === 'occupied' ? (
                <StatusBadge tone="positive">Occupied</StatusBadge>
              ) : (
                <StatusBadge tone="warning">Vacant</StatusBadge>
              )}
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
                    {/* This month's rent, only when a charge touches the month
                        (rent is null otherwise — a calm state, not missing data). */}
                    {unit.rent != null && (
                      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium text-ink">This month:</span>
                        <Link
                          to={`/rent?period=${unit.rent.period}`}
                          className="inline-flex rounded-full transition-opacity duration-fast hover:opacity-80"
                        >
                          <RentSnapshotBadge rent={unit.rent} />
                          <span className="sr-only"> — open rent tracker</span>
                        </Link>
                      </p>
                    )}
                  </div>
                  {canTenants && (
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        busy={draftRenewal.isPending}
                        onClick={() => startRenewalDraft(currentLease)}
                      >
                        Draft renewal
                      </Button>
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
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-ink-muted">This unit is vacant — no active lease.</p>
                  {canTenants && !unit.archivedAt && (
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

        <section aria-label="Financials" className="flex flex-col gap-3">
          {/* Visually the table caption is the section title; this keeps the
              heading order intact for screen readers. */}
          <h2 className="sr-only">Financials</h2>
          <Card flush>
            <Table
              caption={`${unit.label} — profit and loss, month to date and year to date`}
              captionVisible
              className="px-4"
            >
              <thead>
                <tr>
                  <Th>
                    <span className="sr-only">Line item</span>
                  </Th>
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* /money filters by property, not unit — the label says so. */}
            <p className="text-xs text-ink-muted">Unit-assigned transactions only.</p>
            <Link to={`/money?propertyId=${propertyId}`} className={buttonClasses('ghost', 'sm')}>
              View property transactions →
            </Link>
          </div>
        </section>
      </div>

      <section aria-label="Lease history" className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-ink">Lease history</h2>
        <Card flush>
          <LeaseHistoryTable leases={leases} unitLabel={unit.label} />
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
        unit={unit}
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
        prefill={leasePrefill}
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
      <RenewalModal draft={renewalDraft} onClose={() => setRenewalDraft(null)} />
    </div>
  );
}
