// Create a lease on a vacant unit, or edit an existing lease's terms.
// Create mode collects the tenant roster (multi-select) + terms; edit mode
// edits terms only (co-tenants are managed via LeaseTenantsModal).
import { useEffect, useState, type FormEvent } from 'react';
import type { Lease } from '@hearth/shared';
import { useCreateLease, useTenants, useUpdateLease } from '../../api/queries';
import { fromDateInputValue, toDateInputValue } from '../../lib/format';
import { Button } from '../ui/Button';
import { FormField, Input } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { MultiSelect } from '../ui/MultiSelect';
import { useToast } from '../ui/Toast';
import { InlineNewTenant } from './InlineNewTenant';

type Mode = 'create' | 'edit';

interface FormState {
  rent: string;
  dueDay: string;
  startDate: string;
  endDate: string;
}

function emptyForm(): FormState {
  return { rent: '', dueDay: '1', startDate: '', endDate: '' };
}

function fromLease(lease: Lease): FormState {
  return {
    rent: (lease.rentCents / 100).toString(),
    dueDay: String(lease.dueDay),
    startDate: toDateInputValue(lease.startDate),
    endDate: toDateInputValue(lease.endDate),
  };
}

export interface LeaseFormModalProps {
  open: boolean;
  onClose: () => void;
  mode: Mode;
  /** Create mode: the vacant unit the lease is created on. */
  unitId?: string;
  unitLabel?: string;
  suggestedRentCents?: number | null;
  /** Edit mode: the lease being edited. */
  lease?: Lease;
}

export function LeaseFormModal({
  open,
  onClose,
  mode,
  unitId,
  unitLabel,
  suggestedRentCents,
  lease,
}: LeaseFormModalProps) {
  const create = useCreateLease();
  const update = useUpdateLease();
  const tenants = useTenants();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<{ rent?: string; dates?: string; tenants?: string }>({});

  useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && lease) {
      setForm(fromLease(lease));
    } else {
      setForm({
        ...emptyForm(),
        rent: suggestedRentCents != null ? (suggestedRentCents / 100).toString() : '',
      });
    }
    setTenantIds([]);
    setErrors({});
  }, [open, mode, lease, suggestedRentCents]);

  const set = (key: keyof FormState) => (event: FormEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: (event.target as HTMLInputElement).value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const rentNumber = Number(form.rent);
    const next: typeof errors = {};
    if (!form.rent || Number.isNaN(rentNumber) || rentNumber <= 0) {
      next.rent = 'Enter a monthly rent greater than zero.';
    }
    if (!form.startDate || !form.endDate) {
      next.dates = 'Enter both a start and end date.';
    } else if (new Date(form.endDate) <= new Date(form.startDate)) {
      next.dates = 'The end date must be after the start date.';
    }
    if (mode === 'create' && tenantIds.length === 0) {
      next.tenants = 'Select at least one tenant.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const rentCents = Math.round(rentNumber * 100);
    const dueDay = Math.min(31, Math.max(1, Number(form.dueDay) || 1));
    const onError = (err: unknown) =>
      toast(err instanceof Error ? err.message : 'Could not save the lease.', 'danger');

    if (mode === 'edit' && lease) {
      update.mutate(
        {
          id: lease.id,
          rentCents,
          dueDay,
          startDate: fromDateInputValue(form.startDate),
          endDate: fromDateInputValue(form.endDate),
        },
        {
          onSuccess: () => {
            toast('Lease terms updated.', 'positive');
            onClose();
          },
          onError,
        },
      );
      return;
    }

    if (!unitId) return;
    create.mutate(
      {
        unitId,
        tenantIds,
        rentCents,
        dueDay,
        startDate: fromDateInputValue(form.startDate),
        endDate: fromDateInputValue(form.endDate),
      },
      {
        onSuccess: () => {
          toast('Lease created.', 'positive');
          onClose();
        },
        onError,
      },
    );
  };

  const busy = create.isPending || update.isPending;
  const title = mode === 'edit' ? 'Edit lease terms' : `Create lease${unitLabel ? ` — ${unitLabel}` : ''}`;

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {mode === 'create' && (
          <div className="flex flex-col gap-2">
            <MultiSelect
              label="Tenants"
              options={(tenants.data ?? []).map((t) => ({
                value: t.id,
                label: t.fullName,
                description: t.email ?? undefined,
              }))}
              value={tenantIds}
              onChange={setTenantIds}
              loading={tenants.isPending}
              placeholder={
                (tenants.data ?? []).length === 0
                  ? 'No tenants yet — add one below'
                  : 'Search tenants…'
              }
              emptyMessage="No matching tenants."
              error={errors.tenants}
              required
            />
            <InlineNewTenant
              onCreated={(tenant) =>
                setTenantIds((prev) => (prev.includes(tenant.id) ? prev : [...prev, tenant.id]))
              }
            />
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Monthly rent (USD)" htmlFor="lease-rent" error={errors.rent} required>
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              value={form.rent}
              onInput={set('rent')}
            />
          </FormField>
          <FormField label="Rent due day" htmlFor="lease-dueday" hint="Day of the month (1–31)." required>
            <Input type="number" min={1} max={31} value={form.dueDay} onInput={set('dueDay')} />
          </FormField>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Start date" htmlFor="lease-start" error={errors.dates} required>
            <Input type="date" value={form.startDate} onInput={set('startDate')} />
          </FormField>
          <FormField label="End date" htmlFor="lease-end" required>
            <Input type="date" value={form.endDate} onInput={set('endDate')} />
          </FormField>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {mode === 'edit' ? 'Save changes' : 'Create lease'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
