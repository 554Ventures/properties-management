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
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge, type BadgeTone } from '../components/ui/StatusBadge';
import { Table, Td, Th, Tr } from '../components/ui/Table';
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
          <Table caption="Properties — address, units, occupancy, monthly rent, and status">
            <thead>
              <tr>
                <Th>Property</Th>
                <Th>Units</Th>
                <Th>Occupancy</Th>
                <Th align="right">Rent / mo</Th>
                <Th>Status</Th>
                <Th align="right" stickyRight>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {properties.data.map((property) => (
                <Tr key={property.id} hover>
                  <Td>
                    <Link
                      to={`/properties/${property.id}`}
                      className="font-medium text-ink transition-colors duration-fast hover:text-brand"
                    >
                      {property.nickname ?? property.addressLine1}
                    </Link>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {property.nickname ? `${property.addressLine1} · ` : ''}
                      {property.city}, {property.state} {property.zip}
                    </p>
                  </Td>
                  <Td>{property.unitCount}</Td>
                  <Td>
                    {property.occupiedCount}/{property.unitCount} occupied
                  </Td>
                  <Td align="right">{formatUsdWhole(property.monthlyRentCents)}</Td>
                  <Td>
                    <StatusBadge tone={statusTone(property.statusLabel)}>
                      {property.statusLabel}
                    </StatusBadge>
                  </Td>
                  <Td align="right" stickyRight>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(property)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setArchiving(property)}>
                        Archive
                      </Button>
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
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
