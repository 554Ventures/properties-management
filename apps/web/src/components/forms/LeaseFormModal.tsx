// Create a lease on a vacant unit, or edit an existing lease's terms.
// Create mode collects the tenant roster (multi-select) + terms; edit mode
// edits terms only (co-tenants are managed via LeaseTenantsModal).
import { useEffect, useState, type FormEvent } from 'react';
import type { Lease } from '@hearth/shared';
import { useCreateLease, useTenants, useUpdateLease, useUploadDocument } from '../../api/queries';
import {
  AgreementFileField,
  AGREEMENT_MAX_SIZE_BYTES,
} from '../documents/AgreementFileField';
import { formatBytes, fromDateInputValue, toDateInputValue } from '../../lib/format';
import { Button } from '../ui/Button';
import { FormField, Input } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { MultiSelect } from '../ui/MultiSelect';
import { useToast } from '../ui/Toast';
import { InlineNewTenant } from './InlineNewTenant';

type Mode = 'create' | 'edit';

interface FormState {
  rent: string;
  dueDay: string;
  // Dollar string; '' = use the account default (WS7 tri-state override).
  lateFee: string;
  startDate: string;
  endDate: string;
}

function emptyForm(): FormState {
  return { rent: '', dueDay: '1', lateFee: '', startDate: '', endDate: '' };
}

function fromLease(lease: Lease): FormState {
  return {
    rent: (lease.rentCents / 100).toString(),
    dueDay: String(lease.dueDay),
    lateFee: lease.lateFeeCents == null ? '' : (lease.lateFeeCents / 100).toString(),
    startDate: toDateInputValue(lease.startDate),
    endDate: toDateInputValue(lease.endDate),
  };
}

/**
 * Tri-state late-fee override (WS7): empty field → account default (omitted
 * on create, explicitly cleared with `null` on edit — there's nothing to
 * "leave unchanged" once the field is visible and editable); 0 → no late fee
 * for this lease; positive → this fee overrides the default.
 */
function resolveLateFeeCents(raw: string, mode: Mode): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return mode === 'edit' ? null : undefined;
  return Math.round(Number(trimmed) * 100);
}

/** Re-lease starting point taken from a unit's most recent ended lease. */
export interface LeasePrefill {
  rentCents: number;
  dueDay: number;
  tenantIds: string[];
  /** Primary tenant's name, for the "prefilled from" note. */
  tenantName?: string;
}

export interface LeaseFormModalProps {
  open: boolean;
  onClose: () => void;
  mode: Mode;
  /** Create mode: the vacant unit the lease is created on. */
  unitId?: string;
  unitLabel?: string;
  suggestedRentCents?: number | null;
  /** Create mode: seed terms + tenants from the unit's previous lease. May
   *  arrive after the modal opens (lazy fetch) — applied only while the form
   *  is untouched, so it never clobbers user input. Callers should memoize. */
  prefill?: LeasePrefill | null;
  /** Edit mode: the lease being edited. */
  lease?: Lease;
}

