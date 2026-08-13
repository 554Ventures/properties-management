// The identity + amount pair shared by a live review row and a settled one, so
// a row that has just been confirmed keeps the exact same header layout (and
// therefore the exact same height) as the row it replaces.
import { formatUsd } from '@hearth/shared';
import type { ReviewQueueItem } from '@hearth/shared';
import { cx } from '../../lib/cx';
import { formatDate } from '../../lib/format';

export function ReviewRowIdentity({
  item,
  propertyLabel,
}: {
  item: ReviewQueueItem;
  propertyLabel?: string | null;
}) {
  const meta = [item.vendor, formatDate(item.date), propertyLabel].filter(Boolean).join(' · ');
  return (
    <div className="min-w-0 md:flex-1">
      <p className="truncate text-sm font-medium text-ink">{item.description}</p>
      <p className="mt-0.5 truncate text-xs text-ink-muted">{meta}</p>
    </div>
  );
}

/** Income vs expense is carried by the sign glyph and a screen-reader word —
 *  the positive tint is reinforcement only (PRD §7.1). */
export function ReviewRowAmount({ item }: { item: ReviewQueueItem }) {
  const income = item.type === 'income';
  return (
    <span
      className={cx(
        'shrink-0 whitespace-nowrap text-sm font-semibold tabular-nums',
        income ? 'text-positive' : 'text-ink',
      )}
    >
      {income ? '+' : '−'}
      {formatUsd(item.amountCents)}
      <span className="sr-only"> {income ? 'income' : 'expense'}</span>
    </span>
  );
}
