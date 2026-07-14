// Renewal proposal modal — extracted from TenantDetail so PropertyDetail can
// run the same flow. Self-contained: the caller drafts the proposal (via
// useDraftRenewal) and passes it in; send-for-e-sign and accept-renewal are
// handled here with the shared mutation hooks. The suggested terms pre-fill an
// editable form, so a renewal can be accepted with adjusted rent/term/due day
// in one step (the API always took arbitrary terms — this exposes them).
import { useEffect, useState, type FormEvent } from 'react';
import { formatUsd } from '@hearth/shared';
import type { RenewalDraftResponse } from '@hearth/shared';
import { useCreateRenewal, useSendEsign, useUploadDocument } from '../../api/queries';
import {
  AgreementFileField,
  AGREEMENT_MAX_SIZE_BYTES,
} from '../documents/AgreementFileField';
import { formatBytes, formatDate, fromDateInputValue, toDateInputValue } from '../../lib/format';
import { Button } from '../ui/Button';
import { FormField, Input } from '../ui/FormField';
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

interface FormState {
  rent: string;
  dueDay: string;
  startDate: string;
  endDate: string;
}

export function RenewalModal({ draft, onClose, onDone }: RenewalModalProps) {
  const sendEsign = useSendEsign();
  const createRenewal = useCreateRenewal();
  const upload = useUploadDocument();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>({ rent: '', dueDay: '1', startDate: '', endDate: '' });
  const [agreement, setAgreement] = useState<File | null>(null);
  const [errors, setErrors] = useState<{ rent?: string; dates?: string; agreement?: string }>({});

  // Re-seed the form from each new proposal (draft is null while closed).
  useEffect(() => {
    if (!draft) return;
    setForm({
      rent: (draft.suggestedRentCents / 100).toString(),
      dueDay: String(draft.dueDay),
      startDate: toDateInputValue(draft.proposedStartDate),
      endDate: toDateInputValue(draft.proposedEndDate),
    });
    setAgreement(null);
    setErrors({});
  }, [draft]);

  const pickAgreement = (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size > AGREEMENT_MAX_SIZE_BYTES) {
      setAgreement(null);
      setErrors((prev) => ({
        ...prev,
        agreement: `That file is ${formatBytes(picked.size)} — the limit is 10 MB.`,
      }));
      return;
    }
    setAgreement(picked);
    setErrors((prev) => ({ ...prev, agreement: undefined }));
  };

  const set = (key: keyof FormState) => (event: FormEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: (event.target as HTMLInputElement).value }));

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

  const acceptRenewal = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    const rentNumber = Number(form.rent);
    const next: typeof errors = {};
    if (!form.rent || Number.isNaN(rentNumber) || rentNumber <= 0) {
      next.rent = 'Enter a monthly rent greater than zero.';
    }
    if (!form.startDate || !form.endDate) {
      next.dates = 'Enter both a start and end date.';
    } else if (new Date(form.endDate) <= new Date(form.startDate)) {
      next.dates = 'The end date must be after the start date.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    createRenewal.mutate(
      {
        leaseId: draft.leaseId,
        rentCents: Math.round(rentNumber * 100),
        dueDay: Math.min(31, Math.max(1, Number(form.dueDay) || 1)),
        startDate: fromDateInputValue(form.startDate),
        endDate: fromDateInputValue(form.endDate),
      },
      {
        onSuccess: (newLease) => {
          if (!agreement) {
            toast('Renewal accepted — the new lease is now active.', 'positive');
            onClose();
            onDone?.();
            return;
          }
          // The renewal is done either way — an upload failure must not read
          // as a failed renewal, so it closes with a pointed follow-up.
          const docForm = new FormData();
          docForm.append('entityType', 'lease');
          docForm.append('entityId', newLease.id);
          docForm.append('type', 'lease');
          docForm.append('file', agreement);
          upload.mutate(docForm, {
            onSuccess: () => {
              toast('Renewal accepted — new lease active, agreement attached.', 'positive');
              onClose();
              onDone?.();
            },
            onError: () => {
              toast(
                'Renewal accepted, but the agreement upload failed — attach it from the lease documents.',
                'danger',
              );
              onClose();
              onDone?.();
            },
          });
        },
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not create the renewal.', 'danger'),
      },
    );
  };

  return (
    <Modal open={draft !== null} onClose={onClose} title="Renewal proposal">
      {draft && (
        <form onSubmit={acceptRenewal} className="flex flex-col gap-4" noValidate>
          <Table caption="Suggested renewal terms">
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
                <Th scope="row">Suggested term</Th>
                <Td align="right">
                  {formatDate(draft.proposedStartDate)} – {formatDate(draft.proposedEndDate)}
                </Td>
              </Tr>
            </tbody>
          </Table>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Monthly rent (USD)" htmlFor="renewal-rent" error={errors.rent} required>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0.01"
                value={form.rent}
                onInput={set('rent')}
              />
            </FormField>
            <FormField
              label="Rent due day"
              htmlFor="renewal-dueday"
              hint="Day of the month (1–31)."
              required
            >
              <Input type="number" min={1} max={31} value={form.dueDay} onInput={set('dueDay')} />
            </FormField>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Start date" htmlFor="renewal-start" error={errors.dates} required>
              <Input type="date" value={form.startDate} onInput={set('startDate')} />
            </FormField>
            <FormField label="End date" htmlFor="renewal-end" required>
              <Input type="date" value={form.endDate} onInput={set('endDate')} />
            </FormField>
          </div>

          <AgreementFileField
            id="renewal-agreement"
            file={agreement}
            error={errors.agreement}
            hint="PDF, image, or Word (.docx) — up to 10 MB. Attached to the new lease when you accept (sending for e-signature doesn't upload it)."
            onPick={pickAgreement}
            onRemove={() => setAgreement(null)}
          />

          <p className="text-xs text-ink-muted">
            Send for e-signature creates a Docusign envelope (mocked here) — the tenant signs and
            the lease status updates. Accept &amp; create renewal ends the current lease
            immediately and activates the new one at the terms you set above.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="secondary" busy={sendEsign.isPending} onClick={sendForSignature}>
              Send for e-signature
            </Button>
            <Button type="submit" busy={createRenewal.isPending || upload.isPending}>
              Accept &amp; create renewal
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
