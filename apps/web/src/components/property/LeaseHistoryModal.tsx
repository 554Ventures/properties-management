// A unit's lease history in a modal on the property page — fetched lazily via
// the existing unit-detail endpoint only once opened, rendered with the same
// LeaseHistoryTable the unit page uses.
import { Link } from 'react-router-dom';
import { useUnitDetail } from '../../api/queries';
import { buttonClasses } from '../ui/Button';
import { ErrorNotice } from '../ui/ErrorNotice';
import { Modal } from '../ui/Modal';
import { Skeleton } from '../ui/Skeleton';
import { LeaseHistoryTable } from './LeaseHistoryTable';

export interface LeaseHistoryModalProps {
  unitId: string;
  unitLabel: string;
  onClose: () => void;
}

export function LeaseHistoryModal({ unitId, unitLabel, onClose }: LeaseHistoryModalProps) {
  const detail = useUnitDetail(unitId);

  return (
    <Modal open onClose={onClose} title={`${unitLabel} — lease history`} size="lg">
      <div className="flex flex-col gap-4">
        {detail.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : detail.isError ? (
          <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} />
        ) : (
          <LeaseHistoryTable leases={detail.data.leases} unitLabel={unitLabel} />
        )}
        <div className="flex justify-end">
          <Link to={`/units/${unitId}`} className={buttonClasses('ghost', 'sm')}>
            Full unit record →
          </Link>
        </div>
      </div>
    </Modal>
  );
}
