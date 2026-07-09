// Property detail (PRD §5.2): header, MTD/YTD P&L, per-unit list with lease and
// tenant status, plus full management — edit/archive the property, add/edit/
// archive units, and create/edit/terminate leases with co-tenant controls.
import { useState } from 'react';
import { formatUsd, formatUsdWhole } from '@hearth/shared';
import type { Lease, PropertyDetailUnit } from '@hearth/shared';
import { Link, useParams } from 'react-router-dom';
import {
  useArchiveProperty,
  useArchiveUnit,
  usePropertyDetail,
  useRestoreProperty,
  useRestoreUnit,
  useTerminateLease,
} from '../api/queries';
import { InsightCard } from '../components/ai/InsightCard';
import { LeaseFormModal } from '../components/forms/LeaseFormModal';
import { LeaseTenantsModal } from '../components/forms/LeaseTenantsModal';
import { PropertyFormModal } from '../components/forms/PropertyFormModal';
import { UnitFormModal } from '../components/forms/UnitFormModal';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { LiveRegion } from '../components/ui/LiveRegion';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Table, Td, Th, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { IconPlus } from '../components/ui/icons';
import { formatDate } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';

type UnitModal =
  | { kind: 'add-unit' }
  | { kind: 'edit-unit'; unit: PropertyDetailUnit }
  | { kind: 'create-lease'; unit: PropertyDetailUnit }
  | { kind: 'edit-lease'; lease: Lease }
  | { kind: 'co-tenants'; leaseId: string }
  | null;

