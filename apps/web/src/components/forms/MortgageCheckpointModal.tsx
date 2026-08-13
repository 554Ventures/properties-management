// Re-checkpoint an existing mortgage's statement balance (PLAN-REAL-EQUITY
// §2/§3): the current balance is derived from this checkpoint, never edited
// directly. balanceCents and balanceAsOfDate always submit together — the API
// rejects one without the other (UpdateMortgageInputSchema's refine).
import { useEffect, useState, type FormEvent } from 'react';
import type { Mortgage } from '@hearth/shared';
import { useUpdateMortgage } from '../../api/queries';
import { fromDateInputValue, toDateInputValue } from '../../lib/format';
import { Button } from '../ui/Button';
import { FormField, Input } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

export interface MortgageCheckpointModalProps {
  open: boolean;
  onClose: () => void;
  propertyId: string;
  mortgage: Mortgage;
}

export function MortgageCheckpointModal({
  open,
  onClose,
  propertyId,
  mortgage,
}: MortgageCheckpointModalProps) {
  const update = useUpdateMortgage();
  const { toast } = useToast();
  const [balance, setBalance] = useState('');
  const [asOfDate, setAsOfDate] = useState('');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (open) {
      // Both fields default to *today's* picture: the balance shown on the card
      // (derived as of now) as of today's date. Keeping the previous
      // checkpoint's date here would re-date today's balance to back then, and
      // once principal payments exist the derivation would subtract them a
      // second time — a silently shrinking balance.
      setBalance((mortgage.currentBalanceCents / 100).toString());
      setAsOfDate(toDateInputValue(new Date().toISOString()));
      setError(undefined);
    }
  }, [open, mortgage]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!balance || !asOfDate) {
      setError('Enter the new balance and the date it was true as of.');
      return;
    }
    update.mutate(
      {
        id: mortgage.id,
        propertyId,
        balanceCents: Math.round(Number(balance) * 100),
        balanceAsOfDate: fromDateInputValue(asOfDate),
      },
      {
        onSuccess: () => {
          toast('Mortgage balance updated.', 'positive');
          onClose();
        },
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not update the balance.', 'danger'),
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title={`Update balance — ${mortgage.lender}`} size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-ink-muted">
          Enter the new statement balance and the date it was true as of — this replaces the last
          checkpoint.
        </p>
        <FormField
          label="New balance (USD)"
          htmlFor="mortgage-checkpoint-balance"
          error={error}
          required
        >
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={balance}
            onInput={(e) => setBalance((e.target as HTMLInputElement).value)}
          />
        </FormField>
        <FormField label="Balance as of" htmlFor="mortgage-checkpoint-date" required>
          <Input
            type="date"
            value={asOfDate}
            onInput={(e) => setAsOfDate((e.target as HTMLInputElement).value)}
          />
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={update.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
