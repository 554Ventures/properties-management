// Log a manual job for a contractor. This creates a REAL confirmed expense
// transaction server-side (vendor = contractor name) — there is no separate
// job entity (ARCHITECTURE §4 / packages/shared/src/schemas/contractor.ts).
//
// Two-step UX in the same modal: the form submits and either succeeds
// outright, or the server comes back with a short list of possible-duplicate
// expenses (advisory only, never auto-applied — mirrors the review queue's
// rent-match suggestion). Step 2 shows those candidates; the user either goes
// back to adjust the form or resubmits with confirmDuplicate: true.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { formatUsd, LogContractorJobInputSchema } from '@hearth/shared';
import type { ContractorJobRow, LogContractorJobInput } from '@hearth/shared';
import { useLogContractorJob, useProperties } from '../../api/queries';
import { formatDate } from '../../lib/format';
import { Button } from '../ui/Button';
import { FormField, Input } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { StatusBadge } from '../ui/StatusBadge';
import { useToast } from '../ui/Toast';

type Step = 'form' | 'duplicates';

// Modal's own focus trap only runs on open (it can't see this component's
// internal step changes), so swapping the DOM subtree between steps drops
// focus to <body> and the trap silently stops containing Tab. Re-focus the
// new step's first control ourselves whenever it changes.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface FormState {
  date: string;
  description: string;
  amount: string;
  propertyId: string;
}

type FieldErrors = Partial<Record<'date' | 'description' | 'amount', string>>;

const FIELD_MESSAGES: Record<keyof FieldErrors, string> = {
  date: 'Enter a valid date.',
  description: 'Enter a short description of the job.',
  amount: 'Enter an amount greater than zero.',
};

function todayInputValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function emptyForm(): FormState {
  return { date: todayInputValue(), description: '', amount: '', propertyId: '' };
}

export interface LogJobModalProps {
  open: boolean;
  onClose: () => void;
  contractorId: string;
  contractorName: string;
}

export function LogJobModal({ open, onClose, contractorId, contractorName }: LogJobModalProps) {
  const logJob = useLogContractorJob();
  const properties = useProperties();
  const { toast } = useToast();

  const [step, setStep] = useState<Step>('form');
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [duplicates, setDuplicates] = useState<ContractorJobRow[]>([]);
  const [pendingInput, setPendingInput] = useState<LogContractorJobInput | null>(null);
  const stepRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setForm(emptyForm());
      setErrors({});
      setStep('form');
      setDuplicates([]);
      setPendingInput(null);
    }
  }, [open]);

  // Runs on every step change except the initial open (step is already 'form'
  // by the time this mounts, so Modal's own open-focus effect owns that case).
  useEffect(() => {
    stepRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [step]);

  const set = (key: keyof FormState) => (event: FormEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: (event.target as HTMLInputElement).value }));

  const onError = (err: unknown) =>
    toast(err instanceof Error ? err.message : 'Could not log the job.', 'danger');

  const runMutation = (input: LogContractorJobInput) => {
    logJob.mutate(
      { contractorId, ...input },
      {
        onSuccess: (response) => {
          if (response.status === 'created') {
            toast('Job logged.', 'positive');
            onClose();
          } else {
            setDuplicates(response.duplicates);
            setPendingInput(input);
            setStep('duplicates');
          }
        },
        onError,
      },
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();

    const amountNumber = Number(form.amount);
    const raw = {
      date: form.date ? new Date(`${form.date}T12:00:00`).toISOString() : '',
      description: form.description.trim(),
      amountCents:
        form.amount.trim() === '' || Number.isNaN(amountNumber)
          ? Number.NaN
          : Math.round(amountNumber * 100),
      propertyId: form.propertyId || undefined,
    };
    const parsed = LogContractorJobInputSchema.safeParse(raw);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const next: FieldErrors = {};
      if (fieldErrors.date?.length) next.date = FIELD_MESSAGES.date;
      if (fieldErrors.description?.length) next.description = FIELD_MESSAGES.description;
      if (fieldErrors.amountCents?.length) next.amount = FIELD_MESSAGES.amount;
      setErrors(next);
      return;
    }
    setErrors({});
    runMutation(parsed.data);
  };

  const logAnyway = () => {
    if (!pendingInput) return;
    runMutation({ ...pendingInput, confirmDuplicate: true });
  };

  return (
    <Modal open={open} onClose={onClose} title="Log a job" size="sm">
      <div ref={stepRef}>
        {step === 'form' ? (
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <FormField label="Date" htmlFor="job-date" error={errors.date} required>
              <Input type="date" value={form.date} onInput={set('date')} />
            </FormField>
            <FormField
              label="Description"
              htmlFor="job-description"
              error={errors.description}
              required
            >
              <Input
                value={form.description}
                onInput={set('description')}
                placeholder="e.g. Fixed leaking pipe under kitchen sink"
              />
            </FormField>
            <FormField label="Amount (USD)" htmlFor="job-amount" error={errors.amount} required>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0.01"
                value={form.amount}
                onInput={set('amount')}
              />
            </FormField>
            <FormField
              label="Property"
              htmlFor="job-property"
              hint="Leave blank for portfolio-level jobs."
            >
              <Select
                value={form.propertyId}
                onChange={(e) => setForm((prev) => ({ ...prev, propertyId: e.target.value }))}
              >
                <option value="">Portfolio (no property)</option>
                {(properties.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nickname ?? p.addressLine1}
                  </option>
                ))}
              </Select>
            </FormField>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" busy={logJob.isPending}>
                Log job
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <StatusBadge tone="warning">Possible duplicate</StatusBadge>
            <p className="text-sm text-ink">
              This looks similar to {duplicates.length} existing expense
              {duplicates.length === 1 ? '' : 's'} for {contractorName}:
            </p>
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border-strong">
              {duplicates.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
                >
                  <div>
                    <p className="text-ink">{d.description}</p>
                    <p className="text-xs text-ink-muted">{formatDate(d.date)}</p>
                  </div>
                  <span className="font-medium text-ink">{formatUsd(d.amountCents)}</span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setStep('form')}>
                Cancel
              </Button>
              <Button busy={logJob.isPending} onClick={logAnyway}>
                Log anyway
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
