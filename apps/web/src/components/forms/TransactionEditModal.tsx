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
import { Link } from 'react-router';
import {
  useCategories,
  useCreateCategory,
  useProperties,
  usePropertyDetail,
  useUpdateTransaction,
} from '../../api/queries';
import { cx } from '../../lib/cx';
import { DocumentsCard } from '../documents/DocumentsCard';
import { Button, buttonClasses } from '../ui/Button';
import { FormField, Input } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { useToast } from '../ui/Toast';
import { IconPlus, IconTrash } from '../ui/icons';
import {
  emptyMortgageBreakdown,
  emptySplitRows,
  isMortgageBreakdownValid,
  mortgageBreakdownPayload,
  mortgageBreakdownStatusId,
  MortgageBreakdownEditor,
  parseCents,
  type MortgageBreakdownValue,
  type SplitRow,
} from './MortgageBreakdownEditor';

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

const MORTGAGE_LOCKED_HINT = 'Categorized by the mortgage breakdown below.';
const MORTGAGE_TREATMENT_HINT =
  "Mortgage payments can't carry a treatment — the breakdown above replaces it.";

// Defect 2: a detected-but-not-yet-confirmed mortgage payment has no
// breakdown to correct here — `splits` are confirmed-only server-side, and
// gating this modal's Save on an un-enterable breakdown would make the row
// uneditable for even a plain description fix. The review queue is where its
// principal/interest breakdown belongs; this modal stays open for ordinary
// edits and points there instead of silently hiding the capability.
const MORTGAGE_PENDING_HINT =
  'This bank row matches your mortgage. Its principal/interest breakdown is entered when you confirm it — this modal can still fix its description or other ordinary details.';

