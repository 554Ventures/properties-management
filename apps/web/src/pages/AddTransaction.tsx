// Add transaction (PRD §5.4): manual entry form with AI-suggested category
// chip (never auto-applied) and "Snap a receipt" — the scan pre-fills the
// form; saving is always an explicit user action.
import { useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import type { TransactionType } from '@hearth/shared';
import { useNavigate } from 'react-router-dom';
import {
  useCategories,
  useCreateTransaction,
  useProperties,
  useScanReceipt,
  useUploadDocument,
} from '../api/queries';
import { AiChip } from '../components/ai/AiChip';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { FormField, Input } from '../components/ui/FormField';
import { Select } from '../components/ui/Select';
import { useToast } from '../components/ui/Toast';
import { IconUpload } from '../components/ui/icons';
import { cx } from '../lib/cx';
import { usePageTitle } from '../lib/usePageTitle';

function todayInputValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

interface Suggestion {
  categoryId: string;
  confidence: number;
}

export function AddTransaction() {
  usePageTitle('Add transaction');
  const navigate = useNavigate();
  const { toast } = useToast();
  const categories = useCategories();
  const properties = useProperties();
  const create = useCreateTransaction();
  const scan = useScanReceipt();
  const uploadDocument = useUploadDocument();

  const [amount, setAmount] = useState('');
  const [type, setType] = useState<TransactionType>('expense');
  const [date, setDate] = useState(todayInputValue());
  const [description, setDescription] = useState('');
  const [vendor, setVendor] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [errors, setErrors] = useState<{ amount?: string; description?: string }>({});
  const [dragging, setDragging] = useState(false);
  // The picked receipt image — attached to the transaction as a document on
  // save (kept even when the scan itself fails).
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const typeCategories = useMemo(
    () => (categories.data ?? []).filter((c) => c.type === type),
    [categories.data, type],
  );
  const suggestedCategory = suggestion
    ? (categories.data ?? []).find((c) => c.id === suggestion.categoryId)
    : undefined;

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    setReceiptFile(file);
    const form = new FormData();
    form.append('file', file);
    scan.mutate(form, {
      onSuccess: (result) => {
        // Pre-fill only — never saves (PRD §5.4).
        if (result.amountCents != null) setAmount((result.amountCents / 100).toFixed(2));
        if (result.vendor) setVendor(result.vendor);
        if (result.date) setDate(result.date.slice(0, 10));
        if (result.suggestedPropertyId) setPropertyId(result.suggestedPropertyId);
        if (result.suggestedCategoryId) {
          setSuggestion({ categoryId: result.suggestedCategoryId, confidence: result.confidence });
        }
        setDescription((prev) => prev || (result.vendor ? `Receipt — ${result.vendor}` : prev));
        toast('Receipt scanned — review the details below, then save.', 'positive');
      },
      onError: () => toast('Could not read that receipt. Enter the details manually.', 'danger'),
    });
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    handleFile(event.dataTransfer.files?.[0]);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
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

    create.mutate(
      {
        date: new Date(`${date}T12:00:00`).toISOString(),
        amountCents: Math.round(amountNumber * 100),
        type,
        description: description.trim(),
        vendor: vendor.trim() || undefined,
        propertyId: propertyId || undefined,
        categoryId: categoryId || undefined,
      },
      {
        onSuccess: (txn) => {
          if (!receiptFile) {
            toast('Transaction saved.', 'positive');
            navigate('/money');
            return;
          }
          // Attach the receipt to the saved transaction. A failed upload never
          // blocks the flow — the transaction is already saved. Text fields
          // must precede the file part (the server reads them off the first
          // file part).
          const form = new FormData();
          form.append('entityType', 'transaction');
          form.append('entityId', txn.id);
          form.append('type', 'receipt');
          form.append('file', receiptFile);
          uploadDocument.mutate(form, {
            onSuccess: () => {
              toast('Transaction saved.', 'positive');
              navigate('/money');
            },
            onError: () => {
              toast('Transaction saved; receipt attachment failed.', 'neutral');
              navigate('/money');
            },
          });
        },
        onError: () => toast('Could not save the transaction. Try again.', 'danger'),
      },
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageHeader
        title="Add transaction"
        breadcrumbs={[{ label: 'Money', to: '/money' }, { label: 'Add transaction' }]}
      />

      <Card>
        <h2 className="mb-2 text-sm font-semibold text-ink">Snap a receipt</h2>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cx(
            'flex flex-col items-center gap-2 rounded-md border-2 border-dashed px-6 py-8 text-center transition-colors duration-fast',
            dragging ? 'border-brand bg-brand-soft' : 'border-border-strong',
          )}
        >
          <span aria-hidden="true" className="text-ink-faint">
            <IconUpload size={24} />
          </span>
          <p className="text-sm text-ink-muted">
            Drag a receipt photo here — Roost reads the vendor, amount, and date and pre-fills the
            form. Nothing is saved until you hit Save.
          </p>
          <Button
            variant="secondary"
            size="sm"
            busy={scan.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            Choose an image
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            aria-label="Receipt image"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </div>
      </Card>

      <Card>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-ink">Type</legend>
            <div className="inline-flex rounded-md border border-border-strong p-0.5" role="radiogroup" aria-label="Transaction type">
              {(['expense', 'income'] as const).map((option) => (
                <label
                  key={option}
                  className={cx(
                    'cursor-pointer rounded px-4 py-1.5 text-sm font-medium capitalize transition-colors duration-fast',
                    type === option ? 'bg-brand text-ink-on-brand' : 'text-ink-muted hover:text-ink',
                  )}
                >
                  <input
                    type="radio"
                    name="txn-type"
                    value={option}
                    checked={type === option}
                    onChange={() => {
                      setType(option);
                      setCategoryId('');
                    }}
                    className="sr-only"
                  />
                  {option}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Amount (USD)" htmlFor="txn-amount" error={errors.amount} required>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </FormField>
            <FormField label="Date" htmlFor="txn-date" required>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </FormField>
          </div>

          <FormField label="Description" htmlFor="txn-description" error={errors.description} required>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </FormField>

          <FormField label="Vendor" htmlFor="txn-vendor" hint="Optional.">
            <Input value={vendor} onChange={(e) => setVendor(e.target.value)} />
          </FormField>

          <FormField label="Property" htmlFor="txn-property" hint="Leave blank for portfolio-level items like insurance.">
            <Select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
              <option value="">Portfolio (no property)</option>
              {(properties.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nickname ?? p.addressLine1}
                </option>
              ))}
            </Select>
          </FormField>

          <div className="flex flex-col gap-2">
            <FormField
              label="Category"
              htmlFor="txn-category"
              hint={!categoryId && !suggestion ? 'Leave blank and Roost will suggest one for review.' : undefined}
            >
              <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">No category yet</option>
                {typeCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </FormField>
            {suggestion && suggestedCategory && (
              <div>
                <AiChip
                  name={suggestedCategory.name}
                  confidence={suggestion.confidence}
                  applied={categoryId === suggestion.categoryId}
                  onApply={() => setCategoryId(suggestion.categoryId)}
                />
              </div>
            )}
          </div>

          <div className="mt-2 flex justify-end gap-2 border-t border-border pt-4">
            <Button variant="ghost" onClick={() => navigate('/money')}>
              Cancel
            </Button>
            <Button type="submit" busy={create.isPending || uploadDocument.isPending}>
              Save transaction
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
