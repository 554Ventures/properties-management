// A property's valuation history in a modal — fetched lazily once opened
// (mirrors LeaseHistoryModal's lazy-fetch pattern). Every value is owner-
// entered and deletable (a correction of your own estimate); delete is gated
// behind the same `properties` permission as the rest of the Financing &
// value card's write controls.
import { useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type { PropertyValuation, ValuationSource } from '@hearth/shared';
import { useDeleteValuation, usePropertyValuations } from '../../api/queries';
import { formatDate } from '../../lib/format';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ErrorNotice } from '../ui/ErrorNotice';
import { Modal } from '../ui/Modal';
import { Skeleton } from '../ui/Skeleton';
import { Table, Td, Th, Tr } from '../ui/Table';
import { useToast } from '../ui/Toast';
import { IconTrash } from '../ui/icons';

const VALUATION_SOURCE_LABEL: Record<ValuationSource, string> = {
  owner_estimate: 'Owner estimate',
  appraisal: 'Appraisal',
  tax_assessment: 'Tax assessment',
  other: 'Other',
};

export interface ValuationHistoryModalProps {
  propertyId: string;
  title: string;
  canProperties: boolean;
  onClose: () => void;
}

export function ValuationHistoryModal({
  propertyId,
  title,
  canProperties,
  onClose,
}: ValuationHistoryModalProps) {
  const valuations = usePropertyValuations(propertyId);
  const deleteValuation = useDeleteValuation();
  const { toast } = useToast();
  const [deleting, setDeleting] = useState<PropertyValuation | null>(null);

  const confirmDelete = () => {
    if (!deleting) return;
    deleteValuation.mutate(
      { id: deleting.id, propertyId },
      {
        onSuccess: () => {
          toast('Valuation deleted.', 'positive');
          setDeleting(null);
        },
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not delete the valuation.', 'danger'),
      },
    );
  };

  return (
    <Modal open onClose={onClose} title={`${title} — valuation history`} size="lg">
      <div className="flex flex-col gap-4">
        {valuations.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : valuations.isError ? (
          <ErrorNotice error={valuations.error} onRetry={() => void valuations.refetch()} />
        ) : valuations.data.length === 0 ? (
          <p className="text-sm text-ink-muted">No valuations on file.</p>
        ) : (
          <Table caption={`${title} — valuation history`}>
            <thead>
              <tr>
                <Th align="right">Value</Th>
                <Th>As of</Th>
                <Th>Source</Th>
                <Th>Notes</Th>
                {canProperties && (
                  <Th align="right" stickyRight>
                    <span className="sr-only">Actions</span>
                  </Th>
                )}
              </tr>
            </thead>
            <tbody>
              {valuations.data.map((valuation) => (
                <Tr key={valuation.id}>
                  <Td align="right">{formatUsd(valuation.valueCents)}</Td>
                  <Td>{formatDate(valuation.asOfDate)}</Td>
                  <Td>{VALUATION_SOURCE_LABEL[valuation.source]}</Td>
                  <Td>{valuation.notes || <span className="text-ink-muted">—</span>}</Td>
                  {canProperties && (
                    <Td align="right" stickyRight>
                      <button
                        type="button"
                        onClick={() => setDeleting(valuation)}
                        className="rounded-md p-1.5 text-ink-muted transition-colors duration-fast hover:bg-surface-sunken hover:text-danger"
                      >
                        <IconTrash size={14} />
                        <span className="sr-only">
                          Delete valuation of {formatUsd(valuation.valueCents)} as of{' '}
                          {formatDate(valuation.asOfDate)}
                        </span>
                      </button>
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title="Delete valuation"
        confirmLabel="Delete"
        busy={deleteValuation.isPending}
        body={
          deleting && (
            <>
              This permanently deletes the {formatUsd(deleting.valueCents)} valuation as of{' '}
              {formatDate(deleting.asOfDate)}. It can&rsquo;t be restored.
            </>
          )
        }
      />
    </Modal>
  );
}
