// Create / edit a contractor in the maintenance directory.
//
// Edit mode prefills from the list row; blanking an optional field sends an
// explicit null in the PATCH body, which clears the stored value.
import { useEffect, useState, type FormEvent } from 'react';
import { CreateContractorInputSchema, UpdateContractorInputSchema } from '@hearth/shared';
import type { Contractor, CreateContractorInput, UpdateContractorInput } from '@hearth/shared';
import { useCreateContractor, useUpdateContractor } from '../../api/queries';
import { Button } from '../ui/Button';
import { FormField, Input, Textarea } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

type Mode = 'create' | 'edit';

const TRADE_SUGGESTIONS = [
  'Plumbing',
  'Roofing',
  'Painting',
  'Handyman',
  'HVAC',
  'Electrical',
  'Landscaping',
  'Cleaning',
];

interface FormState {
  name: string;
  trade: string;
  rating: string;
  phone: string;
  email: string;
  website: string;
  notes: string;
}

/**
 * The subset the form prefills from — the common shape of the full Contractor
 * and a ContractorListRow, so either satisfies the `contractor` prop without
 * duplicating the contract.
 */
export type ContractorFormSource = Pick<
  Contractor,
  'id' | 'name' | 'trade' | 'rating' | 'phone' | 'email' | 'website' | 'notes'
>;

type FieldErrors = Partial<Record<'name' | 'trade' | 'rating' | 'email', string>>;

// Friendly per-field messages for the shared-schema validation failures the
// form can produce (missing name/trade, rating out of 1–5, malformed email).
const FIELD_MESSAGES: FieldErrors = {
  name: 'Enter the contractor’s name.',
  trade: 'Enter their trade.',
  rating: 'Rating must be between 1 and 5.',
  email: 'Enter a valid email address.',
};

function emptyForm(): FormState {
  return { name: '', trade: '', rating: '', phone: '', email: '', website: '', notes: '' };
}

function fromContractor(c: ContractorFormSource): FormState {
  return {
    name: c.name,
    trade: c.trade,
    rating: c.rating != null ? String(c.rating) : '',
    phone: c.phone ?? '',
    email: c.email ?? '',
    website: c.website ?? '',
    notes: c.notes ?? '',
  };
}

export interface ContractorFormModalProps {
  open: boolean;
  onClose: () => void;
  mode: Mode;
  /** Required in edit mode. */
  contractor?: ContractorFormSource;
}

export function ContractorFormModal({ open, onClose, mode, contractor }: ContractorFormModalProps) {
  const create = useCreateContractor();
  const update = useUpdateContractor();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<FieldErrors>({});

  useEffect(() => {
    if (open) {
      setForm(mode === 'edit' && contractor ? fromContractor(contractor) : emptyForm());
      setErrors({});
    }
  }, [open, mode, contractor]);

  const set = (key: keyof FormState) => (event: FormEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((prev) => ({ ...prev, [key]: (event.target as HTMLInputElement).value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();

    // Validated against the shared contract before the request goes out. On
    // create, blank optional fields are omitted (undefined keys drop out of
    // the JSON); on edit they become explicit nulls, which clear the stored
    // value per the PATCH contract.
    const emptyTo = mode === 'edit' ? null : undefined;
    const raw = {
      name: form.name.trim(),
      trade: form.trade.trim(),
      rating: form.rating.trim() === '' ? emptyTo : Number(form.rating),
      phone: form.phone.trim() || emptyTo,
      email: form.email.trim() || emptyTo,
      website: form.website.trim() || emptyTo,
      notes: form.notes.trim() || emptyTo,
    };
    const parsed =
      mode === 'edit'
        ? UpdateContractorInputSchema.safeParse(raw)
        : CreateContractorInputSchema.safeParse(raw);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const next: FieldErrors = {};
      for (const key of Object.keys(FIELD_MESSAGES) as (keyof FieldErrors)[]) {
        if (fieldErrors[key]?.length) next[key] = FIELD_MESSAGES[key];
      }
      setErrors(next);
      return;
    }
    setErrors({});

    const onError = (err: unknown) =>
      toast(err instanceof Error ? err.message : 'Could not save the contractor.', 'danger');

    if (mode === 'edit' && contractor) {
      update.mutate(
        { id: contractor.id, ...(parsed.data as UpdateContractorInput) },
        {
          onSuccess: () => {
            toast('Contractor updated.', 'positive');
            onClose();
          },
          onError,
        },
      );
      return;
    }

    create.mutate(parsed.data as CreateContractorInput, {
      onSuccess: () => {
        toast('Contractor added.', 'positive');
        onClose();
      },
      onError,
    });
  };

  const busy = create.isPending || update.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'edit' ? 'Edit contractor' : 'Add contractor'}
      size="sm"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField
          label="Name"
          htmlFor="contractor-name"
          error={errors.name}
          required
          hint={
            mode === 'edit'
              ? 'Job history matches expenses by this exact name — renaming detaches it.'
              : undefined
          }
        >
          <Input value={form.name} onInput={set('name')} autoComplete="name" />
        </FormField>
        <FormField label="Trade" htmlFor="contractor-trade" error={errors.trade} required>
          <Input list="contractor-trade-suggestions" value={form.trade} onInput={set('trade')} />
        </FormField>
        <datalist id="contractor-trade-suggestions">
          {TRADE_SUGGESTIONS.map((trade) => (
            <option key={trade} value={trade} />
          ))}
        </datalist>
        <FormField
          label="Rating"
          htmlFor="contractor-rating"
          error={errors.rating}
          hint="Optional. 1–5 stars."
        >
          <Input
            type="number"
            inputMode="decimal"
            min={1}
            max={5}
            step={0.1}
            value={form.rating}
            onInput={set('rating')}
          />
        </FormField>
        <FormField label="Phone" htmlFor="contractor-phone" hint="Optional.">
          <Input type="tel" value={form.phone} onInput={set('phone')} autoComplete="tel" />
        </FormField>
        <FormField label="Email" htmlFor="contractor-email" error={errors.email} hint="Optional.">
          <Input type="email" value={form.email} onInput={set('email')} autoComplete="email" />
        </FormField>
        <FormField label="Website" htmlFor="contractor-website" hint="Optional.">
          {/* Plain text, not type="url": landlords paste bare domains like
              "riveraplumbing.com", which native URL validation would reject. */}
          <Input
            type="text"
            inputMode="url"
            autoComplete="url"
            value={form.website}
            onInput={set('website')}
          />
        </FormField>
        <FormField label="Notes" htmlFor="contractor-notes" hint="Optional.">
          <Textarea value={form.notes} onInput={set('notes')} />
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {mode === 'edit' ? 'Save changes' : 'Add contractor'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
