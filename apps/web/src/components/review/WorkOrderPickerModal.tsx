// The manual "Link to work order…" picker — the expense-side mirror of
// RentChargePickerModal: every open work order, radio-group select, fed by
// GET /work-orders?openOnly=true. A plain user-initiated modal, not AI
// content. Linking inherits the work order's property/unit onto the
// transaction (blanks only) the same way a rent link does from a lease.
import { useEffect, useState } from 'react';
import type { WorkOrderListRow } from '@hearth/shared';
import { useOpenWorkOrders } from '../../api/queries';
import { formatCalendarDate } from '../../lib/format';
import { Button } from '../ui/Button';
import { ErrorNotice } from '../ui/ErrorNotice';
import { Modal } from '../ui/Modal';
import { Skeleton } from '../ui/Skeleton';

export function WorkOrderPickerModal({
  open,
  onClose,
  onChoose,
}: {
  open: boolean;
  onClose: () => void;
  onChoose: (workOrder: WorkOrderListRow) => void;
}) {
  const openWorkOrders = useOpenWorkOrders(open);
  const [selectedId, setSelectedId] = useState('');
  const items = openWorkOrders.data ?? [];

  // A stale pick from a previous open shouldn't carry over.
  useEffect(() => {
    if (open) setSelectedId('');
  }, [open]);

  const confirmPick = () => {
    const option = items.find((i) => i.id === selectedId);
    if (option) onChoose(option);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Link to a work order"
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
      {openWorkOrders.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : openWorkOrders.isError ? (
        <ErrorNotice error={openWorkOrders.error} onRetry={() => void openWorkOrders.refetch()} />
      ) : items.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No open work orders to link to — create one from the Maintenance section first.
        </p>
      ) : (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-2 text-sm font-medium text-ink">Choose a work order</legend>
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {items.map((item) => (
              <label
                key={item.id}
                className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-sunken"
              >
                <input
                  type="radio"
                  name="work-order-option"
                  value={item.id}
                  checked={selectedId === item.id}
                  onChange={() => setSelectedId(item.id)}
                  className="mt-0.5 h-4 w-4 border-border-strong text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
                />
                <span className="text-ink">
                  {item.title} — {item.propertyLabel}
                  {item.unitLabel ? ` · ${item.unitLabel}` : ''}
                  {item.contractorName ? ` — ${item.contractorName}` : ''}
                  {item.scheduledFor ? ` — scheduled ${formatCalendarDate(item.scheduledFor)}` : ''}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </Modal>
  );
}
