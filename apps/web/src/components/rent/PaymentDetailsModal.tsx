// Payment details modal for the rent tracker (extracted from RentTracker.tsx)
// — purely presentational: summary + late-fee waive row + per-tenant share
// breakdown (for split leases) + linked deposits with Unlink and (for a
// shared lease) a "Paid by" repair select, all driven by the parent's
// mutation state so this component owns no data fetching.
import { formatUsd } from '@hearth/shared';
import type { RentTrackerRow } from '@hearth/shared';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { formatDate, formatMonthLong } from '../../lib/format';

export interface PaymentDetailsModalProps {
  /** null = closed (the Modal's `open` prop is `row !== null`). */
  row: RentTrackerRow | null;
  /** YYYY-MM period the tracker is showing. */
  period: string;
  canRent: boolean;
  unlinkBusy: boolean;
  onUnlink: (depositId: string) => void;
  /** True while any deposit's "Paid by" repair is in flight. */
  attributeBusy: boolean;
  /** Re-points (or, with `null`, clears) which co-tenant a deposit credits.
   *  Attribution only — no money moves. */
  onAttribute: (depositId: string, tenantId: string | null) => void;
  /** Opens the waive confirm; the parent closes this modal itself. */
  onWaive: () => void;
  onClose: () => void;
}

export function PaymentDetailsModal({
  row,
  period,
  canRent,
  unlinkBusy,
  onUnlink,
  attributeBusy,
  onAttribute,
  onWaive,
  onClose,
}: PaymentDetailsModalProps): JSX.Element {
  const showTenants = row !== null && row.tenants.length > 1;
  return (
    <Modal
      open={row !== null}
      onClose={onClose}
      title={row ? `Payment details — ${row.tenantName}` : 'Payment details'}
      size="sm"
    >
      {row && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-muted">
            {formatUsd(row.paidCents)} of {formatUsd(row.amountCents + row.lateFeeCents)} received
            for {formatMonthLong(period)}
            {row.lateFeeCents > 0 && ` (includes ${formatUsd(row.lateFeeCents)} late fee)`}. Unlinking
            a deposit recomputes the charge; the ledger transaction itself is kept.
          </p>
          {row.lateFeeCents > 0 && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border-strong px-3 py-2 text-sm">
              <span>
                <span className="tabular-nums font-medium text-ink">
                  {formatUsd(row.lateFeeCents)}
                </span>
                <span className="text-ink-muted"> late fee applied</span>
              </span>
              {canRent && (
                <Button variant="ghost" onClick={onWaive}>
                  Waive
                </Button>
              )}
            </div>
          )}
          {showTenants && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Tenants
              </p>
              <ul className="flex flex-col gap-0.5">
                {row.tenants.map((t) => (
                  <li key={t.tenantId} className="flex items-center gap-2">
                    <span>{t.tenantName}</span>
                    <span className="text-xs font-normal text-ink-muted">
                      {formatUsd(t.shareCents)}
                      {t.shareSpecified ? '' : ' (even split)'} ·{' '}
                      {t.settled ? 'paid' : t.paidCents > 0 ? `${formatUsd(t.paidCents)} of share` : 'due'}
                    </span>
                  </li>
                ))}
              </ul>
              {row.sharesMismatch && (
                <p className="text-xs font-normal text-warning">
                  Shares don&rsquo;t add up to the {formatUsd(row.amountCents)} charge
                </p>
              )}
            </div>
          )}
          {showTenants && row.deposits.length > 0 && (
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Deposits
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {row.deposits.map((d) => (
              <li
                key={d.id}
                className="flex flex-col gap-1.5 rounded-md border border-border-strong px-3 py-2 text-sm"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="tabular-nums font-medium text-ink">
                    {formatUsd(d.amountCents)}
                  </span>
                  <span className="text-ink-muted">
                    {formatDate(d.paidAt)}
                    {d.method ? ` · ${d.method}` : ''}
                  </span>
                  {canRent && (
                    <Button variant="ghost" busy={unlinkBusy} onClick={() => onUnlink(d.id)}>
                      Unlink
                    </Button>
                  )}
                </div>
                {/* Only for a shared lease — a single-tenant charge has
                    exactly one possible payer, so there's nothing to repair.
                    "Not recorded" is a legitimate, expected state (unlinked
                    from an ambiguous descriptor), not an error — the select
                    offers it plainly rather than forcing a choice. */}
                {showTenants &&
                  (canRent ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <label
                        htmlFor={`deposit-tenant-${d.id}`}
                        className="text-xs font-medium text-ink-muted"
                      >
                        Paid by
                      </label>
                      <Select
                        id={`deposit-tenant-${d.id}`}
                        value={d.tenantId ?? ''}
                        disabled={attributeBusy}
                        onChange={(e) => onAttribute(d.id, e.target.value || null)}
                        className="w-auto py-1"
                      >
                        <option value="">Not recorded</option>
                        {row.tenants.map((t) => (
                          <option key={t.tenantId} value={t.tenantId}>
                            {t.tenantName}
                          </option>
                        ))}
                      </Select>
                    </div>
                  ) : (
                    <p className="text-xs text-ink-muted">
                      Paid by{' '}
                      <span className="font-medium text-ink">
                        {row.tenants.find((t) => t.tenantId === d.tenantId)?.tenantName ??
                          'not recorded'}
                      </span>
                    </p>
                  ))}
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
