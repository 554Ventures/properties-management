// Edit a ledger transaction: attribution (property/unit/category) plus amount,
// date, vendor, and description. A row that backs a recorded rent deposit
// (`rentLinked`) keeps amount/date/treatment/category locked — changing any of
// those would desync the ledger from the rent tracker (see
// transaction.service.ts's changesLinkedFields guard); unlinking the deposit
// on the Rent page is the way out. Property/unit stay editable either way —
// reattributing a deposit to the right property/unit is a legitimate fix.
import { useEffect, useState } from 'react';
import type { Transaction, TransactionClassification } from '@hearth/shared';
import {
  useCategories,
  useProperties,
  usePropertyDetail,
  useUpdateTransaction,
} from '../../api/queries';
import { Button } from '../ui/Button';
import { FormField, Input } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { useToast } from '../ui/Toast';

export interface TransactionEditModalProps {
  open: boolean;
  onClose: () => void;
  transaction: Transaction | null;
}

const RENT_LINKED_HINT =
  'This transaction backs a recorded rent payment — unlink the deposit on the Rent page to edit these.';

export function TransactionEditModal({ open, onClose, transaction }: TransactionEditModalProps) {
  const update = useUpdateTransaction();
  const properties = useProperties();
  const categories = useCategories();
  const { toast } = useToast();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [vendor, setVendor] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [classification, setClassification] = useState<TransactionClassification | ''>('');
  const [errors, setErrors] = useState<{ amount?: string; description?: string }>({});

  const rentLinked = transaction?.rentLinked ?? false;

  useEffect(() => {
    if (open && transaction) {
      setAmount((transaction.amountCents / 100).toFixed(2));
      setDate(transaction.date.slice(0, 10));
      setDescription(transaction.description);
      setVendor(transaction.vendor ?? '');
      setPropertyId(transaction.propertyId ?? '');
      setUnitId(transaction.unitId ?? '');
      setCategoryId(transaction.categoryId ?? '');
      setClassification(transaction.classification ?? '');
      setErrors({});
    }
  }, [open, transaction]);

  const propertyDetail = usePropertyDetail(propertyId || undefined);
  const units = propertyDetail.data?.units ?? [];
  // A refund nets against an EXPENSE category, so the picker flips type.
  const categoryType = classification === 'refund' ? 'expense' : transaction?.type;
  const categoryOptions = (categories.data ?? []).filter((c) => c.type === categoryType);

  const save = () => {
    if (!transaction) return;
    const amountNumber = Number(amount);
    const nextErrors: typeof errors = {};
    if (!amount || Number.isNaN(amountNumber) || amountNumber <= 0) {
      nextErrors.amount = 'Enter an amount greater than zero.';
    }
    if (!description.trim()) {
      nextErrors.description = 'Enter a short description.';
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    update.mutate(
      {
        id: transaction.id,
        // When rentLinked, amount/date/category/classification stay disabled
        // above, so these still equal the transaction's current values — the
        // server guard only rejects an actual change to a linked row.
        amountCents: Math.round(amountNumber * 100),
        date: new Date(`${date}T12:00:00`).toISOString(),
        description: description.trim(),
        // The PATCH contract treats omitted fields as "leave unchanged" and
        // has no "clear" value yet (known contract limitation), so blanked
        // vendor/property/unit selections are simply not sent.
        vendor: vendor.trim() || undefined,
        propertyId: propertyId || undefined,
        unitId: unitId || undefined,
        categoryId: categoryId || undefined,
        // Classification does support explicit clearing (null) — only send it
        // when the user actually changed it.
        ...(classification !== (transaction.classification ?? '')
          ? { classification: classification || null }
          : {}),
      },
      {
        onSuccess: () => {
          toast('Transaction updated.', 'positive');
          onClose();
        },
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not update the transaction.', 'danger'),
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Edit transaction">
      <div className="flex flex-col gap-4">
        {rentLinked && (
          <p className="rounded-md border border-border-strong bg-surface-sunken px-3 py-2 text-sm text-ink-muted">
            {RENT_LINKED_HINT}
          </p>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Amount (USD)"
            htmlFor="edit-txn-amount"
            error={errors.amount}
            hint={rentLinked ? RENT_LINKED_HINT : undefined}
            required
          >
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              value={amount}
              disabled={rentLinked}
              onChange={(e) => setAmount(e.target.value)}
            />
          </FormField>
          <FormField
            label="Date"
            htmlFor="edit-txn-date"
            hint={rentLinked ? RENT_LINKED_HINT : undefined}
            required
          >
            <Input
              type="date"
              value={date}
              disabled={rentLinked}
              onChange={(e) => setDate(e.target.value)}
            />
          </FormField>
        </div>
        <FormField label="Description" htmlFor="edit-txn-description" error={errors.description} required>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </FormField>
        <FormField label="Vendor" htmlFor="edit-txn-vendor" hint="Optional.">
          <Input value={vendor} onChange={(e) => setVendor(e.target.value)} />
        </FormField>
        <FormField
          label="Property"
          htmlFor="edit-txn-property"
          hint="A set property can't be cleared yet — pick a different one to change it."
        >
          <Select
            value={propertyId}
            onChange={(e) => {
              setPropertyId(e.target.value);
              setUnitId('');
            }}
          >
            <option value="">Portfolio (no property)</option>
            {(properties.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.nickname ?? p.addressLine1}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Unit" htmlFor="edit-txn-unit">
          <Select
            value={unitId}
            onChange={(e) => setUnitId(e.target.value)}
            disabled={!propertyId || units.length === 0}
          >
            <option value="">
              {propertyId ? 'Whole property (no unit)' : 'Choose a property first'}
            </option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="Category"
          htmlFor="edit-txn-category"
          hint={rentLinked ? RENT_LINKED_HINT : undefined}
        >
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={rentLinked}>
            <option value="">Keep current category</option>
            {categoryOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="Treatment"
          htmlFor="edit-txn-classification"
          hint={
            rentLinked
              ? RENT_LINKED_HINT
              : 'Transfers and owner contributions leave P&L entirely; a refund nets against its expense category.'
          }
        >
          <Select
            value={classification}
            disabled={rentLinked}
            onChange={(e) => setClassification(e.target.value as TransactionClassification | '')}
          >
            <option value="">Ordinary {transaction?.type === 'income' ? 'income' : 'expense'}</option>
            <option value="transfer">Transfer between my accounts (not counted)</option>
            <option value="owner_contribution">Owner contribution (not counted)</option>
            {transaction?.type === 'income' && <option value="refund">Refund</option>}
          </Select>
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={update.isPending} onClick={save}>
            Save changes
          </Button>
        </div>
      </div>
    </Modal>
  );
}
