// Create / edit a property. Create mode also seeds the initial units; edit
// mode omits them (units are managed via the unit endpoints on PropertyDetail).
import { useEffect, useState, type FormEvent } from 'react';
import type { Property } from '@hearth/shared';
import { useNavigate } from 'react-router-dom';
import { useCreateProperty, useUpdateProperty } from '../../api/queries';
import { fromDateInputValue, toDateInputValue } from '../../lib/format';
import { Button } from '../ui/Button';
import { FormField, Input, Textarea } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

type Mode = 'create' | 'edit';

interface FormState {
  nickname: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  acquisitionDate: string;
  acquisitionCost: string;
  notes: string;
  unitCount: string;
}

function emptyForm(): FormState {
  return {
    nickname: '',
    addressLine1: '',
    city: '',
    state: '',
    zip: '',
    acquisitionDate: '',
    acquisitionCost: '',
    notes: '',
    unitCount: '1',
  };
}

function fromProperty(p: Property): FormState {
  return {
    nickname: p.nickname ?? '',
    addressLine1: p.addressLine1,
    city: p.city,
    state: p.state,
    zip: p.zip,
    acquisitionDate: toDateInputValue(p.acquisitionDate),
    acquisitionCost: p.acquisitionCostCents != null ? (p.acquisitionCostCents / 100).toString() : '',
    notes: p.notes ?? '',
    unitCount: '1',
  };
}

export interface PropertyFormModalProps {
  open: boolean;
  onClose: () => void;
  mode: Mode;
  /** Required in edit mode. */
  property?: Property;
}

export function PropertyFormModal({ open, onClose, mode, property }: PropertyFormModalProps) {
  const create = useCreateProperty();
  const update = useUpdateProperty();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(emptyForm);

  // Reset the form whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) setForm(mode === 'edit' && property ? fromProperty(property) : emptyForm());
  }, [open, mode, property]);

  const set = (key: keyof FormState) => (event: FormEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((prev) => ({ ...prev, [key]: (event.target as HTMLInputElement).value }));

  const acquisitionCostCents = form.acquisitionCost
    ? Math.round(Number(form.acquisitionCost) * 100)
    : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const base = {
      nickname: form.nickname.trim() || undefined,
      addressLine1: form.addressLine1.trim(),
      city: form.city.trim(),
      state: form.state.trim(),
      zip: form.zip.trim(),
      acquisitionDate: form.acquisitionDate ? fromDateInputValue(form.acquisitionDate) : undefined,
      acquisitionCostCents:
        acquisitionCostCents != null && !Number.isNaN(acquisitionCostCents)
          ? acquisitionCostCents
          : undefined,
      notes: form.notes.trim() || undefined,
    };

    if (mode === 'edit' && property) {
      update.mutate(
        { id: property.id, ...base },
        {
          onSuccess: () => {
            toast('Property updated.', 'positive');
            onClose();
          },
          onError: (err) =>
            toast(err instanceof Error ? err.message : 'Could not update the property.', 'danger'),
        },
      );
      return;
    }

    const count = Math.max(1, Number(form.unitCount) || 1);
    create.mutate(
      {
        ...base,
        units: Array.from({ length: count }, (_, i) => ({
          label: count === 1 ? 'Main' : `Unit ${i + 1}`,
        })),
      },
      {
        onSuccess: (created) => {
          toast('Property added.', 'positive');
          onClose();
          navigate(`/properties/${created.id}`);
        },
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not add the property.', 'danger'),
      },
    );
  };

  const busy = create.isPending || update.isPending;

  return (
    <Modal open={open} onClose={onClose} title={mode === 'edit' ? 'Edit property' : 'Add property'}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="Nickname" htmlFor="prop-nickname" hint="Optional — e.g. “Maple duplex”.">
          <Input value={form.nickname} onInput={set('nickname')} />
        </FormField>
        <FormField label="Street address" htmlFor="prop-address" required>
          <Input
            value={form.addressLine1}
            onInput={set('addressLine1')}
            autoComplete="address-line1"
          />
        </FormField>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField label="City" htmlFor="prop-city" required>
            <Input value={form.city} onInput={set('city')} autoComplete="address-level2" />
          </FormField>
          <FormField label="State" htmlFor="prop-state" required>
            <Input value={form.state} onInput={set('state')} autoComplete="address-level1" />
          </FormField>
          <FormField label="ZIP" htmlFor="prop-zip" required>
            <Input
              value={form.zip}
              onInput={set('zip')}
              autoComplete="postal-code"
              inputMode="numeric"
            />
          </FormField>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Acquisition date" htmlFor="prop-acq-date" hint="Optional.">
            <Input type="date" value={form.acquisitionDate} onInput={set('acquisitionDate')} />
          </FormField>
          <FormField label="Acquisition cost (USD)" htmlFor="prop-acq-cost" hint="Optional.">
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={form.acquisitionCost}
              onInput={set('acquisitionCost')}
            />
          </FormField>
        </div>
        <FormField label="Notes" htmlFor="prop-notes" hint="Optional.">
          <Textarea value={form.notes} onInput={set('notes')} />
        </FormField>
        {mode === 'create' && (
          <FormField
            label="Number of units"
            htmlFor="prop-units"
            hint="Unit labels can be edited later."
            required
          >
            <Input type="number" min={1} max={50} value={form.unitCount} onInput={set('unitCount')} />
          </FormField>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {mode === 'edit' ? 'Save changes' : 'Add property'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
