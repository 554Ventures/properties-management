// The manual charge picker (rent-match v2): every open charge, radio-group
// select, for deposits the heuristic missed or attributed below the remaining
// balance. A plain user-initiated modal, not AI content.
import { useEffect, useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type { RentChargeOption } from '@hearth/shared';
import { useLeaseDetail, useOpenRentCharges } from '../../api/queries';
import { cx } from '../../lib/cx';
import { formatMonth } from '../../lib/format';
import { Button } from '../ui/Button';
import { ErrorNotice } from '../ui/ErrorNotice';
import { FormField } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
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
  /** tenantId is the co-tenant chosen in the "Paid by" field below — only
   *  offered once a charge with more than one lease tenant is selected. */
  onChoose: (option: RentChargeOption, tenantId?: string) => void;
}) {
  const openCharges = useOpenRentCharges(open);
  const [selectedId, setSelectedId] = useState('');
  const [tenantId, setTenantId] = useState('');
  const items = openCharges.data?.items ?? [];
  const selectedOption = items.find((i) => i.rentPaymentId === selectedId);
  // Fetched only once a charge is picked, keyed by that charge's lease — the
  // option list itself doesn't carry the tenant roster.
  const leaseDetail = useLeaseDetail(selectedOption?.leaseId);
  const tenants = leaseDetail.data?.lease.tenants ?? [];

  // A stale pick from a previous open shouldn't carry over.
  useEffect(() => {
    if (open) {
      setSelectedId('');
      setTenantId('');
    }
  }, [open]);

  // Switching to a different charge means a different lease's tenants — a
  // choice picked for the last charge shouldn't silently apply to this one.
  useEffect(() => {
    setTenantId('');
  }, [selectedId]);

  const confirmPick = () => {
    const option = items.find((i) => i.rentPaymentId === selectedId);
    if (option) onChoose(option, tenantId || undefined);
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
        <div className="flex flex-col gap-4">
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
          {/* Only once a multi-tenant charge is picked — a single-tenant lease
              has exactly one possible answer, so asking would be noise. */}
          {selectedOption && tenants.length > 1 && (
            <FormField
              label="Paid by"
              htmlFor="rent-charge-tenant"
              hint="Leave it blank and we'll try to tell from the deposit."
            >
              <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
                <option value="">Not recorded</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.fullName}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
        </div>
      )}
    </Modal>
  );
}
