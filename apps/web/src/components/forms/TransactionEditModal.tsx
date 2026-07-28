// Edit a ledger transaction: attribution (property/unit/category) plus amount,
// date, vendor, and description. A row that backs a recorded rent deposit
// (`rentLinked`) keeps amount/date/treatment/category locked — changing any of
// those would desync the ledger from the rent tracker (see
// transaction.service.ts's changesLinkedFields guard); unlinking the deposit
// on the Rent page is the way out. Property/unit stay editable either way —
// reattributing a deposit to the right property/unit is a legitimate fix.
import { useEffect, useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type { Transaction, TransactionClassification } from '@hearth/shared';
import {
  useCategories,
  useCreateCategory,
  useProperties,
  usePropertyDetail,
  useUpdateTransaction,
} from '../../api/queries';
import { cx } from '../../lib/cx';
import { DocumentsCard } from '../documents/DocumentsCard';
import { Button } from '../ui/Button';
import { FormField, Input } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { useToast } from '../ui/Toast';
import { IconPlus, IconTrash } from '../ui/icons';

export interface TransactionEditModalProps {
  open: boolean;
  onClose: () => void;
  transaction: Transaction | null;
}

const RENT_LINKED_HINT =
  'This transaction backs a recorded rent payment — unlink the deposit on the Rent page to edit these.';

const SPLIT_LOCKED_HINT =
  'Split transactions must stay ordinary income/expense — turn off splitting to change this.';

// Sentinel option value: never a real category id (cuids don't start with "__").
const NEW_CATEGORY = '__new__';

interface SplitRow {
  categoryId: string;
  amount: string;
}

const emptySplitRows = (): SplitRow[] => [
  { categoryId: '', amount: '' },
  { categoryId: '', amount: '' },
];

function parseCents(value: string): number {
  const n = Number(value);
  return value.trim() !== '' && !Number.isNaN(n) ? Math.round(n * 100) : 0;
}

export function TransactionEditModal({ open, onClose, transaction }: TransactionEditModalProps) {
  const update = useUpdateTransaction();
  const properties = useProperties();
  const categories = useCategories();
  const createCategory = useCreateCategory();
  const { toast } = useToast();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [vendor, setVendor] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [classification, setClassification] = useState<TransactionClassification | ''>('');
  // 'main' = the single-category picker; a number = that split row's picker.
  const [newCategoryTarget, setNewCategoryTarget] = useState<'main' | number | null>(null);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [errors, setErrors] = useState<{
    amount?: string;
    description?: string;
    category?: string;
    splits?: string;
  }>({});
  const [splitMode, setSplitMode] = useState(false);
  const [splitRows, setSplitRows] = useState<SplitRow[]>(emptySplitRows);
  // Whether the row already carried splits when the modal opened — turning
  // splits off from that state must explicitly clear them (`splits: null`);
  // a row that was never split just omits the field, as before.
  const [initialHadSplits, setInitialHadSplits] = useState(false);

  const rentLinked = transaction?.rentLinked ?? false;
  // Backend rule: splits are confirmed-only, and rent-linked or classified
  // (transfer/owner_contribution/refund) rows can't be split.
  const canSplit = !rentLinked && classification === '' && transaction?.status === 'confirmed';

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
      setNewCategoryTarget(null);
      setNewCategoryName('');
      setErrors({});
      const existingSplits = transaction.splits ?? [];
      setInitialHadSplits(existingSplits.length > 0);
      setSplitMode(existingSplits.length > 0);
      setSplitRows(
        existingSplits.length > 0
          ? existingSplits.map((s) => ({
              categoryId: s.categoryId,
              amount: (s.amountCents / 100).toFixed(2),
            }))
          : emptySplitRows(),
      );
    }
  }, [open, transaction]);

  const propertyDetail = usePropertyDetail(propertyId || undefined);
  const units = propertyDetail.data?.units ?? [];
  // A refund nets against an EXPENSE category, so the picker flips type.
  // Splits only ever apply to an ordinary row, so this is just the
  // transaction's own type while splitMode is active.
  const categoryType = classification === 'refund' ? 'expense' : transaction?.type;
  const categoryOptions = (categories.data ?? []).filter((c) => c.type === categoryType);

  // Live allocation totals for the split editor.
  const totalCents = parseCents(amount);
  const allocatedCents = splitRows.reduce((sum, r) => sum + parseCents(r.amount), 0);
  const remainingCents = totalCents - allocatedCents;
  const splitsMismatched = splitMode && remainingCents !== 0;
  const splitRowsComplete = splitRows.every(
    (r) => r.categoryId && r.amount.trim() !== '' && parseCents(r.amount) > 0,
  );

  const updateSplitRow = (index: number, patch: Partial<SplitRow>) =>
    setSplitRows((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const addSplitRow = () => setSplitRows((rows) => [...rows, { categoryId: '', amount: '' }]);
  const removeSplitRow = (index: number) =>
    setSplitRows((rows) => (rows.length > 2 ? rows.filter((_, i) => i !== index) : rows));

  // "+ New category…" in the picker (beta feedback): creates it via
  // POST /categories and selects it in place, no detour through settings.
  // Shared by the single-category picker ('main') and every split row's
  // picker (a row index) — only one can be open at a time.
  const addCategory = () => {
    const name = newCategoryName.trim();
    if (!name) {
      toast('Enter a category name.', 'danger');
      return;
    }
    if (!categoryType) return;
    createCategory.mutate(
      { name, type: categoryType },
      {
        onSuccess: (created) => {
          if (newCategoryTarget === 'main') {
            setCategoryId(created.id);
          } else if (typeof newCategoryTarget === 'number') {
            updateSplitRow(newCategoryTarget, { categoryId: created.id });
          }
          setNewCategoryTarget(null);
          setNewCategoryName('');
          toast(`Category “${created.name}” added.`, 'positive');
        },
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not add the category.', 'danger'),
      },
    );
  };

  const newCategoryPanel = (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-sunken p-3">
      <FormField
        label="New category name"
        htmlFor="edit-txn-new-category"
        hint={`Added as an ${categoryType === 'income' ? 'income' : 'expense'} category and selected in place.`}
      >
        <Input
          value={newCategoryName}
          onChange={(e) => setNewCategoryName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addCategory();
            }
          }}
        />
      </FormField>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setNewCategoryTarget(null);
            setNewCategoryName('');
          }}
        >
          Cancel
        </Button>
        <Button size="sm" busy={createCategory.isPending} onClick={addCategory}>
          Add category
        </Button>
      </div>
    </div>
  );

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
    if (splitMode) {
      if (splitRows.length < 2 || !splitRowsComplete) {
        nextErrors.splits = 'Choose a category and enter an amount greater than zero for every split.';
      } else if (remainingCents !== 0) {
        nextErrors.splits = 'Adjust the splits so they add up to the transaction amount.';
      }
    } else if (initialHadSplits && !categoryId) {
      // Un-splitting clears the parent's categoryId server-side (it was null
      // while splits were the categorization) — without a chosen category the
      // row would silently become Uncategorized.
      nextErrors.category = 'Pick a category for the un-split transaction.';
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
        // Splits ARE the categorization when active — the server rejects a
        // PATCH that sends both. Turning splits off from a previously split
        // row sends `splits: null` to explicitly clear them.
        ...(splitMode
          ? {
              splits: splitRows.map((r) => ({
                categoryId: r.categoryId,
                amountCents: parseCents(r.amount),
              })),
            }
          : {
              categoryId: categoryId || undefined,
              ...(initialHadSplits ? { splits: null } : {}),
            }),
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
          error={errors.category}
          hint={
            rentLinked
              ? RENT_LINKED_HINT
              : splitMode
                ? 'Categorized by the splits below.'
                : undefined
          }
        >
          <Select
            value={newCategoryTarget === 'main' ? NEW_CATEGORY : categoryId}
            onChange={(e) => {
              if (e.target.value === NEW_CATEGORY) {
                setNewCategoryTarget('main');
              } else {
                setNewCategoryTarget(null);
                setCategoryId(e.target.value);
              }
            }}
            disabled={rentLinked || splitMode}
          >
            <option value="">Keep current category</option>
            {categoryOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value={NEW_CATEGORY}>+ New category…</option>
          </Select>
        </FormField>
        {newCategoryTarget === 'main' && !rentLinked && newCategoryPanel}
        {canSplit && (
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-pressed={splitMode}
              onClick={() => setSplitMode((v) => !v)}
            >
              {splitMode ? 'Remove split — use one category' : 'Split across categories'}
            </Button>
          </div>
        )}
        {splitMode && (
          <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-sunken p-3">
            <p
              role="status"
              className={cx(
                'text-sm',
                splitsMismatched ? 'font-medium text-danger' : 'text-ink-muted',
              )}
            >
              {formatUsd(allocatedCents)} of {formatUsd(totalCents)} allocated ·{' '}
              {formatUsd(remainingCents)} remaining
            </p>
            {errors.splits && (
              <p className="text-xs font-medium text-danger" role="alert">
                {errors.splits}
              </p>
            )}
            {splitRows.map((row, i) => (
              <div key={i} className="flex flex-col gap-2">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_140px_auto] sm:items-end">
                  <FormField label={`Split ${i + 1} category`} htmlFor={`edit-txn-split-category-${i}`}>
                    <Select
                      value={newCategoryTarget === i ? NEW_CATEGORY : row.categoryId}
                      onChange={(e) => {
                        if (e.target.value === NEW_CATEGORY) {
                          setNewCategoryTarget(i);
                        } else {
                          setNewCategoryTarget(null);
                          updateSplitRow(i, { categoryId: e.target.value });
                        }
                      }}
                    >
                      <option value="">Choose a category</option>
                      {categoryOptions.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                      <option value={NEW_CATEGORY}>+ New category…</option>
                    </Select>
                  </FormField>
                  <FormField label={`Split ${i + 1} amount (USD)`} htmlFor={`edit-txn-split-amount-${i}`}>
                    <Input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0.01"
                      value={row.amount}
                      onChange={(e) => updateSplitRow(i, { amount: e.target.value })}
                    />
                  </FormField>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={splitRows.length <= 2}
                    onClick={() => removeSplitRow(i)}
                  >
                    <IconTrash size={14} />
                    <span className="sr-only">Remove split {i + 1}</span>
                  </Button>
                </div>
                {newCategoryTarget === i && newCategoryPanel}
              </div>
            ))}
            <div>
              <Button variant="ghost" size="sm" onClick={addSplitRow}>
                <IconPlus size={14} />
                Add split
              </Button>
            </div>
          </div>
        )}
        <FormField
          label="Treatment"
          htmlFor="edit-txn-classification"
          hint={
            rentLinked
              ? RENT_LINKED_HINT
              : splitMode
                ? SPLIT_LOCKED_HINT
                : 'Transfers and owner contributions leave P&L entirely; a refund nets against its expense category.'
          }
        >
          <Select
            value={classification}
            disabled={rentLinked || splitMode}
            onChange={(e) => setClassification(e.target.value as TransactionClassification | '')}
          >
            <option value="">Ordinary {transaction?.type === 'income' ? 'income' : 'expense'}</option>
            <option value="transfer">Transfer between my accounts (not counted)</option>
            <option value="owner_contribution">Owner contribution (not counted)</option>
            {transaction?.type === 'income' && <option value="refund">Refund</option>}
          </Select>
        </FormField>
        {/* Attachments (receipts, invoices) — same card as the detail pages,
            embedded without Card chrome; a receipt-typed upload here also sets
            the row's receiptUrl server-side. */}
        {transaction && (
          <DocumentsCard
            embedded
            headingLevel={3}
            filter={{ entityType: 'transaction', entityId: transaction.id }}
            uploadTarget={{ entityType: 'transaction', entityId: transaction.id }}
          />
        )}
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
