// The manual charge picker (rent-match v2): every open charge, radio-group
// select, for deposits the heuristic missed or attributed below the remaining
// balance. A plain user-initiated modal, not AI content.
import { useEffect, useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type { RentChargeOption } from '@hearth/shared';
import { useOpenRentCharges } from '../../api/queries';
import { cx } from '../../lib/cx';
import { formatMonth } from '../../lib/format';
import { Button } from '../ui/Button';
import { ErrorNotice } from '../ui/ErrorNotice';
import { Modal } from '../ui/Modal';
import { Skeleton } from '../ui/Skeleton';

export function RentChargePickerModal({
  open,
  onClose,
  amountCents,
  onChoose,
}: {
  open: boolean;
  onClose: () => void;
  amountCents: number;
  onChoose: (option: RentChargeOption) => void;
}) {
  const openCharges = useOpenRentCharges(open);
  const [selectedId, setSelectedId] = useState('');
  const items = openCharges.data?.items ?? [];

  // A stale pick from a previous open shouldn't carry over.
  useEffect(() => {
    if (open) setSelectedId('');
  }, [open]);

  const confirmPick = () => {
    const option = items.find((i) => i.rentPaymentId === selectedId);
    if (option) onChoose(option);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Link to a rent charge"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!selectedId} onClick={confirmPick}>
            Link
          </Button>
        </>
      }
    >
      {openCharges.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : openCharges.isError ? (
        <ErrorNotice error={openCharges.error} onRetry={() => void openCharges.refetch()} />
      ) : items.length === 0 ? (
        <p className="text-sm text-ink-muted">No open rent charges to link to.</p>
      ) : (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-2 text-sm font-medium text-ink">Choose a charge</legend>
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {items.map((option) => {
              const disabled = option.remainingCents < amountCents;
              // The note lives outside the <label> (not as a sibling text
              // node inside it) so the radio's accessible name stays just the
              // option itself; aria-describedby still surfaces the note to
              // assistive tech, and it's rendered as visible text either way
              // (never color alone).
              const noteId = `rent-charge-note-${option.rentPaymentId}`;
              return (
                <div
                  key={option.rentPaymentId}
                  className={cx(
                    'flex flex-col gap-0.5 rounded-md border border-border px-3 py-2 text-sm',
                    disabled ? 'opacity-60' : 'hover:bg-surface-sunken',
                  )}
                >
                  <label className={cx('flex items-start gap-2', disabled ? '' : 'cursor-pointer')}>
                    <input
                      type="radio"
                      name="rent-charge-option"
                      value={option.rentPaymentId}
                      checked={selectedId === option.rentPaymentId}
                      disabled={disabled}
                      aria-describedby={disabled ? noteId : undefined}
                      onChange={() => setSelectedId(option.rentPaymentId)}
                      className="mt-0.5 h-4 w-4 border-border-strong text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
                    />
                    <span className="text-ink">
                      {option.tenantName} — {formatMonth(option.period)} — {option.propertyLabel} ·{' '}
                      {option.unitLabel} — {formatUsd(option.remainingCents)} remaining
                    </span>
                  </label>
                  {disabled && (
                    <p id={noteId} className="ml-6 text-xs text-warning">
                      deposit exceeds remaining
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      )}
    </Modal>
  );
}
