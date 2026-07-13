// Co-tenant management for a lease: list current tenants (remove), add another
// from the tenant picker. The backend enforces the guards (can't remove the
// last tenant; removing the primary auto-promotes) — we surface any guard-trip
// error message inline and via toast.
import { useEffect, useState } from 'react';
import {
  useAddLeaseTenant,
  useLeaseDetail,
  useRemoveLeaseTenant,
  useSetLeaseTenantShare,
  useTenants,
} from '../../api/queries';
import { Button } from '../ui/Button';
import { ErrorNotice } from '../ui/ErrorNotice';
import { FormField, Input } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { Skeleton } from '../ui/Skeleton';
import { useToast } from '../ui/Toast';
import { InlineNewTenant } from './InlineNewTenant';

export interface LeaseTenantsModalProps {
  open: boolean;
  onClose: () => void;
  leaseId: string;
}

export function LeaseTenantsModal({ open, onClose, leaseId }: LeaseTenantsModalProps) {
  const detail = useLeaseDetail(open ? leaseId : undefined);
  const tenants = useTenants();
  const addTenant = useAddLeaseTenant();
  const removeTenant = useRemoveLeaseTenant();
  const setShare = useSetLeaseTenantShare();
  const { toast } = useToast();
  const [pick, setPick] = useState('');
  const [inlineError, setInlineError] = useState<string | undefined>();
  // Draft share values (dollars, '' = unspecified/even split), keyed by tenant
  // id; seeded from the lease detail whenever the modal opens or reloads.
  const [shares, setShares] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      setPick('');
      setInlineError(undefined);
    }
  }, [open]);

  const current = detail.data?.lease.tenants ?? [];

  useEffect(() => {
    if (!open || !detail.data) return;
    setShares(
      Object.fromEntries(
        detail.data.lease.tenants.map((t) => [
          t.id,
          t.shareCents != null ? (t.shareCents / 100).toFixed(2) : '',
        ]),
      ),
    );
  }, [open, detail.data]);

  const saveShare = (tenantId: string) => {
    const raw = (shares[tenantId] ?? '').trim();
    const prior = current.find((t) => t.id === tenantId)?.shareCents ?? null;
    const next = raw === '' ? null : Math.round(Number(raw) * 100);
    if (next !== null && (Number.isNaN(next) || next < 0)) return; // ignore junk input
    if (next === prior) return;
    setShare.mutate(
      { leaseId, tenantId, shareCents: next },
      {
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not save the share.', 'danger'),
      },
    );
  };

  // Soft warning only — mismatched shares are allowed by design.
  const rentCents = detail.data?.lease.rentCents ?? 0;
  const draftSum = current.reduce((s, t) => {
    const raw = (shares[t.id] ?? '').trim();
    return raw === '' ? NaN : s + Math.round(Number(raw) * 100);
  }, 0);
  const shareSumMismatch = !Number.isNaN(draftSum) && draftSum !== rentCents;
  const currentIds = new Set(current.map((t) => t.id));
  const available = (tenants.data ?? []).filter((t) => !currentIds.has(t.id));

  const addToLease = (tenantId: string) => {
    setInlineError(undefined);
    addTenant.mutate(
      { leaseId, tenantId },
      {
        onSuccess: () => {
          toast('Tenant added to the lease.', 'positive');
          setPick('');
        },
        onError: (err) => {
          const message = err instanceof Error ? err.message : 'Could not add the tenant.';
          setInlineError(message);
          toast(message, 'danger');
        },
      },
    );
  };

  const add = () => {
    if (!pick) return;
    addToLease(pick);
  };

  const remove = (tenantId: string, name: string) => {
    setInlineError(undefined);
    removeTenant.mutate(
      { leaseId, tenantId },
      {
        onSuccess: () => toast(`${name} removed from the lease.`, 'positive'),
        onError: (err) => {
          const message = err instanceof Error ? err.message : 'Could not remove the tenant.';
          setInlineError(message);
          toast(message, 'danger');
        },
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Manage co-tenants">
      <div className="flex flex-col gap-4">
        {detail.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : detail.isError ? (
          <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} />
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {current.map((t, i) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1 text-ink">
                    {t.fullName}
                    {i === 0 && <span className="ml-2 text-xs text-ink-muted">(primary)</span>}
                  </span>
                  {current.length > 1 && (
                    <span className="flex items-center gap-1.5">
                      <label htmlFor={`share-${t.id}`} className="text-xs text-ink-muted">
                        Share (USD)
                      </label>
                      <Input
                        id={`share-${t.id}`}
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        placeholder="even split"
                        className="w-28 py-1"
                        value={shares[t.id] ?? ''}
                        onChange={(e) =>
                          setShares((prev) => ({ ...prev, [t.id]: e.target.value }))
                        }
                        onBlur={() => saveShare(t.id)}
                      />
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    busy={removeTenant.isPending}
                    onClick={() => remove(t.id, t.fullName)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            {current.length > 1 && shareSumMismatch && (
              <p className="text-xs font-medium text-warning">
                Shares don&rsquo;t add up to the monthly rent — that&rsquo;s allowed, but
                per-tenant paid/due may look off.
              </p>
            )}
          </>
        )}

        {inlineError && (
          <p className="text-xs font-medium text-danger" role="alert">
            {inlineError}
          </p>
        )}

        <div className="flex items-end gap-2">
          <FormField label="Add a tenant" htmlFor="cotenant-pick" className="flex-1">
            <Select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Select a tenant…</option>
              {available.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.fullName}
                </option>
              ))}
            </Select>
          </FormField>
          <Button busy={addTenant.isPending} disabled={!pick} onClick={add}>
            Add
          </Button>
        </div>

        <InlineNewTenant onCreated={(tenant) => addToLease(tenant.id)} />

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}
