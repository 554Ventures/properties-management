// Property detail (PRD §5.2) — the hub for one property: header, a KPI row
// (occupancy, rent roll, net MTD/YTD), then a two-column layout — "Needs
// attention" triage + documents in the aside, the enriched units & leases
// table (tenant quick sheets, this-month rent status, renewal affordances)
// and financials in the main column. Write controls hide behind
// usePermissions; reads stay visible.
import { useMemo, useState } from 'react';
import { RENEW_SOON_DAYS, formatUsd, formatUsdWhole } from '@hearth/shared';
import type {
  Lease,
  LeaseWithTenants,
  PropertyDetailUnit,
  RenewalDraftResponse,
  TenantOnLease,
} from '@hearth/shared';
import { Link, useParams } from 'react-router-dom';
import {
  useArchiveProperty,
  useArchiveUnit,
  useDraftRenewal,
  usePropertyDetail,
  useRestoreProperty,
  useRestoreUnit,
  useTerminateLease,
  useUnitDetail,
} from '../api/queries';
import { DocumentsCard } from '../components/documents/DocumentsCard';
import { LeaseFormModal, type LeasePrefill } from '../components/forms/LeaseFormModal';
import { LeaseTenantsModal } from '../components/forms/LeaseTenantsModal';
import { PropertyFormModal } from '../components/forms/PropertyFormModal';
import { RenewalModal } from '../components/forms/RenewalModal';
import { UnitFormModal } from '../components/forms/UnitFormModal';
import { LeaseHistoryModal } from '../components/property/LeaseHistoryModal';
import { NeedsAttention } from '../components/property/NeedsAttention';
import { RentSnapshotBadge } from '../components/property/RentSnapshotBadge';
import { TenantQuickSheet } from '../components/property/TenantQuickSheet';
import { PageHeader } from '../components/shell/PageHeader';
import { Button, buttonClasses } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { KpiTile, KpiTileSkeleton } from '../components/ui/KpiTile';
import { ProgressBar } from '../components/ui/ProgressBar';
import { RowActions, type RowAction } from '../components/ui/RowActions';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Table, Td, Th, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import {
  IconArchive,
  IconCalendarCheck,
  IconFileText,
  IconPencil,
  IconPlus,
  IconUsers,
  IconX,
} from '../components/ui/icons';
import { daysUntil, formatDate } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';
import { usePermissions } from '../lib/usePermissions';

// Every dialog on the page lives in one discriminated union — exactly one can
// be open, and each mounts only while it is.
type PropertyModal =
  | { kind: 'edit-property' }
  | { kind: 'archive-property' }
  | { kind: 'add-unit' }
  | { kind: 'edit-unit'; unit: PropertyDetailUnit }
  | { kind: 'archive-unit'; unit: PropertyDetailUnit }
  | { kind: 'create-lease'; unit: PropertyDetailUnit }
  | { kind: 'edit-lease'; lease: Lease }
  | { kind: 'co-tenants'; leaseId: string }
  | { kind: 'terminate-lease'; lease: Lease }
  | { kind: 'lease-history'; unitId: string; unitLabel: string }
  | { kind: 'tenant'; tenant: TenantOnLease }
  | null;

const daysLabel = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

