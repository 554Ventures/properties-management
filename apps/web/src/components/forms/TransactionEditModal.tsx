// Edit a ledger transaction's attribution (property/unit/category) — the
// lightweight path for bank imports that were confirmed without a property
// and would otherwise be missing from property-scoped reports.
import { useEffect, useState } from 'react';
import type { Transaction, TransactionClassification } from '@hearth/shared';
import {
  useCategories,
  useProperties,
  usePropertyDetail,
  useUpdateTransaction,
} from '../../api/queries';
import { Button } from '../ui/Button';
import { FormField } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { useToast } from '../ui/Toast';

export interface TransactionEditModalProps {
  open: boolean;
  onClose: () => void;
  transaction: Transaction | null;
}

export function TransactionEditModal({ open, onClose, transaction }: TransactionEditModalProps) {
  const update = useUpdateTransaction();
  const properties = useProperties();
  const categories = useCategories();
  const { toast } = useToast();
  const [propertyId, setPropertyId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [classification, setClassification] = useState<TransactionClassification | ''>('');

  useEffect(() => {
    if (open && transaction) {
      setPropertyId(transaction.propertyId ?? '');
      setUnitId(transaction.unitId ?? '');
      setCategoryId(transaction.categoryId ?? '');
      setClassification(transaction.classification ?? '');
    }
  }, [open, transaction]);

  const propertyDetail = usePropertyDetail(propertyId || undefined);
  const units = propertyDetail.data?.units ?? [];
  // A refund nets against an EXPENSE category, so the picker flips type.
  const categoryType = classification === 'refund' ? 'expense' : transaction?.type;
  const categoryOptions = (categories.data ?? []).filter((c) => c.type === categoryType);

  const save = () => {
    if (!transaction) return;
    update.mutate(
      {
        id: transaction.id,
        // The PATCH contract treats omitted fields as "leave unchanged" and
        // has no "clear" value yet (known contract limitation), so blanked
        // selections are simply not sent.
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
    <Modal open={open} onClose={onClose} title="Edit transaction" size="sm">
      <div className="flex flex-col gap-4">
        {transaction && (
          <p className="text-sm text-ink-muted">
            {transaction.description}
            {transaction.vendor ? ` · ${transaction.vendor}` : ''}
          </p>
        )}
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
        <FormField label="Category" htmlFor="edit-txn-category">
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
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
          hint="Transfers and owner contributions leave P&L entirely; a refund nets against its expense category."
        >
          <Select
            value={classification}
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
