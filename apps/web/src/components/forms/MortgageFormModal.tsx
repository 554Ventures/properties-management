// Add a mortgage (PLAN-REAL-EQUITY Phase 1). Balance + as-of date are entered
// together as the initial statement checkpoint; re-checkpointing an existing
// mortgage happens on MortgageCheckpointModal instead (same balance/date pair,
// which the API requires move together — UpdateMortgageInputSchema's refine).
import { useEffect, useState, type FormEvent } from 'react';
import { useCreateMortgage } from '../../api/queries';
import { fromDateInputValue } from '../../lib/format';
import { Button } from '../ui/Button';
import { FormField, Input, Textarea } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

interface FormState {
  lender: string;
  balance: string;
  balanceAsOfDate: string;
  interestRate: string;
  originalPrincipal: string;
  startDate: string;
  escrowNote: string;
  notes: string;
}

function emptyForm(): FormState {
  return {
    lender: '',
    balance: '',
    balanceAsOfDate: '',
    interestRate: '',
    originalPrincipal: '',
    startDate: '',
    escrowNote: '',
    notes: '',
  };
}

export interface MortgageFormModalProps {
  open: boolean;
  onClose: () => void;
  propertyId: string;
}

export function MortgageFormModal({ open, onClose, propertyId }: MortgageFormModalProps) {
  const create = useCreateMortgage();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (open) {
      setForm(emptyForm());
      setError(undefined);
    }
  }, [open]);

  const set =
    (key: keyof FormState) => (event: FormEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({ ...prev, [key]: (event.target as HTMLInputElement).value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.lender.trim()) {
      setError('Enter the lender name.');
      return;
    }
    if (!form.balance || !form.balanceAsOfDate) {
      setError('Enter the statement balance and the date it was true as of.');
      return;
    }

    const originalPrincipalCents = form.originalPrincipal
      ? Math.round(Number(form.originalPrincipal) * 100)
      : undefined;
    const interestRateMilliPct = form.interestRate
      ? Math.round(Number(form.interestRate) * 1000)
      : undefined;

    create.mutate(
      {
        propertyId,
        lender: form.lender.trim(),
        balanceCents: Math.round(Number(form.balance) * 100),
        balanceAsOfDate: fromDateInputValue(form.balanceAsOfDate),
        originalPrincipalCents:
          originalPrincipalCents != null && !Number.isNaN(originalPrincipalCents)
            ? originalPrincipalCents
            : undefined,
        startDate: form.startDate ? fromDateInputValue(form.startDate) : undefined,
        interestRateMilliPct:
          interestRateMilliPct != null && !Number.isNaN(interestRateMilliPct)
            ? interestRateMilliPct
            : undefined,
        escrowNote: form.escrowNote.trim() || undefined,
        notes: form.notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast('Mortgage added.', 'positive');
          onClose();
        },
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not add the mortgage.', 'danger'),
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Add mortgage" size="md">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="Lender" htmlFor="mortgage-lender" error={error} required>
          <Input value={form.lender} onInput={set('lender')} placeholder="e.g. First National Bank" />
        </FormField>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Statement balance (USD)" htmlFor="mortgage-balance" required>
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={form.balance}
              onInput={set('balance')}
            />
          </FormField>
          <FormField label="Balance as of" htmlFor="mortgage-balance-date" required>
            <Input type="date" value={form.balanceAsOfDate} onInput={set('balanceAsOfDate')} />
          </FormField>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Interest rate (%)" htmlFor="mortgage-rate" hint="Optional — e.g. 6.375.">
            <Input
              type="number"
              inputMode="decimal"
              step="0.001"
              min="0"
              max="100"
              value={form.interestRate}
              onInput={set('interestRate')}
            />
          </FormField>
          <FormField label="Original principal (USD)" htmlFor="mortgage-original" hint="Optional.">
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={form.originalPrincipal}
              onInput={set('originalPrincipal')}
            />
          </FormField>
        </div>
        <FormField label="Loan start date" htmlFor="mortgage-start" hint="Optional.">
          <Input type="date" value={form.startDate} onInput={set('startDate')} />
        </FormField>
        <FormField
          label="Escrow note"
          htmlFor="mortgage-escrow"
          hint="Optional — e.g. what the escrow covers."
        >
          <Input value={form.escrowNote} onInput={set('escrowNote')} />
        </FormField>
        <FormField label="Notes" htmlFor="mortgage-notes" hint="Optional.">
          <Textarea value={form.notes} onInput={set('notes')} />
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={create.isPending}>
            Add mortgage
          </Button>
        </div>
      </form>
    </Modal>
  );
}