export function TransactionEditModal({ open, onClose, transaction }: TransactionEditModalProps) {
  const update = useUpdateTransaction();
  const clearMortgage = useUpdateTransaction();
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
    breakdown?: string;
  }>({});
  const [splitMode, setSplitMode] = useState(false);
  const [splitRows, setSplitRows] = useState<SplitRow[]>(emptySplitRows);
  // Whether the row already carried splits when the modal opened — turning
  // splits off from that state must explicitly clear them (`splits: null`);
  // a row that was never split just omits the field, as before.
  const [initialHadSplits, setInitialHadSplits] = useState(false);
  // Mortgage payment breakdown (PLAN-REAL-EQUITY §3/D4) — principal + the
  // remainder split, replacing ordinary categorization for a row whose
  // `mortgageId` is set. Reuses the same split-row shape as the ordinary
  // splits above, via the shared MortgageBreakdownEditor.
  const [breakdown, setBreakdown] = useState<MortgageBreakdownValue>(emptyMortgageBreakdown);
  // Defect 3 escape hatch: a vendor-matched detection that turns out to be
  // wrong (a lender fee, say) — once the nulling PATCH lands, this flips the
  // row back to ordinary editing for the rest of the session without waiting
  // on the parent's stale `transaction` prop to refetch.
  const [mortgageCleared, setMortgageCleared] = useState(false);

  const rentLinked = transaction?.rentLinked ?? false;
  // Defect 2: only a CONFIRMED mortgage-flagged row gets the breakdown editor
  // here — `splits` are confirmed-only server-side, so a pending row would be
  // gated on a breakdown it can't legally save. See MORTGAGE_PENDING_HINT.
  const isMortgagePayment =
    Boolean(transaction?.mortgageId) && transaction?.status === 'confirmed' && !mortgageCleared;
  const isPendingMortgageDetection =
    Boolean(transaction?.mortgageId) && transaction?.status !== 'confirmed';
  // Backend rule: splits are confirmed-only, and rent-linked, classified
  // (transfer/owner_contribution/refund), or mortgage-flagged rows (which use
  // the breakdown editor instead) can't use the ordinary split editor.
  const canSplit =
    !rentLinked && !isMortgagePayment && classification === '' && transaction?.status === 'confirmed';

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
      setMortgageCleared(false);
      const existingSplits = transaction.splits ?? [];
      if (transaction.mortgageId) {
        // The row's own splits ARE its remainder allocation — never the
        // ordinary split editor's state, and never last-month's recall (this
        // is the row's real, previously-saved data).
        setInitialHadSplits(false);
        setSplitMode(false);
        setSplitRows(emptySplitRows());
        const hasSplitRemainder = transaction.principalCents != null && existingSplits.length > 0;
        setBreakdown({
          principal: transaction.principalCents != null ? (transaction.principalCents / 100).toFixed(2) : '',
          remainderCategoryId: hasSplitRemainder ? '' : (transaction.categoryId ?? ''),
          splitMode: hasSplitRemainder,
          splitRows: hasSplitRemainder
            ? existingSplits.map((s) => ({
                categoryId: s.categoryId,
                amount: (s.amountCents / 100).toFixed(2),
              }))
            : emptySplitRows(),
        });
      } else {
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
        setBreakdown(emptyMortgageBreakdown());
      }
    }
  }, [open, transaction]);

  const propertyDetail = usePropertyDetail(propertyId || undefined);
  const units = propertyDetail.data?.units ?? [];
  // Surfaced only when already loaded (the units fetch above) — never a new
  // request just for this hint.
  const mortgageEscrowNote = propertyDetail.data?.mortgages.find(
    (m) => m.id === transaction?.mortgageId,
  )?.escrowNote;
  // A refund nets against an EXPENSE category, so the picker flips type.
  // Splits only ever apply to an ordinary row, so this is just the
  // transaction's own type while splitMode is active.
  const categoryType = classification === 'refund' ? 'expense' : transaction?.type;
  const categoryOptions = (categories.data ?? []).filter((c) => c.type === categoryType);

  // Live allocation totals for the split editor — and the same live amount
  // (not the transaction's stale one) feeds the mortgage breakdown, so
  // editing Amount keeps the breakdown's "remaining to allocate" honest.
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

  // Defect 3 escape hatch: a vendor match that isn't really the mortgage (a
  // lender fee, say) would otherwise leave the row stuck in breakdown mode
  // with no way to satisfy it. Nulls the stamped link server-side, then flips
  // this session to ordinary editing so Category/Treatment unlock in place.
  const clearMortgageLink = () => {
    if (!transaction) return;
    clearMortgage.mutate(
      { id: transaction.id, mortgageId: null, principalCents: null },
      {
        onSuccess: () => {
          setMortgageCleared(true);
          setBreakdown(emptyMortgageBreakdown());
          setErrors((prev) => ({ ...prev, breakdown: undefined }));
          toast("Won't be treated as a mortgage payment — edit it normally below.", 'positive');
        },
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not clear the mortgage link.', 'danger'),
      },
    );
  };

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
    if (isMortgagePayment) {
      if (!isMortgageBreakdownValid(totalCents, breakdown)) {
        nextErrors.breakdown =
          'Finish the mortgage breakdown — enter Principal and categorize the rest until nothing remains.';
      }
    } else if (splitMode) {
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
        // row sends `splits: null` to explicitly clear them. A mortgage
        // payment's principal + remainder split replaces both paths.
        ...(isMortgagePayment
          ? mortgageBreakdownPayload(totalCents, breakdown)
          : splitMode
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
        // when the user actually changed it. Mortgage rows keep the select
        // disabled, so this stays a no-op for them.
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
        {isPendingMortgageDetection && (
          <div className="flex flex-col gap-2 rounded-md border border-border-strong bg-surface-sunken px-3 py-2 text-sm text-ink-muted">
            <p>{MORTGAGE_PENDING_HINT}</p>
            <Link to="/money/review" className={buttonClasses('secondary', 'sm')}>
              Go to review queue →
            </Link>
          </div>
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
              : isMortgagePayment
                ? MORTGAGE_LOCKED_HINT
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
            disabled={rentLinked || splitMode || isMortgagePayment}
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
        {newCategoryTarget === 'main' && !rentLinked && !isMortgagePayment && newCategoryPanel}
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
        {isMortgagePayment && transaction && (
          <div className="flex flex-col gap-2">
            {errors.breakdown && (
              <p className="text-xs font-medium text-danger" role="alert">
                {errors.breakdown}
              </p>
            )}
            <MortgageBreakdownEditor
              idPrefix={`edit-txn-mortgage-${transaction.id}`}
              amountCents={totalCents}
              mortgageId={transaction.mortgageId as string}
              propertyId={propertyId || transaction.propertyId}
              excludeTransactionId={transaction.id}
              value={breakdown}
              onChange={setBreakdown}
              categoryOptions={categoryOptions}
              escrowNote={mortgageEscrowNote}
            />
            <div>
              <Button
                variant="ghost"
                size="sm"
                busy={clearMortgage.isPending}
                onClick={clearMortgageLink}
              >
                Not a mortgage payment
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
              : isMortgagePayment
                ? MORTGAGE_TREATMENT_HINT
                : splitMode
                  ? SPLIT_LOCKED_HINT
                  : 'Transfers and owner contributions leave P&L entirely; a refund nets against its expense category.'
          }
        >
          <Select
            value={classification}
            disabled={rentLinked || splitMode || isMortgagePayment}
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
          <Button
            busy={update.isPending}
            disabled={isMortgagePayment && !isMortgageBreakdownValid(totalCents, breakdown)}
            aria-describedby={isMortgagePayment ? mortgageBreakdownStatusId(`edit-txn-mortgage-${transaction?.id}`) : undefined}
            onClick={save}
          >
            Save changes
          </Button>
        </div>
      </div>
    </Modal>
  );
}
