// A row that has just been confirmed or dismissed, held in place.
//
// Why it exists: once queue rows are ~72px, clearing the queue becomes a
// rhythm, and removing the row you just acted on slides the next row's Confirm
// button up under a stationary cursor — which is exactly how an accidental
// double-confirm happens. So the successful write does NOT remove the row: it
// swaps it for this settled card at the same index, pinned to the height the
// live card had (`minHeight`, measured before the swap), so no pixel below it
// moves. MoneyReview drops the settled rows only once the pointer (or focus)
// has left the queue — see `flushSettled` there.
import { useEffect, useRef } from 'react';
import type { ReviewQueueItem } from '@hearth/shared';
import { Card } from '../ui/Card';
import { StatusBadge } from '../ui/StatusBadge';
import { ReviewRowAmount, ReviewRowIdentity } from './ReviewRowIdentity';

export type SettledOutcome = 'confirmed' | 'dismissed';

export function ReviewSettledCard({
  item,
  outcome,
  label,
  minHeight,
  propertyLabel,
}: {
  item: ReviewQueueItem;
  outcome: SettledOutcome;
  /** Names the outcome, e.g. "Confirmed as Supplies". */
  label: string;
  minHeight: number;
  propertyLabel?: string | null;
}) {
  // The control that had focus (Confirm/Dismiss) just unmounted; move focus
  // here so a keyboard user lands on the outcome instead of the document body.
  const statusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    statusRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <Card flush className="overflow-hidden" style={minHeight ? { minHeight } : undefined}>
      <div className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:gap-4">
        <ReviewRowIdentity item={item} propertyLabel={propertyLabel} />
        <div className="flex items-center justify-between gap-3 md:justify-end">
          <ReviewRowAmount item={item} />
          <div
            ref={statusRef}
            tabIndex={-1}
            className="flex flex-col items-start gap-0.5 md:items-end"
          >
            <StatusBadge tone={outcome === 'confirmed' ? 'positive' : 'neutral'}>
              {label}
            </StatusBadge>
            <span className="text-xs text-ink-faint">Leaves the queue when you move away.</span>
          </div>
        </div>
      </div>
    </Card>
  );
}
