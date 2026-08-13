// Create / edit a recurring template (PLAN-REAL-EQUITY §2/Phase 2b) — a
// standing instruction ("rent's mortgage is $2,400 on the 1st"), never a
// ledger row itself. When the chosen property carries a mortgage and the
// template is an expense, it can be attached with a principal figure so every
// row the scheduler drafts arrives pre-filled — but that figure is always
// typed by the user here, never computed (decision D4): the server enforces
// principal <= amount / expense-only / mortgage-required, and its errors
// surface as-is rather than being re-validated client-side.
import { useEffect, useState, type FormEvent } from 'react';
import type {
  RecurringTemplate,
  RecurrenceCadence,
  TransactionType,
  UpdateRecurringTemplateInput,
} from '@hearth/shared';
import { ApiClientError } from '../../api/client';
import {
  useCategories,
  useCreateRecurringTemplate,
  usePropertyDetail,
  useProperties,
  useUpdateRecurringTemplate,
} from '../../api/queries';
import { Button } from '../ui/Button';
import { FormField, Input } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { useToast } from '../ui/Toast';

type Mode = 'create' | 'edit';

const TYPE_OPTIONS: Array<{ value: TransactionType; label: string }> = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
];

const CADENCE_OPTIONS: Array<{ value: RecurrenceCadence; label: string }> = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annual', label: 'Annually' },
];

interface FormState {
  description: string;
  vendor: string;
  amount: string;
  type: TransactionType;
  cadence: RecurrenceCadence;
  anchorDate: string;
  propertyId: string;
  unitId: string;
  categoryId: string;
  attachMortgage: boolean;
  mortgageId: string;
  principal: string;
}

function emptyForm(): FormState {
  return {
    description: '',
    vendor: '',
    amount: '',
    type: 'expense',
    cadence: 'monthly',
    anchorDate: '',
    propertyId: '',
    unitId: '',
    categoryId: '',
    attachMortgage: false,
    mortgageId: '',
    principal: '',
  };
}

function fromTemplate(t: RecurringTemplate): FormState {
  return {
    description: t.description,
    vendor: t.vendor ?? '',
    amount: (t.amountCents / 100).toFixed(2),
    type: t.type,
    cadence: t.cadence,
    // anchorDate is already a plain `YYYY-MM-DD` calendar date — the <input
    // type="date"> value format — so no Date round-trip belongs here. Routing
    // it through a Date parse/reformat is exactly what made the anchor drift
    // a day depending on the reader's timezone.
    anchorDate: t.anchorDate,
    propertyId: t.propertyId ?? '',
    unitId: t.unitId ?? '',
    categoryId: t.categoryId ?? '',
    attachMortgage: Boolean(t.mortgageId),
    mortgageId: t.mortgageId ?? '',
    principal: t.principalCents != null ? (t.principalCents / 100).toFixed(2) : '',
  };
}

export interface RecurringTemplateFormModalProps {
  open: boolean;
  onClose: () => void;
  mode: Mode;
  /** Required in edit mode. */
  template?: RecurringTemplate;
}

