// Move/relink a document to another entity. v1 offers three target kinds —
// Transaction, Property, Tenant (units/leases deliberately out of scope).
// Confirm PATCHes { entityType, entityId }; the transaction target is picked
// from a live search over the ledger (defaults to the most recent rows).
import { useEffect, useState, type FormEvent } from 'react';
import { formatUsd } from '@hearth/shared';
import type { DocumentEntityType, DocumentListRow } from '@hearth/shared';
import { useProperties, useTenants, useTransactions, useUpdateDocument } from '../../api/queries';
import { Button } from '../ui/Button';
import { FormField, Input } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { useToast } from '../ui/Toast';
import { formatDate } from '../../lib/format';
import { cx } from '../../lib/cx';

type MoveTargetKind = 'transaction' | 'property' | 'tenant';

const KIND_LABEL: Record<MoveTargetKind, string> = {
  transaction: 'Transaction',
  property: 'Property',
  tenant: 'Tenant',
};

// A document can also attach to a unit or lease, but the move modal only
// offers these three kinds — fall back to Property when the current target
// is out of scope.
function defaultKind(entityType: DocumentEntityType): MoveTargetKind {
  return entityType === 'transaction' || entityType === 'tenant' ? entityType : 'property';
}

export interface MoveDocumentModalProps {
  /** The document being moved; the modal is open whenever this is non-null. */
  document: DocumentListRow | null;
  onClose: () => void;
}

export function MoveDocumentModal({ document, onClose }: MoveDocumentModalProps) {
  const open = document !== null;
  const updateDocument = useUpdateDocument();
  const { toast } = useToast();

  const [kind, setKind] = useState<MoveTargetKind>('property');
  const [targetId, setTargetId] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | undefined>();

  const properties = useProperties();
  const tenants = useTenants();
  // No search text yet: the query still runs and returns the default
  // (most-recent) page, matching the scope's "sensible default list" call.
  const transactions = useTransactions({ q: search.trim() || undefined, limit: 10 });

  useEffect(() => {
    if (!document) return;
    setKind(defaultKind(document.entityType));
    setTargetId(document.entityType === 'transaction' ? document.entityId : '');
    setSearch('');
    setError(undefined);
  }, [document]);

  const chooseKind = (next: MoveTargetKind) => {
    setKind(next);
    setTargetId('');
    setError(undefined);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!document) return;
    if (!targetId) {
      setError(`Choose a ${KIND_LABEL[kind].toLowerCase()} to move this document to.`);
      return;
    }
    updateDocument.mutate(
      {
        id: document.id,
        entityType: kind,
        entityId: targetId,
        currentEntityType: document.entityType,
      },
      {
        onSuccess: () => {
          toast(`${document.name} moved to a different ${kind}.`, 'positive');
          onClose();
        },
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not move the document.', 'danger'),
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Move document">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-ink">Attach to</legend>
          <div className="flex flex-wrap gap-4" role="radiogroup" aria-label="Attach to">
            {(['transaction', 'property', 'tenant'] as const).map((k) => (
              <label key={k} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input
                  type="radio"
                  name="move-doc-target-kind"
                  value={k}
                  checked={kind === k}
                  onChange={() => chooseKind(k)}
                  className="h-4 w-4 border-border-strong text-brand"
                />
                <span>{KIND_LABEL[k]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {kind === 'property' && (
          <FormField label="Property" htmlFor="move-doc-property" error={error} required>
            <Select
              value={targetId}
              onChange={(e) => {
                setTargetId(e.target.value);
                setError(undefined);
              }}
            >
              <option value="">Choose a property…</option>
              {(properties.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nickname ?? p.addressLine1}
                </option>
              ))}
            </Select>
          </FormField>
        )}

        {kind === 'tenant' && (
          <FormField label="Tenant" htmlFor="move-doc-tenant" error={error} required>
            <Select
              value={targetId}
              onChange={(e) => {
                setTargetId(e.target.value);
                setError(undefined);
              }}
            >
              <option value="">Choose a tenant…</option>
              {(tenants.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.fullName}
                </option>
              ))}
            </Select>
          </FormField>
        )}

        {kind === 'transaction' && (
          <div className="flex flex-col gap-1.5">
            <FormField
              label="Search transactions"
              htmlFor="move-doc-txn-search"
              hint="Shows the most recent transactions by default."
            >
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by description or vendor"
              />
            </FormField>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm font-medium text-ink">
                Transaction
                <span aria-hidden="true" className="text-danger">
                  {' '}
                  *
                </span>
              </legend>
              <div
                role="radiogroup"
                aria-label="Transaction"
                aria-describedby={error ? 'move-doc-txn-error' : undefined}
                className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border border-border-strong p-1"
              >
                {transactions.isPending ? (
                  <p className="px-2 py-3 text-sm text-ink-muted">Loading transactions…</p>
                ) : (transactions.data?.items.length ?? 0) === 0 ? (
                  <p className="px-2 py-3 text-sm text-ink-muted">No transactions match.</p>
                ) : (
                  (transactions.data?.items ?? []).map((t) => (
                    <label
                      key={t.id}
                      className={cx(
                        'flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 text-sm transition-colors duration-fast hover:bg-surface-sunken',
                        targetId === t.id && 'bg-brand-soft',
                      )}
                    >
                      <input
                        type="radio"
                        name="move-doc-transaction"
                        value={t.id}
                        checked={targetId === t.id}
                        onChange={() => {
                          setTargetId(t.id);
                          setError(undefined);
                        }}
                        className="mt-0.5 h-4 w-4 border-border-strong text-brand"
                      />
                      <span className="flex flex-1 flex-col">
                        <span className="flex items-center justify-between gap-2">
                          <span className="font-medium text-ink">{t.description}</span>
                          <span className={t.type === 'income' ? 'text-positive' : 'text-ink'}>
                            {t.type === 'income' ? '+' : '−'}
                            {formatUsd(t.amountCents)}
                          </span>
                        </span>
                        <span className="text-xs text-ink-muted">
                          {formatDate(t.date)}
                          {t.vendor ? ` · ${t.vendor}` : ''}
                        </span>
                      </span>
                    </label>
                  ))
                )}
              </div>
              {error && (
                <p id="move-doc-txn-error" className="text-xs font-medium text-danger">
                  {error}
                </p>
              )}
            </fieldset>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={updateDocument.isPending}>
            Move
          </Button>
        </div>
      </form>
    </Modal>
  );
}
