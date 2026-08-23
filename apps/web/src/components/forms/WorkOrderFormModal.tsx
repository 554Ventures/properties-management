// Create / edit a work order. Mode-specific field sets on purpose: create
// covers everything a landlord might already know at intake (incl. priority,
// assignment, and schedule — "I called Rivera Plumbing, they're coming
// Tuesday" is one request); edit covers only the descriptive/administrative
// fields (title, attribution, description, quote, tenant, notes). Status,
// priority, assigned contractor, and the schedule stay editable afterward via
// the detail page's own quick controls, which also carry the server's
// status-transition rules (e.g. 'scheduled' requires scheduledFor) — leaving
// them out of Edit avoids two controls racing to save the same field.
import { useEffect, useState, type FormEvent } from 'react';
import { CreateWorkOrderInputSchema, UpdateWorkOrderInputSchema } from '@hearth/shared';
import type { CreateWorkOrderInput, UpdateWorkOrderInput, WorkOrderListRow } from '@hearth/shared';
import {
  useContractors,
  useCreateWorkOrder,
  useProperties,
  usePropertyDetail,
  useTenants,
  useUpdateWorkOrder,
} from '../../api/queries';
import { Button } from '../ui/Button';
import { FormField, Input, Textarea } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { useToast } from '../ui/Toast';

type Mode = 'create' | 'edit';

interface FormState {
  title: string;
  propertyId: string;
  unitId: string;
  description: string;
  priority: string;
  contractorId: string;
  scheduledFor: string;
  dueBy: string;
  quoted: string;
  tenantId: string;
  notes: string;
}

type FieldErrors = Partial<Record<'title' | 'propertyId' | 'quoted', string>>;

const FIELD_MESSAGES: FieldErrors = {
  title: 'Enter a short title for the work order.',
  propertyId: 'Choose a property.',
  quoted: 'Quote must be zero or more.',
};

function emptyForm(): FormState {
  return {
    title: '',
    propertyId: '',
    unitId: '',
    description: '',
    priority: 'normal',
    contractorId: '',
    scheduledFor: '',
    dueBy: '',
    quoted: '',
    tenantId: '',
    notes: '',
  };
}

function fromWorkOrder(w: WorkOrderListRow): FormState {
  return {
    ...emptyForm(),
    title: w.title,
    propertyId: w.propertyId,
    unitId: w.unitId ?? '',
    description: w.description ?? '',
    priority: w.priority,
    contractorId: w.contractorId ?? '',
    scheduledFor: w.scheduledFor ?? '',
    dueBy: w.dueBy ?? '',
    quoted: w.quotedCents != null ? (w.quotedCents / 100).toFixed(2) : '',
    tenantId: w.tenantId ?? '',
    notes: w.notes ?? '',
  };
}

export interface WorkOrderFormModalProps {
  open: boolean;
  onClose: () => void;
  mode: Mode;
  /** Required in edit mode. */
  workOrder?: WorkOrderListRow;
  /** Preselects a property when creating from a context that already knows
   *  it (unused today — reserved for a future property-hub entry point). */
  defaultPropertyId?: string;
}