export function RecurringTemplateFormModal({
  open,
  onClose,
  mode,
  template,
}: RecurringTemplateFormModalProps) {
  const create = useCreateRecurringTemplate();
  const update = useUpdateRecurringTemplate();
  const properties = useProperties();
  const categories = useCategories();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (open) {
      setForm(mode === 'edit' && template ? fromTemplate(template) : emptyForm());
      setError(undefined);
    }
  }, [open, mode, template]);

  const propertyDetail = usePropertyDetail(form.propertyId || undefined);
  const units = propertyDetail.data?.units ?? [];
  const mortgages = (propertyDetail.data?.mortgages ?? []).filter((m) => !m.archivedAt);
  const canAttachMortgage = form.type === 'expense' && mortgages.length > 0;

  const typeCategories = (categories.data ?? []).filter((c) => c.type === form.type);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const amountNumber = Number(form.amount);
    if (!form.description.trim()) {
      setError('Enter a description.');
      return;
    }
    if (!form.amount || Number.isNaN(amountNumber) || amountNumber <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }
    if (!form.anchorDate) {
      setError('Enter the first due date.');
      return;
    }
    if (form.attachMortgage && !form.mortgageId) {
      setError('Choose which mortgage this pays, or turn off attaching one.');
      return;
    }
    setError(undefined);

    const amountCents = Math.round(amountNumber * 100);
    // form.anchorDate is already the `YYYY-MM-DD` value the date input holds —
    // send it verbatim. Round-tripping it through `Date` is what made a
    // template set to "the 1st" recur on the 31st in the account's timezone.
    const anchorDate = form.anchorDate;
    const currentMortgageId = form.attachMortgage ? form.mortgageId || null : null;
    const currentPrincipalCents =
      form.attachMortgage && form.principal.trim() !== ''
        ? Math.round(Number(form.principal) * 100)
        : null;

    const onError = (err: unknown) =>
      toast(
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not save the recurring template.',
        'danger',
      );

    if (mode === 'edit' && template) {
      // PATCH must send `null` (not omit the key) for a field the user
      // actually cleared — omitting it is indistinguishable from "left
      // alone" once JSON.stringify drops `undefined`, which is exactly what
      // let "remove this" toast success while changing nothing. So only
      // fields that differ from the template's current value go in the
      // patch; everything else is left out entirely.
      const patch: UpdateRecurringTemplateInput = {
        description: form.description.trim(),
        type: form.type,
        amountCents,
        cadence: form.cadence,
        anchorDate,
      };
      const currentVendor = form.vendor.trim() || null;
      if (currentVendor !== (template.vendor ?? null)) patch.vendor = currentVendor;
      const currentPropertyId = form.propertyId || null;
      if (currentPropertyId !== template.propertyId) patch.propertyId = currentPropertyId;
      const currentUnitId = form.unitId || null;
      if (currentUnitId !== template.unitId) patch.unitId = currentUnitId;
      const currentCategoryId = form.categoryId || null;
      if (currentCategoryId !== template.categoryId) patch.categoryId = currentCategoryId;

      if (currentMortgageId !== template.mortgageId) {
        patch.mortgageId = currentMortgageId;
        // Detaching (or swapping) the mortgage must also null the stamped
        // principal — leaving the old number behind keeps stamping it onto
        // every drafted row even though nothing points at a mortgage
        // anymore. This is also what makes switching an attached template
        // from Expense to Income reachable: the type toggle already clears
        // `attachMortgage`/`mortgageId` client-side, so this branch fires and
        // sends the null pair the server needs instead of a silently dropped
        // `undefined`.
        patch.principalCents = currentMortgageId === null ? null : currentPrincipalCents;
      } else if (currentPrincipalCents !== template.principalCents) {
        patch.principalCents = currentPrincipalCents;
      }

      update.mutate(
        { id: template.id, ...patch },
        {
          onSuccess: () => {
            toast('Recurring template updated.', 'positive');
            onClose();
          },
          onError,
        },
      );
      return;
    }

    create.mutate(
      {
        description: form.description.trim(),
        vendor: form.vendor.trim() || undefined,
        propertyId: form.propertyId || undefined,
        unitId: form.unitId || undefined,
        categoryId: form.categoryId || undefined,
        type: form.type,
        amountCents,
        cadence: form.cadence,
        anchorDate,
        mortgageId: currentMortgageId ?? undefined,
        principalCents: currentPrincipalCents ?? undefined,
      },
      {
        onSuccess: () => {
          toast('Recurring template added.', 'positive');
          onClose();
        },
        onError,
      },
    );
  };

  const busy = create.isPending || update.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'edit' ? 'Edit recurring template' : 'Add recurring template'}
      size="md"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="Description" htmlFor="recurring-description" error={error} required>
          <Input
            value={form.description}
            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
            placeholder="e.g. Mortgage payment"
          />
        </FormField>
        <FormField label="Vendor" htmlFor="recurring-vendor" hint="Optional.">
          <Input
            value={form.vendor}
            onChange={(e) => setForm((prev) => ({ ...prev, vendor: e.target.value }))}
          />
        </FormField>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Amount (USD)" htmlFor="recurring-amount" required>
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              value={form.amount}
              onChange={(e) => setForm((prev) => ({ ...prev, amount: e.target.value }))}
            />
          </FormField>
          <FormField label="Type" htmlFor="recurring-type" required>
            <Select
              value={form.type}
              onChange={(e) => {
                const type = e.target.value as TransactionType;
                setForm((prev) => ({
                  ...prev,
                  type,
                  categoryId: '',
                  // Attaching a mortgage requires an expense — switching to
                  // income drops it rather than leaving an invalid combo.
                  attachMortgage: type === 'expense' ? prev.attachMortgage : false,
                  mortgageId: type === 'expense' ? prev.mortgageId : '',
                  principal: type === 'expense' ? prev.principal : '',
                }));
              }}
            >
              {TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Cadence" htmlFor="recurring-cadence" required>
            <Select
              value={form.cadence}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, cadence: e.target.value as RecurrenceCadence }))
              }
            >
              {CADENCE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="First due date"
            htmlFor="recurring-anchor"
            hint="Later occurrences repeat from here automatically."
            required
          >
            <Input
              type="date"
              value={form.anchorDate}
              onChange={(e) => setForm((prev) => ({ ...prev, anchorDate: e.target.value }))}
            />
          </FormField>
        </div>
        <FormField label="Property" htmlFor="recurring-property" hint="Optional — leave blank for portfolio-level items.">
          <Select
            value={form.propertyId}
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                propertyId: e.target.value,
                unitId: '',
                attachMortgage: false,
                mortgageId: '',
              }))
            }
          >
            <option value="">Portfolio (no property)</option>
            {(properties.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.nickname ?? p.addressLine1}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="Unit"
          htmlFor="recurring-unit"
          hint={!form.propertyId ? 'Pick a property first.' : undefined}
        >
          <Select
            value={form.unitId}
            onChange={(e) => setForm((prev) => ({ ...prev, unitId: e.target.value }))}
            disabled={!form.propertyId || units.length === 0}
          >
            <option value="">{form.propertyId ? 'Whole property (no unit)' : 'Choose a property first'}</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Category" htmlFor="recurring-category" hint="Optional.">
          <Select
            value={form.categoryId}
            onChange={(e) => setForm((prev) => ({ ...prev, categoryId: e.target.value }))}
          >
            <option value="">No category yet</option>
            {typeCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </FormField>

        {canAttachMortgage && (
          <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-sunken p-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-pressed={form.attachMortgage}
              onClick={() =>
                setForm((prev) => ({
                  ...prev,
                  attachMortgage: !prev.attachMortgage,
                  mortgageId: prev.attachMortgage ? '' : prev.mortgageId,
                  principal: prev.attachMortgage ? '' : prev.principal,
                }))
              }
            >
              {form.attachMortgage ? 'Remove mortgage attachment' : 'Attach to a mortgage'}
            </Button>
            {form.attachMortgage && (
              <>
                <FormField label="Mortgage" htmlFor="recurring-mortgage" required>
                  <Select
                    value={form.mortgageId}
                    onChange={(e) => setForm((prev) => ({ ...prev, mortgageId: e.target.value }))}
                  >
                    <option value="">Choose a mortgage</option>
                    {mortgages.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.lender}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField
                  label="Principal (USD)"
                  htmlFor="recurring-principal"
                  hint="Typed by you, never computed — this pre-fills the principal on every row drafted from this template. Update it here if the split changes."
                >
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={form.principal}
                    onChange={(e) => setForm((prev) => ({ ...prev, principal: e.target.value }))}
                  />
                </FormField>
              </>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {mode === 'edit' ? 'Save changes' : 'Add template'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
