import { formatUsd } from '@hearth/shared';
import type { PropertyDetailUnit } from '@hearth/shared';
import { StatusBadge } from '../ui/StatusBadge';
import { rentStatusBadge } from '../../lib/statusBadges';

const daysLabel = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

// "This month" rent snapshot badge: status word for the calm states, the
// specifics for the loud ones (partial amounts, days late).
export function RentSnapshotBadge({ rent }: { rent: NonNullable<PropertyDetailUnit['rent']> }) {
  if (rent.status === 'partial') {
    return (
      <StatusBadge tone="warning">
        {formatUsd(rent.paidCents)} of {formatUsd(rent.amountCents)}
      </StatusBadge>
    );
  }
  if (rent.status === 'late') {
    return (
      <StatusBadge tone="danger">
        {rent.daysLate != null ? `${daysLabel(rent.daysLate)} late` : 'Late'}
      </StatusBadge>
    );
  }
  const badge = rentStatusBadge[rent.status] ?? rentStatusBadge.due;
  return badge ? <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge> : null;
}
