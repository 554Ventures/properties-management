// Properties list (PRD §5.2) with a simple create-property modal.
import { useState, type FormEvent } from 'react';
import { formatUsdWhole } from '@hearth/shared';
import { Link, useNavigate } from 'react-router-dom';
import { useCreateProperty, useProperties } from '../api/queries';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { FormField, Input } from '../components/ui/FormField';
import { Modal } from '../components/ui/Modal';
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
  const [createOpen, setCreateOpen] = useState(false);

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
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <CreatePropertyModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreatePropertyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateProperty();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    nickname: '',
    addressLine1: '',
    city: '',
    state: '',
    zip: '',
    unitCount: '1',
  });

  const set = (key: keyof typeof form) => (event: FormEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: (event.target as HTMLInputElement).value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const count = Math.max(1, Number(form.unitCount) || 1);
    create.mutate(
      {
        nickname: form.nickname || undefined,
        addressLine1: form.addressLine1,
        city: form.city,
        state: form.state,
        zip: form.zip,
        units: Array.from({ length: count }, (_, i) => ({
          label: count === 1 ? 'Main' : `Unit ${i + 1}`,
        })),
      },
      {
        onSuccess: (property) => {
          toast('Property added.', 'positive');
          onClose();
          navigate(`/properties/${property.id}`);
        },
        onError: () => toast('Could not add the property. Check the fields and try again.', 'danger'),
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Add property">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="Nickname" htmlFor="prop-nickname" hint="Optional — e.g. “Maple duplex”.">
          <Input value={form.nickname} onInput={set('nickname')} />
        </FormField>
        <FormField label="Street address" htmlFor="prop-address" required>
          <Input value={form.addressLine1} onInput={set('addressLine1')} autoComplete="address-line1" />
        </FormField>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField label="City" htmlFor="prop-city" required>
            <Input value={form.city} onInput={set('city')} autoComplete="address-level2" />
          </FormField>
          <FormField label="State" htmlFor="prop-state" required>
            <Input value={form.state} onInput={set('state')} autoComplete="address-level1" />
          </FormField>
          <FormField label="ZIP" htmlFor="prop-zip" required>
            <Input value={form.zip} onInput={set('zip')} autoComplete="postal-code" inputMode="numeric" />
          </FormField>
        </div>
        <FormField
          label="Number of units"
          htmlFor="prop-units"
          hint="Unit labels can be edited later."
          required
        >
          <Input type="number" min={1} max={50} value={form.unitCount} onInput={set('unitCount')} />
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={create.isPending}>
            Add property
          </Button>
        </div>
      </form>
    </Modal>
  );
}