export function PropertyDetail() {
  const { id } = useParams<{ id: string }>();
  const detail = usePropertyDetail(id);
  const title = detail.data
    ? (detail.data.property.nickname ?? detail.data.property.addressLine1)
    : 'Property';
  usePageTitle(title);

  const { toast } = useToast();
  const archiveProperty = useArchiveProperty();
  const restoreProperty = useRestoreProperty();
  const archiveUnit = useArchiveUnit();
  const restoreUnit = useRestoreUnit();
  const terminateLease = useTerminateLease();

  const [editProperty, setEditProperty] = useState(false);
  const [confirmArchiveProperty, setConfirmArchiveProperty] = useState(false);
  const [modal, setModal] = useState<UnitModal>(null);
  const [archivingUnit, setArchivingUnit] = useState<PropertyDetailUnit | null>(null);
  const [terminating, setTerminating] = useState<Lease | null>(null);

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
          title="Property"
          breadcrumbs={[{ label: 'Properties', to: '/properties' }, { label: 'Detail' }]}
        />
        <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { property, units, pnl, insights } = detail.data;
  const propertyId = property.id;

  const doArchiveProperty = () => {
    archiveProperty.mutate(propertyId, {
      onSuccess: () => {
        toast(`${title} archived.`, 'positive');
        setConfirmArchiveProperty(false);
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

  const doArchiveUnit = () => {
    if (!archivingUnit) return;
    archiveUnit.mutate(
      { id: archivingUnit.id, propertyId },
      {
        onSuccess: () => {
          toast(`Unit ${archivingUnit.label} archived.`, 'positive');
          setArchivingUnit(null);
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
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditProperty(true)}>
              Edit property
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmArchiveProperty(true)}>
              Archive property
            </Button>
          </div>
        }
      />

      {property.archivedAt && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-warning-soft px-4 py-3 text-sm text-ink"
        >
          <span>This property is archived and hidden from your lists.</span>
          <Button variant="secondary" size="sm" busy={restoreProperty.isPending} onClick={doRestoreProperty}>
            Restore property
          </Button>
        </div>
      )}

      <section aria-label="Profit and loss summary">
        <Card flush>
          <Table
            caption={`${title} — profit and loss, month to date and year to date`}
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

      <section aria-label="Units" className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">Units</h2>
          <Button size="sm" onClick={() => setModal({ kind: 'add-unit' })}>
            <IconPlus size={14} />
            Add unit
          </Button>
        </div>
        <Card flush>
          <Table caption={`${title} — units, tenants, rent, and lease status`}>
            <thead>
              <tr>
                <Th>Unit</Th>
                <Th>Tenant</Th>
                <Th align="right">Rent / mo</Th>
                <Th>Lease ends</Th>
                <Th>Status</Th>
                <Th align="right" stickyRight>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {units.map((unit) => {
                const lease = unit.currentLease;
                return (
                  <Tr key={unit.id}>
                    <Td className="font-medium">{unit.label}</Td>
                    <Td>
                      {lease && lease.tenants.length > 0 ? (
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
                    <Td align="right">{lease ? formatUsd(lease.rentCents) : '—'}</Td>
                    <Td>{lease ? formatDate(lease.endDate) : '—'}</Td>
                    <Td>
                      {unit.archivedAt ? (
                        <StatusBadge tone="neutral">Archived</StatusBadge>
                      ) : unit.status === 'occupied' ? (
                        <StatusBadge tone="positive">Occupied</StatusBadge>
                      ) : (
                        <StatusBadge tone="warning">Vacant</StatusBadge>
                      )}
                    </Td>
                    <Td align="right" stickyRight>
                      <div className="flex flex-wrap justify-end gap-1">
                        {unit.archivedAt ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            busy={restoreUnit.isPending}
                            onClick={() => doRestoreUnit(unit)}
                          >
                            Restore
                          </Button>
                        ) : lease && unit.status === 'occupied' ? (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setModal({ kind: 'edit-lease', lease })}
                            >
                              Edit terms
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setModal({ kind: 'co-tenants', leaseId: lease.id })}
                            >
                              Co-tenants
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setTerminating(lease)}>
                              Terminate
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setModal({ kind: 'create-lease', unit })}
                            >
                              Create lease
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setModal({ kind: 'edit-unit', unit })}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setArchivingUnit(unit)}
                            >
                              Archive
                            </Button>
                          </>
                        )}
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      </section>

      <LiveRegion className="flex flex-col gap-4">
        {insights.map((insight) => (
          <InsightCard key={insight.id} insight={insight} />
        ))}
      </LiveRegion>

      {/* --- Modals & confirmations --- */}
      <PropertyFormModal
        mode="edit"
        open={editProperty}
        property={property}
        onClose={() => setEditProperty(false)}
      />
      <ConfirmDialog
        open={confirmArchiveProperty}
        onClose={() => setConfirmArchiveProperty(false)}
        onConfirm={doArchiveProperty}
        title="Archive property"
        confirmLabel="Archive"
        busy={archiveProperty.isPending}
        body={
          <>
            Archiving hides <strong>{title}</strong> from your lists but keeps its history. You can
            restore it later.
          </>
        }
      />

      <UnitFormModal
        mode="create"
        open={modal?.kind === 'add-unit'}
        propertyId={propertyId}
        onClose={() => setModal(null)}
      />
      <UnitFormModal
        mode="edit"
        open={modal?.kind === 'edit-unit'}
        propertyId={propertyId}
        unit={modal?.kind === 'edit-unit' ? modal.unit : undefined}
        onClose={() => setModal(null)}
      />
      <ConfirmDialog
        open={archivingUnit !== null}
        onClose={() => setArchivingUnit(null)}
        onConfirm={doArchiveUnit}
        title="Archive unit"
        confirmLabel="Archive"
        busy={archiveUnit.isPending}
        body={
          <>
            Archiving hides unit <strong>{archivingUnit?.label}</strong> but keeps its history.
          </>
        }
      />

      <LeaseFormModal
        mode="create"
        open={modal?.kind === 'create-lease'}
        unitId={modal?.kind === 'create-lease' ? modal.unit.id : undefined}
        unitLabel={modal?.kind === 'create-lease' ? modal.unit.label : undefined}
        suggestedRentCents={modal?.kind === 'create-lease' ? modal.unit.marketRentCents : undefined}
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
