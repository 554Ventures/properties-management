// Renewal proposal modal — extracted from TenantDetail so PropertyDetail can
// run the same flow. Self-contained: the caller drafts the proposal (via
// useDraftRenewal) and passes it in; send-for-e-sign and accept-renewal are
// handled here with the shared mutation hooks.
import { formatUsd } from '@hearth/shared';
import type { RenewalDraftResponse } from '@hearth/shared';
import { useCreateRenewal, useSendEsign } from '../../api/queries';
import { formatDate } from '../../lib/format';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Table, Td, Th, Tr } from '../ui/Table';
import { useToast } from '../ui/Toast';

export interface RenewalModalProps {
  /** The drafted proposal; null keeps the modal closed. */
  draft: RenewalDraftResponse | null;
  onClose: () => void;
  /** Called after a successful send/accept, once the modal has closed. */
  onDone?: () => void;
}

export function RenewalModal({ draft, onClose, onDone }: RenewalModalProps) {
  const sendEsign = useSendEsign();
  const createRenewal = useCreateRenewal();
  const { toast } = useToast();

  const sendForSignature = () => {
    if (!draft) return;
    sendEsign.mutate(draft.leaseId, {
      onSuccess: (envelope) => {
        toast(`Renewal sent for e-signature (envelope ${envelope.envelopeId}).`, 'positive');
        onClose();
        onDone?.();
      },
      onError: () => toast('Could not send for e-signature. Try again.', 'danger'),
    });
  };

  const acceptRenewal = () => {
    if (!draft) return;
    createRenewal.mutate(
      {
        leaseId: draft.leaseId,
        rentCents: draft.suggestedRentCents,
        dueDay: draft.dueDay,
        startDate: draft.proposedStartDate,
        endDate: draft.proposedEndDate,
      },
      {
        onSuccess: () => {
          toast('Renewal accepted — the new lease is now active.', 'positive');
          onClose();
          onDone?.();
        },
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not create the renewal.', 'danger'),
      },
    );
  };

  return (
    <Modal open={draft !== null} onClose={onClose} title="Renewal proposal">
      {draft && (
        <div className="flex flex-col gap-4">
          <Table caption="Proposed renewal terms">
            <tbody>
              <Tr>
                <Th scope="row">Current rent</Th>
                <Td align="right">{formatUsd(draft.currentRentCents)}/mo</Td>
              </Tr>
              <Tr>
                <Th scope="row">Suggested rent</Th>
                <Td align="right" className="font-semibold">
                  {formatUsd(draft.suggestedRentCents)}/mo
                </Td>
              </Tr>
              {draft.marketRentCents != null && (
                <Tr>
                  <Th scope="row">Market rent</Th>
                  <Td align="right">{formatUsd(draft.marketRentCents)}/mo</Td>
                </Tr>
              )}
              <Tr>
                <Th scope="row">Proposed term</Th>
                <Td align="right">
                  {formatDate(draft.proposedStartDate)} – {formatDate(draft.proposedEndDate)}
                </Td>
              </Tr>
              <Tr>
                <Th scope="row">Rent due day</Th>
                <Td align="right">{draft.dueDay}</Td>
              </Tr>
            </tbody>
          </Table>
          <p className="text-xs text-ink-muted">
            Send for e-signature creates a Docusign envelope (mocked here) — the tenant signs and
            the lease status updates. Accept &amp; create renewal ends the current lease
            immediately and activates the new one at the terms above.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="secondary" busy={sendEsign.isPending} onClick={sendForSignature}>
              Send for e-signature
            </Button>
            <Button busy={createRenewal.isPending} onClick={acceptRenewal}>
              Accept &amp; create renewal
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