export function WorkOrderFormModal({
  open,
  onClose,
  mode,
  workOrder,
  defaultPropertyId,
}: WorkOrderFormModalProps) {
  const create = useCreateWorkOrder();
  const update = useUpdateWorkOrder();
  const properties = useProperties();
  const contractors = useContractors();
  const tenants = useTenants();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<FieldErrors>({});

  useEffect(() => {
    if (open) {
      setForm(
        mode === 'edit' && workOrder
          ? fromWorkOrder(workOrder)
          : { ...emptyForm(), propertyId: defaultPropertyId ?? '' },
      );
      setErrors({});
    }
  }, [open, mode, workOrder, defaultPropertyId]);

  const propertyDetail = usePropertyDetail(form.propertyId || undefined);
  const units = propertyDetail.data?.units ?? [];

  const set =
    (key: keyof FormState) => (event: FormEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({
        ...prev,
        [key]: (event.target as HTMLInputElement).value,
      }));
  const setValue = (key: keyof FormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();

    const quotedTrimmed = form.quoted.trim();
    const quotedNumber = quotedTrimmed === '' ? undefined : Number(quotedTrimmed);

    if (mode === 'edit' && workOrder) {
      const raw = {
        title: form.title.trim(),
        propertyId: form.propertyId,
        unitId: form.unitId || null,
        description: form.description.trim() || null,
        quotedCents: quotedTrimmed === '' ? null : Math.round((quotedNumber ?? 0) * 100),
        tenantId: form.tenantId || null,
        notes: form.notes.trim() || null,
      };
      const parsed = UpdateWorkOrderInputSchema.safeParse(raw);
      if (!parsed.success) {
        const fieldErrors = parsed.error.flatten().fieldErrors;
        const next: FieldErrors = {};
        if (fieldErrors.title?.length) next.title = FIELD_MESSAGES.title;
        if (fieldErrors.quotedCents?.length) next.quoted = FIELD_MESSAGES.quoted;
        setErrors(next);
        return;
      }
      setErrors({});
      update.mutate(
        { id: workOrder.id, ...(parsed.data as UpdateWorkOrderInput) },
        {
          onSuccess: () => {
            toast('Work order updated.', 'positive');
            onClose();
          },
          onError: (err) =>
            toast(err instanceof Error ? err.message : 'Could not save the work order.', 'danger'),
        },
      );
      return;
    }

    const raw = {
      title: form.title.trim(),
      propertyId: form.propertyId || undefined,
      unitId: form.unitId || undefined,
      description: form.description.trim() || undefined,
      priority: form.priority || undefined,
      contractorId: form.contractorId || undefined,
      scheduledFor: form.scheduledFor || undefined,
      dueBy: form.dueBy || undefined,
      quotedCents: quotedTrimmed === '' ? undefined : Math.round((quotedNumber ?? 0) * 100),
      tenantId: form.tenantId || undefined,
      notes: form.notes.trim() || undefined,
    };
    const parsed = CreateWorkOrderInputSchema.safeParse(raw);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      const next: FieldErrors = {};
      if (fieldErrors.title?.length) next.title = FIELD_MESSAGES.title;
      if (fieldErrors.propertyId?.length) next.propertyId = FIELD_MESSAGES.propertyId;
      if (fieldErrors.quotedCents?.length) next.quoted = FIELD_MESSAGES.quoted;
      setErrors(next);
      return;
    }
    setErrors({});
    create.mutate(parsed.data as CreateWorkOrderInput, {
      onSuccess: () => {
        toast('Work order created.', 'positive');
        onClose();
      },
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not create the work order.', 'danger'),
    });
  };

  const busy = create.isPending || update.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'edit' ? 'Edit work order' : 'New work order'}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="Title" htmlFor="wo-title" error={errors.title} required>
          <Input
            value={form.title}
            onInput={set('title')}
            placeholder="e.g. Kitchen faucet leaking"
          />
        </FormField>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Property" htmlFor="wo-property" error={errors.propertyId} required>
            <Select
              value={form.propertyId}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, propertyId: e.target.value, unitId: '' }))
              }
            >
              <option value="">Choose a property</option>
              {(properties.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nickname ?? p.addressLine1}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="Unit"
            htmlFor="wo-unit"
            hint={
              !form.propertyId
                ? 'Pick a property first.'
                : units.length === 0
                  ? 'This property has no units — it files against the whole property.'
                  : 'Leave blank for roof/grounds/exterior work.'
            }
          >
            <Select
              value={form.unitId}
              onChange={(e) => setForm((prev) => ({ ...prev, unitId: e.target.value }))}
              disabled={!form.propertyId || units.length === 0}
            >
              <option value="">
                {form.propertyId ? 'Whole property (no unit)' : 'Choose a property first'}
              </option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        <FormField label="Description" htmlFor="wo-description" hint="Optional.">
          <Textarea value={form.description} onInput={set('description')} />
        </FormField>
        {mode === 'create' && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Priority" htmlFor="wo-priority">
              <Select
                value={form.priority}
                onChange={(e) => setValue('priority')(e.target.value)}
              >
                <option value="emergency">Emergency</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </Select>
            </FormField>
            <FormField label="Contractor" htmlFor="wo-contractor" hint="Optional.">
              <Select
                value={form.contractorId}
                onChange={(e) => setValue('contractorId')(e.target.value)}
              >
                <option value="">Unassigned</option>
                {(contractors.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Scheduled for" htmlFor="wo-scheduled" hint="Optional.">
              <Input type="date" value={form.scheduledFor} onInput={set('scheduledFor')} />
            </FormField>
            <FormField label="Due by" htmlFor="wo-due" hint="Optional.">
              <Input type="date" value={form.dueBy} onInput={set('dueBy')} />
            </FormField>
          </div>
        )}
        <FormField
          label="Quote (USD)"
          htmlFor="wo-quoted"
          error={errors.quoted}
          hint="What the contractor told you it would cost. Optional — actual cost is tracked separately from linked expenses."
        >
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={form.quoted}
            onInput={set('quoted')}
          />
        </FormField>
        <FormField
          label="Reported by"
          htmlFor="wo-tenant"
          hint="Optional — the tenant who reported it, if any."
        >
          <Select value={form.tenantId} onChange={(e) => setValue('tenantId')(e.target.value)}>
            <option value="">Not recorded</option>
            {(tenants.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.fullName}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Notes" htmlFor="wo-notes" hint="Optional.">
          <Textarea value={form.notes} onInput={set('notes')} />
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {mode === 'edit' ? 'Save changes' : 'Create work order'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
