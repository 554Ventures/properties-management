// Record a property valuation (PLAN-REAL-EQUITY §2) — append-only, owner-
// entered history; the PRD excludes external estimate integrations, so every
// value must say where it came from (source) and never imply market data.
import { useEffect, useState, type FormEvent } from 'react';
import type { ValuationSource } from '@hearth/shared';
import { useCreateValuation } from '../../api/queries';
import { fromDateInputValue, toDateInputValue } from '../../lib/format';
import { Button } from '../ui/Button';
import { FormField, Input, Textarea } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { useToast } from '../ui/Toast';

const SOURCE_OPTIONS: Array<{ value: ValuationSource; label: string }> = [
  { value: 'owner_estimate', label: 'Owner estimate' },
  { value: 'appraisal', label: 'Appraisal' },
  { value: 'tax_assessment', label: 'Tax assessment' },
  { value: 'other', label: 'Other' },
];

interface FormState {
  value: string;
  asOfDate: string;
  source: ValuationSource;
  notes: string;
}

function emptyForm(): FormState {
  return { value: '', asOfDate: '', source: 'owner_estimate', notes: '' };
}

export interface ValuationFormModalProps {
  open: boolean;
  onClose: () => void;
  propertyId: string;
}

export function ValuationFormModal({ open, onClose, propertyId }: ValuationFormModalProps) {
  const create = useCreateValuation();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (open) {
      setForm(emptyForm());
      setError(undefined);
    }
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.value || !form.asOfDate) {
      setError('Enter a value and the date it applies as of.');
      return;
    }
    create.mutate(
      {
        propertyId,
        valueCents: Math.round(Number(form.value) * 100),
        asOfDate: fromDateInputValue(form.asOfDate),
        source: form.source,
        notes: form.notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast('Value recorded.', 'positive');
          onClose();
        },
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not record the value.', 'danger'),
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Record value" size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-xs text-ink-muted">
          Every value here is owner-entered — nothing is pulled from a market estimate.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Value (USD)" htmlFor="valuation-value" error={error} required>
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={form.value}
              onInput={(e) =>
                setForm((prev) => ({ ...prev, value: (e.target as HTMLInputElement).value }))
              }
            />
          </FormField>
          <FormField label="As of" htmlFor="valuation-date" required>
            <Input
              type="date"
              // A future date would save fine and then vanish: the figure in
              // use is the latest one dated on or before today.
              max={toDateInputValue(new Date().toISOString())}
              value={form.asOfDate}
              onInput={(e) =>
                setForm((prev) => ({ ...prev, asOfDate: (e.target as HTMLInputElement).value }))
              }
            />
          </FormField>
        </div>
        <FormField label="Source" htmlFor="valuation-source" required>
          <Select
            value={form.source}
            onChange={(e) =>
              setForm((prev) => ({ ...prev, source: e.target.value as ValuationSource }))
            }
          >
            {SOURCE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Notes" htmlFor="valuation-notes" hint="Optional.">
          <Textarea
            value={form.notes}
            onInput={(e) =>
              setForm((prev) => ({ ...prev, notes: (e.target as HTMLTextAreaElement).value }))
            }
          />
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={create.isPending}>
            Record value
          </Button>
        </div>
      </form>
    </Modal>
  );
}
