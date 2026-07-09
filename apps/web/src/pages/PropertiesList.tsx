// Properties list (PRD §5.2): create/edit/archive properties with per-row
// actions. The property form modal is shared with PropertyDetail.
import { useState } from 'react';
import type { PropertyWithStats } from '@hearth/shared';
import { formatUsdWhole } from '@hearth/shared';
import { Link } from 'react-router-dom';
import { useArchiveProperty, useProperties } from '../api/queries';
import { PropertyFormModal } from '../components/forms/PropertyFormModal';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { DataTable, type DataTableColumn } from '../components/ui/DataTable';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge, type BadgeTone } from '../components/ui/StatusBadge';
import { useToast } from '../components/ui/Toast';
import { IconBuilding, IconPlus } from '../components/ui/icons';
import { usePageTitle } from '../lib/usePageTitle';

function statusTone(label: string): BadgeTone {
  const lower = label.toLowerCase();
  if (lower.includes('late')) return 'danger';
  if (lower.includes('vacant')) return 'warning';
  if (lower.includes('full')) return 'positive';
  return 'neutral';
}

export function PropertiesList() {
  usePageTitle('Properties');
  const properties = useProperties();
  const archive = useArchiveProperty();
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<PropertyWithStats | null>(null);
  const [archiving, setArchiving] = useState<PropertyWithStats | null>(null);

  const columns: DataTableColumn<PropertyWithStats>[] = [
    {
      id: 'property',
      header: 'Property',
      sortAccessor: (p) => p.nickname ?? p.addressLine1,
      filter: { kind: 'text', accessor: (p) => `${p.nickname ?? ''} ${p.addressLine1}` },
      searchAccessor: (p) =>
        `${p.nickname ?? ''} ${p.addressLine1} ${p.city} ${p.state} ${p.zip}`,
      cell: (p) => (
        <>
          <Link
            to={`/properties/${p.id}`}
            className="font-medium text-ink transition-colors duration-fast hover:text-brand"
          >
            {p.nickname ?? p.addressLine1}
          </Link>
          <p className="mt-0.5 text-xs text-ink-muted">
            {p.nickname ? `${p.addressLine1} · ` : ''}
            {p.city}, {p.state} {p.zip}
          </p>
        </>
      ),
    },
    {
      id: 'units',
      header: 'Units',
      sortAccessor: (p) => p.unitCount,
      filter: { kind: 'number', accessor: (p) => p.unitCount },
      cell: (p) => p.unitCount,
    },
    {
      id: 'occupancy',
      header: 'Occupancy',
      sortAccessor: (p) => (p.unitCount === 0 ? 0 : p.occupiedCount / p.unitCount),
      cell: (p) => `${p.occupiedCount}/${p.unitCount} occupied`,
    },
    {
      id: 'rent',
      header: 'Rent / mo',
      align: 'right',
      sortAccessor: (p) => p.monthlyRentCents,
      filter: { kind: 'number', accessor: (p) => p.monthlyRentCents / 100, unit: '$' },
      cell: (p) => formatUsdWhole(p.monthlyRentCents),
    },
    {
      id: 'status',
      header: 'Status',
      sortAccessor: (p) => p.statusLabel,
      filter: { kind: 'select', accessor: (p) => p.statusLabel },
      cell: (p) => <StatusBadge tone={statusTone(p.statusLabel)}>{p.statusLabel}</StatusBadge>,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      stickyRight: true,
      cell: (p) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setArchiving(p)}>
            Archive
          </Button>
        </div>
      ),
    },
  ];

  const confirmArchive = () => {
    if (!archiving) return;
    archive.mutate(archiving.id, {
      onSuccess: () => {
        toast(`${archiving.nickname ?? archiving.addressLine1} archived.`, 'positive');
        setArchiving(null);
      },
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not archive the property.', 'danger'),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Properties"
        breadcrumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Properties' }]}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <IconPlus size={16} />
            Property
          </Button>
        }
      />

      {properties.isPending ? (
        <Card flush className="p-4">
          <Skeleton className="h-64 w-full" />
        </Card>
      ) : properties.isError ? (
        <ErrorNotice error={properties.error} onRetry={() => void properties.refetch()} />
      ) : properties.data.length === 0 ? (
        <Card flush>
          <EmptyState
            icon={<IconBuilding size={28} />}
            title="No properties yet"
            body="Add your first property to start tracking rent, expenses, and taxes."
            action={
              <Button onClick={() => setCreateOpen(true)}>
                <IconPlus size={16} />
                Add property
              </Button>
            }
          />
        </Card>
      ) : (
        <Card flush>
          <DataTable
            caption="Properties — address, units, occupancy, monthly rent, and status"
            columns={columns}
            data={properties.data}
            rowKey={(p) => p.id}
            searchPlaceholder="Search properties"
            pageSize={20}
            itemNoun={{ one: 'property', other: 'properties' }}
          />
        </Card>
      )}

      <PropertyFormModal mode="create" open={createOpen} onClose={() => setCreateOpen(false)} />
      <PropertyFormModal
        mode="edit"
        open={editing !== null}
        property={editing ?? undefined}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        onConfirm={confirmArchive}
        title="Archive property"
        confirmLabel="Archive"
        busy={archive.isPending}
        body={
          <>
            Archiving hides <strong>{archiving?.nickname ?? archiving?.addressLine1}</strong> from
            your lists but keeps its history. You can restore it later.
          </>
        }
      />
    </div>
  );
}