export function PropertyDetail() {
  const { id } = useParams<{ id: string }>();
  const detail = usePropertyDetail(id);
  const title = detail.data
    ? (detail.data.property.nickname ?? detail.data.property.addressLine1)
    : 'Property';
  usePageTitle(title);

  const { toast } = useToast();
  const { can } = usePermissions();
  const canProperties = can('properties');
  const canTenants = can('tenants');
  const archiveProperty = useArchiveProperty();
  const restoreProperty = useRestoreProperty();
  const archiveUnit = useArchiveUnit();
  const restoreUnit = useRestoreUnit();
  const terminateLease = useTerminateLease();
  const draftRenewal = useDraftRenewal();

  const [modal, setModal] = useState<PropertyModal>(null);
  const [renewalDraft, setRenewalDraft] = useState<RenewalDraftResponse | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // Re-lease prefill: when creating a lease on a unit that had one before,
  // lazily fetch the unit's lease history and seed the form from the most
  // recent ended lease. Memoized so the modal's prefill effect sees a stable
  // object across renders.
  const createLeaseUnit = modal?.kind === 'create-lease' ? modal.unit : null;
  const priorUnit = useUnitDetail(
    createLeaseUnit && createLeaseUnit.leaseCount > 0 ? createLeaseUnit.id : undefined,
  );
  const leasePrefill = useMemo<LeasePrefill | null>(() => {
    const prior = priorUnit.data?.leases.find((l) => l.status === 'ended');
    if (!prior) return null;
    return {
      rentCents: prior.rentCents,
      dueDay: prior.dueDay,
      tenantIds: prior.tenants.map((t) => t.id),
      tenantName: prior.tenants[0]?.fullName,
    };
  }, [priorUnit.data]);

  if (detail.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-9 w-72" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiTileSkeleton />
          <KpiTileSkeleton />
          <KpiTileSkeleton />
          <KpiTileSkeleton />
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="flex flex-col gap-6 lg:col-start-3 lg:row-start-1">
            <Skeleton className="h-40 w-full" />
          </div>
          <div className="flex flex-col gap-6 lg:col-span-2 lg:col-start-1 lg:row-start-1">
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Property"
          breadcrumbs={[{ label: 'Properties', to: '/properties' }, { label: 'Detail' }]}
        />
        <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { property, units, pnl, insights } = detail.data;
  const propertyId = property.id;

  const activeUnits = units.filter((unit) => !unit.archivedAt);
  const archivedUnits = units.filter((unit) => unit.archivedAt);
  const visibleUnits = showArchived ? units : activeUnits;

  // KPI row — occupancy over active units, rent roll from current leases only
  // (a pendingLease awaiting signature doesn't count toward rent roll yet).
  const occupiedUnits = activeUnits.filter((unit) => unit.status === 'occupied').length;
  const occupancyPct =
    activeUnits.length > 0 ? Math.round((occupiedUnits / activeUnits.length) * 100) : null;
  const rentRollCents = activeUnits.reduce(
    (sum, unit) => sum + (unit.currentLease?.rentCents ?? 0),
    0,
  );

  // Summary counts consider only units with a rent charge this month — a
  // leased unit whose lease doesn't touch the month (rent: null) owes nothing.
  const chargedUnits = activeUnits.filter((unit) => unit.currentLease && unit.rent);
  const paidCount = chargedUnits.filter((unit) => unit.rent?.status === 'paid').length;
  const lateCount = chargedUnits.filter((unit) => unit.rent?.status === 'late').length;
  const summaryParts = [`${activeUnits.length} ${activeUnits.length === 1 ? 'unit' : 'units'}`];
  if (chargedUnits.length > 0)
    summaryParts.push(`${paidCount} of ${chargedUnits.length} paid this month`);
  if (lateCount > 0) summaryParts.push(`${lateCount} late`);

  const startRenewalDraft = (lease: Lease | LeaseWithTenants) => {
    draftRenewal.mutate(lease.id, {
      onSuccess: (proposal) => setRenewalDraft(proposal),
      onError: () => toast('Could not draft a renewal. Try again.', 'danger'),
    });
  };

  const doArchiveProperty = () => {
    archiveProperty.mutate(propertyId, {
      onSuccess: () => {
        toast(`${title} archived.`, 'positive');
        setModal(null);
      },
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not archive the property.', 'danger'),
    });
  };

  const doRestoreProperty = () => {
    restoreProperty.mutate(propertyId, {
      onSuccess: () => toast(`${title} restored.`, 'positive'),
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not restore the property.', 'danger'),
    });
  };

  const doArchiveUnit = (unit: PropertyDetailUnit) => {
    archiveUnit.mutate(
      { id: unit.id, propertyId },
      {
        onSuccess: () => {
          toast(`Unit ${unit.label} archived.`, 'positive');
          setModal(null);
        },
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not archive the unit.', 'danger'),
      },
    );
  };

  const doRestoreUnit = (unit: PropertyDetailUnit) => {
    restoreUnit.mutate(
      { id: unit.id, propertyId },
      {
        onSuccess: () => toast(`Unit ${unit.label} restored.`, 'positive'),
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not restore the unit.', 'danger'),
      },
    );
  };

  const doTerminate = (lease: Lease) => {
    terminateLease.mutate(lease.id, {
      onSuccess: () => {
        toast('Lease terminated.', 'positive');
        setModal(null);
      },
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not terminate the lease.', 'danger'),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={title}
        breadcrumbs={[{ label: 'Properties', to: '/properties' }, { label: title }]}
        description={
          <>
            {property.nickname ? `${property.addressLine1} · ` : ''}
            {property.city}, {property.state} {property.zip}
            {property.acquisitionDate && (
              <> · Acquired {formatDate(property.acquisitionDate)}
                {property.acquisitionCostCents != null &&
                  ` for ${formatUsdWhole(property.acquisitionCostCents)}`}
              </>
            )}
          </>
        }
        actions={
          canProperties ? (
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setModal({ kind: 'edit-property' })}
              >
                Edit property
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setModal({ kind: 'archive-property' })}>
                Archive property
              </Button>
            </div>
          ) : undefined
        }
      />

      {property.archivedAt && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-warning-soft px-4 py-3 text-sm text-ink"
        >
          <span>This property is archived and hidden from your lists.</span>
          {canProperties && (
            <Button variant="secondary" size="sm" busy={restoreProperty.isPending} onClick={doRestoreProperty}>
              Restore property
            </Button>
          )}
        </div>
      )}

      <section aria-label="Key metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Occupancy"
          value={occupancyPct != null ? `${occupancyPct}%` : '—'}
          ariaLabel={
            occupancyPct != null
              ? `Occupancy: ${occupiedUnits} of ${activeUnits.length} units occupied`
              : 'Occupancy: no active units'
          }
        >
          {occupancyPct != null && (
            <ProgressBar
              value={occupiedUnits}
              max={activeUnits.length}
              label="Occupancy"
              text={`${occupiedUnits} of ${activeUnits.length} units occupied`}
            />
          )}
        </KpiTile>
        <KpiTile
          label="Rent roll / mo"
          value={formatUsdWhole(rentRollCents)}
          ariaLabel={`Rent roll, ${formatUsd(rentRollCents)} per month`}
        />
        <KpiTile
          label="Net (MTD)"
          value={formatUsdWhole(pnl.mtd.netCents)}
          ariaLabel={`Net income, month to date, ${formatUsd(pnl.mtd.netCents)}`}
        />
        <KpiTile
          label="Net (YTD)"
          value={formatUsdWhole(pnl.ytd.netCents)}
          ariaLabel={`Net income, year to date, ${formatUsd(pnl.ytd.netCents)}`}
        />
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Aside first in DOM so attention items precede the units table on
            mobile, where the grid collapses to a single column. */}
        <div className="flex flex-col gap-6 lg:col-start-3 lg:row-start-1">
          <NeedsAttention
            title={title}
            units={units}
            insights={insights}
            archived={Boolean(property.archivedAt)}
            canTenants={canTenants}
            draftBusy={draftRenewal.isPending}
            onDraftRenewal={startRenewalDraft}
            onCreateLease={(unit) => setModal({ kind: 'create-lease', unit })}
          />
          <section aria-label="Documents">
            <DocumentsCard
              filter={{ propertyId }}
              uploadTarget={{ entityType: 'property', entityId: propertyId }}
            />
          </section>
        </div>

        <div className="flex flex-col gap-6 lg:col-span-2 lg:col-start-1 lg:row-start-1">
          <section aria-label="Units and leases" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-base font-semibold text-ink">Units &amp; leases</h2>
                <p className="text-sm text-ink-muted">{summaryParts.join(' · ')}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {archivedUnits.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-pressed={showArchived}
                    onClick={() => setShowArchived((v) => !v)}
                  >
                    {showArchived ? 'Hide archived' : `Show archived (${archivedUnits.length})`}
                  </Button>
                )}
                {canProperties && (
                  <Button size="sm" onClick={() => setModal({ kind: 'add-unit' })}>
                    <IconPlus size={14} />
                    Add unit
                  </Button>
                )}
              </div>
            </div>
            <Card flush>
              {units.length === 0 ? (
                <EmptyState
                  title="No units yet"
                  body="Add the first unit to start a lease."
                  action={
                    canProperties ? (
                      <Button size="sm" onClick={() => setModal({ kind: 'add-unit' })}>
                        <IconPlus size={14} />
                        Add unit
                      </Button>
                    ) : undefined
                  }
                />
              ) : visibleUnits.length === 0 ? (
                <p className="p-5 text-sm text-ink-muted">
                  All units here are archived — use “Show archived” above to see them.
                </p>
              ) : (
                <Table caption={`${title} — units, tenants, rent, and lease status`}>
                  <thead>
                    <tr>
                      <Th>Unit</Th>
                      <Th>Tenants</Th>
                      <Th align="right">Rent / mo</Th>
                      <Th>Lease</Th>
                      <Th>This month</Th>
                      <Th align="right" stickyRight>
                        <span className="sr-only">Actions</span>
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleUnits.map((unit) => (
                      <UnitRow
                        key={unit.id}
                        unit={unit}
                        canProperties={canProperties}
                        canTenants={canTenants}
                        restoreBusy={restoreUnit.isPending}
                        draftBusy={draftRenewal.isPending}
                        onRestore={() => doRestoreUnit(unit)}
                        onRenew={startRenewalDraft}
                        setModal={setModal}
                      />
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </section>

          <section aria-label="Financials" className="flex flex-col gap-3">
            <h2 className="text-base font-semibold text-ink">Financials</h2>
            <Card flush>
              <Table
                caption={`${title} — profit and loss, month to date and year to date`}
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
              <p className="text-xs text-ink-muted">
                Excludes transactions not assigned to this property.
              </p>
              <Link to={`/money?propertyId=${propertyId}`} className={buttonClasses('ghost', 'sm')}>
                View transactions →
              </Link>
            </div>
          </section>
        </div>
      </div>

      {/* --- Modals & confirmations (one open at a time, mounted on demand) --- */}
      {modal?.kind === 'edit-property' && (
        <PropertyFormModal mode="edit" open property={property} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'archive-property' && (
        <ConfirmDialog
          open
          onClose={() => setModal(null)}
          onConfirm={doArchiveProperty}
          title="Archive property"
          confirmLabel="Archive"
          busy={archiveProperty.isPending}
          body={
            <>
              Archiving hides <strong>{title}</strong> from your lists but keeps its history. You
              can restore it later.
            </>
          }
        />
      )}
      {modal?.kind === 'add-unit' && (
        <UnitFormModal mode="create" open propertyId={propertyId} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'edit-unit' && (
        <UnitFormModal
          mode="edit"
          open
          propertyId={propertyId}
          unit={modal.unit}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'archive-unit' && (
        <ConfirmDialog
          open
          onClose={() => setModal(null)}
          onConfirm={() => doArchiveUnit(modal.unit)}
          title="Archive unit"
          confirmLabel="Archive"
          busy={archiveUnit.isPending}
          body={
            <>
              Archiving hides unit <strong>{modal.unit.label}</strong> but keeps its history.
            </>
          }
        />
      )}
      {modal?.kind === 'create-lease' && (
        <LeaseFormModal
          mode="create"
          open
          unitId={modal.unit.id}
          unitLabel={modal.unit.label}
          suggestedRentCents={modal.unit.marketRentCents}
          prefill={leasePrefill}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'edit-lease' && (
        <LeaseFormModal mode="edit" open lease={modal.lease} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'co-tenants' && (
        <LeaseTenantsModal open leaseId={modal.leaseId} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'terminate-lease' && (
        <ConfirmDialog
          open
          onClose={() => setModal(null)}
          onConfirm={() => doTerminate(modal.lease)}
          title="Terminate lease"
          confirmLabel="Terminate"
          busy={terminateLease.isPending}
          body="This ends the active lease and marks the unit vacant. Payment history is retained."
        />
      )}
      {modal?.kind === 'lease-history' && (
        <LeaseHistoryModal
          unitId={modal.unitId}
          unitLabel={modal.unitLabel}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'tenant' && (
        <TenantQuickSheet tenant={modal.tenant} onClose={() => setModal(null)} />
      )}
      <RenewalModal draft={renewalDraft} onClose={() => setRenewalDraft(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// One row of the units & leases table.

interface UnitRowProps {
  unit: PropertyDetailUnit;
  canProperties: boolean;
  canTenants: boolean;
  restoreBusy: boolean;
  draftBusy: boolean;
  onRestore: () => void;
  onRenew: (lease: LeaseWithTenants) => void;
  setModal: (modal: PropertyModal) => void;
}

function UnitRow({
  unit,
  canProperties,
  canTenants,
  restoreBusy,
  draftBusy,
  onRestore,
  onRenew,
  setModal,
}: UnitRowProps) {
  const lease = unit.currentLease;

  const facts = [
    unit.bedrooms != null && `${unit.bedrooms} bd`,
    unit.bathrooms != null && `${unit.bathrooms} ba`,
    unit.marketRentCents != null && `market ${formatUsdWhole(unit.marketRentCents)}`,
  ]
    .filter(Boolean)
    .join(' · ');

  const rentDelta =
    lease && unit.marketRentCents != null ? lease.rentCents - unit.marketRentCents : 0;
  const formatDelta = (cents: number) =>
    cents % 100 === 0 ? formatUsdWhole(cents) : formatUsd(cents);

  // Past end dates stay in the window: an expired lease is still 'active'
  // (month-to-month lapse), and renewing it is the most urgent case.
  const renewDays = lease ? daysUntil(lease.endDate) : null;
  const inRenewWindow = renewDays != null && renewDays <= RENEW_SOON_DAYS;
  // leaseCount is the unit's unfiltered lease total — subtract the current and
  // pending leases so a renewal awaiting signature doesn't read as history.
  const priorLeases = unit.leaseCount - (lease ? 1 : 0) - (unit.pendingLease ? 1 : 0);

  const historyAction: RowAction = {
    label: 'Lease history',
    icon: <IconFileText size={14} />,
    onClick: () => setModal({ kind: 'lease-history', unitId: unit.id, unitLabel: unit.label }),
  };
  const unitActions: RowAction[] = canProperties
    ? [
        {
          label: 'Edit unit',
          icon: <IconPencil size={14} />,
          onClick: () => setModal({ kind: 'edit-unit', unit }),
        },
        {
          label: 'Archive unit',
          icon: <IconArchive size={14} />,
          onClick: () => setModal({ kind: 'archive-unit', unit }),
        },
      ]
    : [];

  return (
    <Tr>
      <Td className="font-medium">
        <Link
          to={`/units/${unit.id}`}
          className="text-ink transition-colors duration-fast hover:text-brand"
        >
          {unit.label}
        </Link>
        {facts && <p className="mt-0.5 text-xs font-normal text-ink-muted">{facts}</p>}
      </Td>

      <Td>
        {lease && lease.tenants.length > 0 ? (
          lease.tenants.map((tenant, i) => (
            <span key={tenant.id}>
              {i > 0 && ', '}
              <button
                type="button"
                className="text-left text-ink transition-colors duration-fast hover:text-brand"
                onClick={() => setModal({ kind: 'tenant', tenant })}
              >
                {tenant.fullName}
              </button>
            </span>
          ))
        ) : (
          <span className="text-ink-muted">—</span>
        )}
      </Td>

      <Td align="right" className="tabular-nums">
        {lease ? (
          <>
            {formatUsd(lease.rentCents)}
            {rentDelta !== 0 && (
              <p className="mt-0.5 text-xs text-ink-muted">
                {rentDelta > 0 ? '+' : '−'}
                {formatDelta(Math.abs(rentDelta))} vs market
              </p>
            )}
          </>
        ) : (
          <span className="text-ink-muted">—</span>
        )}
      </Td>

      <Td>
        {lease ? (
          <>
            <p>
              {formatDate(lease.startDate)} – {formatDate(lease.endDate)}
            </p>
            <p className="mt-0.5 text-xs text-ink-muted">due day {lease.dueDay}</p>
            {priorLeases >= 1 && (
              <button
                type="button"
                className="mt-0.5 text-xs text-ink-muted underline underline-offset-2 transition-colors duration-fast hover:text-brand"
                onClick={() =>
                  setModal({ kind: 'lease-history', unitId: unit.id, unitLabel: unit.label })
                }
              >
                {priorLeases} prior {priorLeases === 1 ? 'lease' : 'leases'}
              </button>
            )}
            {(inRenewWindow || lease.esignStatus) && (
              <div className="mt-1 flex flex-wrap gap-1">
                {inRenewWindow &&
                  (unit.pendingLease ? (
                    <StatusBadge tone="neutral">Renewal awaiting signature</StatusBadge>
                  ) : renewDays < 0 ? (
                    <StatusBadge tone="danger">Month-to-month</StatusBadge>
                  ) : (
                    <StatusBadge tone="warning">
                      {renewDays === 0 ? 'Lease ends today' : `Renews in ${daysLabel(renewDays)}`}
                    </StatusBadge>
                  ))}
                {lease.esignStatus && (
                  <StatusBadge tone={lease.esignStatus === 'signed' ? 'positive' : 'neutral'}>
                    E-sign: {lease.esignStatus}
                  </StatusBadge>
                )}
              </div>
            )}
          </>
        ) : (
          <span className="text-ink-muted">—</span>
        )}
      </Td>

      <Td>
        {unit.archivedAt ? (
          <StatusBadge tone="neutral">Archived</StatusBadge>
        ) : !lease ? (
          <StatusBadge tone="warning">Vacant</StatusBadge>
        ) : unit.rent ? (
          <Link
            to={`/rent?period=${unit.rent.period}`}
            className="inline-flex rounded-full transition-opacity duration-fast hover:opacity-80"
          >
            <RentSnapshotBadge rent={unit.rent} />
            <span className="sr-only"> — open rent tracker</span>
          </Link>
        ) : (
          <span className="text-ink-muted">—</span>
        )}
      </Td>

      <Td align="right" stickyRight>
        {unit.archivedAt ? (
          canProperties ? (
            <Button variant="secondary" size="sm" busy={restoreBusy} onClick={onRestore}>
              Restore
            </Button>
          ) : null
        ) : lease ? (
          (() => {
            const visible: RowAction[] = canTenants
              ? [
                  {
                    label: 'Edit terms',
                    icon: <IconPencil size={14} />,
                    onClick: () => setModal({ kind: 'edit-lease', lease }),
                  },
                  {
                    label: 'Co-tenants',
                    icon: <IconUsers size={14} />,
                    onClick: () => setModal({ kind: 'co-tenants', leaseId: lease.id }),
                  },
                  ...(inRenewWindow && !unit.pendingLease
                    ? [
                        {
                          label: 'Renew…',
                          icon: <IconCalendarCheck size={14} />,
                          busy: draftBusy,
                          onClick: () => onRenew(lease),
                        },
                      ]
                    : []),
                ]
              : [];
            const overflow: RowAction[] = [
              ...(canTenants
                ? [
                    {
                      label: 'Terminate',
                      icon: <IconX size={14} />,
                      onClick: () => setModal({ kind: 'terminate-lease', lease }),
                    },
                  ]
                : []),
              historyAction,
              ...unitActions,
            ];
            return (
              <RowActions
                context={`${unit.label} lease`}
                actions={[...visible, ...overflow]}
                collapseAfter={visible.length}
              />
            );
          })()
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-1">
            {/* The primary affordance for a vacant unit stays a visible
                button; only the secondary edits collapse. */}
            {canTenants && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setModal({ kind: 'create-lease', unit })}
              >
                Create lease
              </Button>
            )}
            <RowActions
              context={unit.label}
              actions={[...(unit.leaseCount > 0 ? [historyAction] : []), ...unitActions]}
            />
          </div>
        )}
      </Td>
    </Tr>
  );
}
