// Create / edit a unit inside a property.
import { useEffect, useState, type FormEvent } from 'react';
import type { PropertyDetailUnit } from '@hearth/shared';
import { useCreateUnit, useUpdateUnit } from '../../api/queries';
import { Button } from '../ui/Button';
import { FormField, Input } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

type Mode = 'create' | 'edit';

interface FormState {
  label: string;
  bedrooms: string;
  bathrooms: string;
  marketRent: string;
}

function emptyForm(): FormState {
  return { label: '', bedrooms: '', bathrooms: '', marketRent: '' };
}

function fromUnit(u: PropertyDetailUnit): FormState {
  return {
    label: u.label,
    bedrooms: u.bedrooms != null ? String(u.bedrooms) : '',
    bathrooms: u.bathrooms != null ? String(u.bathrooms) : '',
    marketRent: u.marketRentCents != null ? (u.marketRentCents / 100).toString() : '',
  };
}

export interface UnitFormModalProps {
  open: boolean;
  onClose: () => void;
  mode: Mode;
  propertyId: string;
  /** Required in edit mode. */
  unit?: PropertyDetailUnit;
}

export function UnitFormModal({ open, onClose, mode, propertyId, unit }: UnitFormModalProps) {
  const create = useCreateUnit();
  const update = useUpdateUnit();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (open) {
      setForm(mode === 'edit' && unit ? fromUnit(unit) : emptyForm());
      setError(undefined);
    }
  }, [open, mode, unit]);

  const set = (key: keyof FormState) => (event: FormEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: (event.target as HTMLInputElement).value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.label.trim()) {
      setError('Enter a unit label.');
      return;
    }
    const marketRentCents = form.marketRent ? Math.round(Number(form.marketRent) * 100) : undefined;
    const body = {
      label: form.label.trim(),
      bedrooms: form.bedrooms !== '' ? Number(form.bedrooms) : undefined,
      bathrooms: form.bathrooms !== '' ? Number(form.bathrooms) : undefined,
      marketRentCents:
        marketRentCents != null && !Number.isNaN(marketRentCents) ? marketRentCents : undefined,
    };

    const onError = (err: unknown) =>
      toast(err instanceof Error ? err.message : 'Could not save the unit.', 'danger');

    if (mode === 'edit' && unit) {
      update.mutate(
        { id: unit.id, propertyId, ...body },
        {
          onSuccess: () => {
            toast('Unit updated.', 'positive');
            onClose();
          },
          onError,
        },
      );
      return;
    }

    create.mutate(
      { propertyId, ...body },
      {
        onSuccess: () => {
          toast('Unit added.', 'positive');
          onClose();
        },
        onError,
      },
    );
  };

  const busy = create.isPending || update.isPending;

  return (
    <Modal open={open} onClose={onClose} title={mode === 'edit' ? 'Edit unit' : 'Add unit'} size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="Unit label" htmlFor="unit-label" error={error} required>
          <Input value={form.label} onInput={set('label')} placeholder="e.g. Unit A" />
        </FormField>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Bedrooms" htmlFor="unit-beds" hint="Optional.">
            <Input type="number" min={0} value={form.bedrooms} onInput={set('bedrooms')} />
          </FormField>
          <FormField label="Bathrooms" htmlFor="unit-baths" hint="Optional.">
            <Input type="number" min={0} step="0.5" value={form.bathrooms} onInput={set('bathrooms')} />
          </FormField>
        </div>
        <FormField label="Market rent (USD / mo)" htmlFor="unit-rent" hint="Optional.">
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={form.marketRent}
            onInput={set('marketRent')}
          />
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {mode === 'edit' ? 'Save changes' : 'Add unit'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