export function LeaseFormModal({
  open,
  onClose,
  mode,
  unitId,
  unitLabel,
  suggestedRentCents,
  prefill,
  lease,
}: LeaseFormModalProps) {
  const create = useCreateLease();
  const update = useUpdateLease();
  const upload = useUploadDocument();
  const tenants = useTenants();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [agreement, setAgreement] = useState<File | null>(null);
  const [errors, setErrors] = useState<{
    rent?: string;
    lateFee?: string;
    dates?: string;
    tenants?: string;
    agreement?: string;
  }>({});
  const [dirty, setDirty] = useState(false);
  const [prefillApplied, setPrefillApplied] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && lease) {
      setForm(fromLease(lease));
    } else {
      setForm({
        ...emptyForm(),
        rent: suggestedRentCents != null ? (suggestedRentCents / 100).toString() : '',
      });
    }
    setTenantIds([]);
    setAgreement(null);
    setErrors({});
    setDirty(false);
    setPrefillApplied(false);
  }, [open, mode, lease, suggestedRentCents]);

  // Seed from the previous lease once it's known — dates stay blank (the new
  // term is always the landlord's call). Tenant ids are pruned against the
  // live tenant list so an archived tenant can't ride in invisibly.
  useEffect(() => {
    if (!open || mode !== 'create' || !prefill || dirty || prefillApplied) return;
    setForm((prev) => ({
      ...prev,
      rent: (prefill.rentCents / 100).toString(),
      dueDay: String(prefill.dueDay),
    }));
    if (tenants.data) {
      setTenantIds(prefill.tenantIds.filter((id) => tenants.data.some((t) => t.id === id)));
      setPrefillApplied(true);
    }
  }, [open, mode, prefill, dirty, prefillApplied, tenants.data]);

  const set = (key: keyof FormState) => (event: FormEvent<HTMLInputElement>) => {
    setDirty(true);
    setForm((prev) => ({ ...prev, [key]: (event.target as HTMLInputElement).value }));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const rentNumber = Number(form.rent);
    const lateFeeTrimmed = form.lateFee.trim();
    const lateFeeNumber = Number(lateFeeTrimmed);
    const next: typeof errors = {};
    if (!form.rent || Number.isNaN(rentNumber) || rentNumber <= 0) {
      next.rent = 'Enter a monthly rent greater than zero.';
    }
    if (lateFeeTrimmed !== '' && (Number.isNaN(lateFeeNumber) || lateFeeNumber < 0)) {
      next.lateFee = 'Enter a late fee of $0 or more, or leave it blank for the account default.';
    }
    if (!form.startDate || !form.endDate) {
      next.dates = 'Enter both a start and end date.';
    } else if (new Date(form.endDate) <= new Date(form.startDate)) {
      next.dates = 'The end date must be after the start date.';
    }
    if (mode === 'create' && tenantIds.length === 0) {
      next.tenants = 'Select at least one tenant.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const rentCents = Math.round(rentNumber * 100);
    const dueDay = Math.min(31, Math.max(1, Number(form.dueDay) || 1));
    const lateFeeCents = resolveLateFeeCents(form.lateFee, mode);
    const onError = (err: unknown) =>
      toast(err instanceof Error ? err.message : 'Could not save the lease.', 'danger');

    if (mode === 'edit' && lease) {
      update.mutate(
        {
          id: lease.id,
          rentCents,
          dueDay,
          lateFeeCents,
          startDate: fromDateInputValue(form.startDate),
          endDate: fromDateInputValue(form.endDate),
        },
        {
          onSuccess: () => {
            toast('Lease terms updated.', 'positive');
            onClose();
          },
          onError,
        },
      );
      return;
    }

    if (!unitId) return;
    create.mutate(
      {
        unitId,
        tenantIds,
        rentCents,
        dueDay,
        ...(lateFeeCents !== undefined ? { lateFeeCents } : {}),
        startDate: fromDateInputValue(form.startDate),
        endDate: fromDateInputValue(form.endDate),
      },
      {
        onSuccess: (created) => {
          if (!agreement) {
            toast('Lease created.', 'positive');
            onClose();
            return;
          }
          // The lease exists either way — an upload failure must not read as a
          // failed save, so it closes with a pointed follow-up instead.
          const docForm = new FormData();
          docForm.append('entityType', 'lease');
          docForm.append('entityId', created.id);
          docForm.append('type', 'lease');
          docForm.append('file', agreement);
          upload.mutate(docForm, {
            onSuccess: () => {
              toast('Lease created and agreement attached.', 'positive');
              onClose();
            },
            onError: () => {
              toast(
                'Lease created, but the agreement upload failed — attach it from the lease documents.',
                'danger',
              );
              onClose();
            },
          });
        },
        onError,
      },
    );
  };

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

  const busy = create.isPending || update.isPending || upload.isPending;
  const title = mode === 'edit' ? 'Edit lease terms' : `Create lease${unitLabel ? ` — ${unitLabel}` : ''}`;

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {mode === 'create' && (
          <div className="flex flex-col gap-2">
            <MultiSelect
              label="Tenants"
              options={(tenants.data ?? []).map((t) => ({
                value: t.id,
                label: t.fullName,
                description: t.email ?? undefined,
              }))}
              value={tenantIds}
              onChange={(ids) => {
                setDirty(true);
                setTenantIds(ids);
              }}
              loading={tenants.isPending}
              placeholder={
                (tenants.data ?? []).length === 0
                  ? 'No tenants yet — add one below'
                  : 'Search tenants…'
              }
              emptyMessage="No matching tenants."
              error={errors.tenants}
              required
            />
            <InlineNewTenant
              onCreated={(tenant) => {
                setDirty(true);
                setTenantIds((prev) => (prev.includes(tenant.id) ? prev : [...prev, tenant.id]));
              }}
            />
            {prefillApplied && !dirty && prefill && (
              <p className="text-xs text-ink-muted">
                Prefilled from the previous lease
                {prefill.tenantName ? ` (${prefill.tenantName})` : ''} — adjust anything before
                saving. Dates are intentionally blank.
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Monthly rent (USD)" htmlFor="lease-rent" error={errors.rent} required>
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              value={form.rent}
              onInput={set('rent')}
            />
          </FormField>
          <FormField label="Rent due day" htmlFor="lease-dueday" hint="Day of the month (1–31)." required>
            <Input type="number" min={1} max={31} value={form.dueDay} onInput={set('dueDay')} />
          </FormField>
        </div>

        <FormField
          label="Late fee for this lease (USD)"
          htmlFor="lease-late-fee"
          error={errors.lateFee}
          hint="Leave blank to use your account default. Enter 0 to disable late fees for this lease."
        >
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            placeholder="Account default"
            value={form.lateFee}
            onInput={set('lateFee')}
          />
        </FormField>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Start date" htmlFor="lease-start" error={errors.dates} required>
            <Input type="date" value={form.startDate} onInput={set('startDate')} />
          </FormField>
          <FormField label="End date" htmlFor="lease-end" required>
            <Input type="date" value={form.endDate} onInput={set('endDate')} />
          </FormField>
        </div>

        {mode === 'create' && (
          <AgreementFileField
            id="lease-agreement"
            file={agreement}
            error={errors.agreement}
            hint="PDF, image, or Word (.docx) — up to 10 MB. Attached to the lease as a Lease document."
            onPick={pickAgreement}
            onRemove={() => setAgreement(null)}
          />
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {mode === 'edit' ? 'Save changes' : 'Create lease'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
