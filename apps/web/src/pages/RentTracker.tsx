// Rent Collection (PRD §5.5): period selector, collected/outstanding/progress
// tiles, per-tenant rows with status text + days late, individual Remind and
// a confirmed "Remind all late" bulk action, and manual payment recording.
// The ledger itself stays deterministic; the one AI element is the single
// most recent late_rent insight card (clearly marked via AiSurface) since
// this is the page that insight is about.
import { useEffect, useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type { RentPaymentMethod, RentTrackerRow, SendRemindersResponse } from '@hearth/shared';
import { useSearchParams } from 'react-router-dom';
import {
  useConfirmTransaction,
  useInsights,
  useRecordPayment,
  useRentTracker,
  useSendReminders,
  useUnlinkDeposit,
  useUnlinkedRentDeposits,
} from '../api/queries';
import { AiSurface } from '../components/ai/AiSurface';
import { InsightCard } from '../components/ai/InsightCard';
import {
  ComposedRemindersModal,
  type ComposedReminder,
} from '../components/rent/ComposedRemindersModal';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { LiveRegion } from '../components/ui/LiveRegion';
import { Modal } from '../components/ui/Modal';
import { ProgressBar } from '../components/ui/ProgressBar';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { FormField, Input } from '../components/ui/FormField';
import { StatusBadge, type BadgeTone } from '../components/ui/StatusBadge';
import { RowActions } from '../components/ui/RowActions';
import { Table, Td, Th, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { IconBell, IconCalendarCheck, IconCheck } from '../components/ui/icons';
import { currentPeriod, formatDate, formatMonthLong, recentPeriods } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';
import { usePermissions } from '../lib/usePermissions';

function statusInfo(row: RentTrackerRow): { tone: BadgeTone; label: string; clock?: boolean } {
  switch (row.status) {
    case 'paid':
      return { tone: 'positive', label: 'Paid' };
    case 'partial':
      // A partial past the grace window is still late — say both.
      return {
        tone: 'warning',
        label:
          `Partial — ${formatUsd(row.paidCents)} of ${formatUsd(row.amountCents)}` +
          (row.daysLate != null
            ? ` · ${row.daysLate} ${row.daysLate === 1 ? 'day' : 'days'} late`
            : ''),
      };
    case 'late':
      return {
        tone: 'danger',
        label:
          row.daysLate != null
            ? `${row.daysLate} ${row.daysLate === 1 ? 'day' : 'days'} late`
            : 'Late',
      };
    case 'processing':
      return { tone: 'neutral', label: 'Processing', clock: true };
    case 'failed':
      return { tone: 'danger', label: 'Failed' };
    default:
      return { tone: 'neutral', label: 'Due' };
  }
}

export function RentTracker() {
  usePageTitle('Rent Collection');
  // ?period=YYYY-MM deep links (insight cards, push notifications) select the
  // period; the effect also covers same-route navigations (the late-rent card
  // renders on this page and its "Review" link points back here), which never
  // remount the component. Manual selector interaction stays state-driven.
  const [searchParams] = useSearchParams();
  const [period, setPeriod] = useState(() => {
    const requested = searchParams.get('period');
    return requested && recentPeriods().includes(requested) ? requested : currentPeriod();
  });
  useEffect(() => {
    const requested = searchParams.get('period');
    if (requested && recentPeriods().includes(requested)) setPeriod(requested);
  }, [searchParams]);
  const tracker = useRentTracker(period);
  const unlinkedDeposits = useUnlinkedRentDeposits(period);
  const linkDeposit = useConfirmTransaction();
  const remind = useSendReminders();
  const record = useRecordPayment();
  const { can } = usePermissions();
  const canRent = can('rent');
  const canMoney = can('money'); // linking a deposit confirms a transaction
  const { toast } = useToast();

  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [payRow, setPayRow] = useState<RentTrackerRow | null>(null);
  const [payMethod, setPayMethod] = useState<RentPaymentMethod>('manual');
  // Editable amount (dollars) — defaults to the remaining balance so a full
  // payment stays one click while a partial is a simple edit.
  const [payAmount, setPayAmount] = useState('');
  const [payError, setPayError] = useState<string | null>(null);
  // Which co-tenant paid ('' = unattributed) — only shown for shared leases.
  const [payTenantId, setPayTenantId] = useState('');
  const [depositsRow, setDepositsRow] = useState<RentTrackerRow | null>(null);
  const [composedReminders, setComposedReminders] = useState<ComposedReminder[]>([]);
  const unlink = useUnlinkDeposit();

  // Exactly one contextual AI card (newest late_rent) — this page is where
  // that insight points, so it surfaces here instead of a separate AI page.
  const insights = useInsights({ status: 'active' });
  const lateRentInsight = insights.data?.find((i) => i.type === 'late_rent');

  const rows = tracker.data?.rows ?? [];
  // Partial-but-past-grace rows are still owed and remindable.
  const lateRows = rows.filter(
    (row) => row.status === 'late' || (row.status === 'partial' && row.daysLate != null),
  );

  const summarizeReminders = (results: SendRemindersResponse['results']) => {
    const sent = results.filter((r) => r.status === 'sent').length;
    const skipped = results.length - sent;
    toast(
      `${sent} reminder${sent === 1 ? '' : 's'} composed${skipped > 0 ? `, ${skipped} skipped` : ''}.`,
      sent > 0 ? 'positive' : 'neutral',
    );
  };

  const remindOne = (row: RentTrackerRow) => {
    remind.mutate(
      { rentPaymentIds: [row.rentPaymentId] },
      {
        onSuccess: (res) => {
          summarizeReminders(res.results);
          const result = res.results.find((r) => r.status === 'sent');
          if (result?.mailto) {
            setComposedReminders([
              { tenantName: row.tenantName, mailto: result.mailto, subject: result.subject },
            ]);
          }
        },
        onError: () => toast('Could not compose the reminder. Try again.', 'danger'),
      },
    );
  };

  const remindAllLate = () => {
    remind.mutate(
      { rentPaymentIds: lateRows.map((row) => row.rentPaymentId) },
      {
        onSuccess: (res) => {
          setBulkConfirmOpen(false);
          summarizeReminders(res.results);
          const composed = res.results.flatMap((r) => {
            if (r.status !== 'sent' || !r.mailto) return [];
            const row = lateRows.find((lr) => lr.rentPaymentId === r.rentPaymentId);
            return row ? [{ tenantName: row.tenantName, mailto: r.mailto, subject: r.subject }] : [];
          });
          if (composed.length > 0) setComposedReminders(composed);
        },
        onError: () => {
          setBulkConfirmOpen(false);
          toast('Could not compose reminders. Try again.', 'danger');
        },
      },
    );
  };

  const recordPayment = () => {
    if (!payRow) return;
    const remainingCents = payRow.amountCents - payRow.paidCents;
    const amountNumber = Number(payAmount);
    const amountCents = Math.round(amountNumber * 100);
    if (!payAmount || Number.isNaN(amountNumber) || amountCents <= 0) {
      setPayError('Enter an amount greater than zero.');
      return;
    }
    if (amountCents > remainingCents) {
      setPayError(`No more than the ${formatUsd(remainingCents)} remaining can be recorded.`);
      return;
    }
    setPayError(null);
    record.mutate(
      {
        leaseId: payRow.leaseId,
        period,
        amountCents,
        method: payMethod,
        ...(payTenantId ? { tenantId: payTenantId } : {}),
      },
      {
        onSuccess: () => {
          toast(
            amountCents < remainingCents
              ? `Partial payment recorded for ${payRow.tenantName} — ${formatUsd(remainingCents - amountCents)} still due.`
              : `Payment recorded for ${payRow.tenantName}.`,
            'positive',
          );
          setPayRow(null);
        },
        onError: () => toast('Could not record the payment. Try again.', 'danger'),
      },
    );
  };

  const unlinkDeposit = (row: RentTrackerRow, depositId: string) => {
    unlink.mutate(
      { rentPaymentId: row.rentPaymentId, depositId },
      {
        onSuccess: () => {
          toast(`Deposit unlinked — ${row.tenantName}'s charge recomputed.`, 'positive');
          setDepositsRow(null);
        },
        onError: () => toast('Could not unlink the deposit. Try again.', 'danger'),
      },
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Rent Collection"
        breadcrumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Rent Collection' }]}
        actions={
          <div className="flex items-center gap-2">
            <label htmlFor="rent-period" className="text-sm font-medium text-ink-muted">
              Period
            </label>
            <Select
              id="rent-period"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="w-auto py-1.5"
            >
              {recentPeriods().map((p) => (
                <option key={p} value={p}>
                  {formatMonthLong(p)}
                </option>
              ))}
            </Select>
          </div>
        }
      />

      <LiveRegion>
        {lateRentInsight && <InsightCard insight={lateRentInsight} headingLevel={2} />}
      </LiveRegion>

      {tracker.isPending ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Card key={i}>
                <Skeleton className="h-16 w-full" />
              </Card>
            ))}
          </div>
          <Card flush className="p-4">
            <Skeleton className="h-64 w-full" />
          </Card>
        </>
      ) : tracker.isError ? (
        <ErrorNotice error={tracker.error} onRetry={() => void tracker.refetch()} />
      ) : (
        <>
          <section
            aria-label="Collection summary"
            className="grid grid-cols-1 gap-4 sm:grid-cols-3"
          >
            <Card>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Collected
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">
                {formatUsd(tracker.data.collectedCents)}
              </p>
              {tracker.data.partialUnits > 0 && (
                <p className="mt-1 text-xs text-ink-muted">
                  includes {tracker.data.partialUnits} partial payment
                  {tracker.data.partialUnits === 1 ? '' : 's'}
                </p>
              )}
            </Card>
            <Card>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Outstanding
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">
                {formatUsd(tracker.data.outstandingCents)}
              </p>
            </Card>
            <Card>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Progress
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">
                {tracker.data.totalUnits > 0
                  ? Math.round((tracker.data.paidUnits / tracker.data.totalUnits) * 100)
                  : 0}
                %
              </p>
              <ProgressBar
                value={tracker.data.paidUnits}
                max={tracker.data.totalUnits}
                label={`Rent collected for ${formatMonthLong(period)}`}
                text={`${tracker.data.paidUnits} of ${tracker.data.totalUnits} units`}
                className="mt-2"
              />
            </Card>
          </section>

          {(unlinkedDeposits.data?.items.length ?? 0) > 0 && (
            <section aria-label="Unlinked rent deposits" className="flex flex-col gap-2">
              {unlinkedDeposits.data!.items.map((item) => (
                <AiSurface key={item.transactionId}>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-ink">
                      A {formatUsd(item.amountCents)} Rent-categorized deposit (&ldquo;
                      {item.description}&rdquo;, {formatDate(item.date)}) isn&rsquo;t linked to
                      rent. It could apply to {item.tenantName}&rsquo;s{' '}
                      {formatMonthLong(item.period)} charge — {formatUsd(item.remainingCents)}{' '}
                      still due for {item.unitLabel} at {item.propertyLabel}.
                    </p>
                    {canMoney && (
                      <Button
                        variant="secondary"
                        busy={linkDeposit.isPending}
                        onClick={() =>
                          linkDeposit.mutate(
                            { id: item.transactionId, rentPaymentId: item.rentPaymentId },
                            {
                              onSuccess: () =>
                                toast(
                                  `Deposit applied to ${item.tenantName}'s ${formatMonthLong(item.period)} rent.`,
                                  'positive',
                                ),
                              onError: () =>
                                toast('Could not link the deposit. Try again.', 'danger'),
                            },
                          )
                        }
                      >
                        Link to rent
                      </Button>
                    )}
                  </div>
                </AiSurface>
              ))}
            </section>
          )}

          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-ink">
              {formatMonthLong(period)} — per tenant
            </h2>
            {canRent && (
              <Button
                variant="secondary"
                disabled={lateRows.length === 0}
                onClick={() => setBulkConfirmOpen(true)}
              >
                <IconBell size={14} />
                Remind all late ({lateRows.length})
              </Button>
            )}
          </div>

          {rows.length === 0 ? (
            <Card flush>
              <EmptyState
                icon={<IconCalendarCheck size={28} />}
                title="No rent due this period"
                body="Rows appear here once active leases exist for the selected month."
              />
            </Card>
          ) : (
            <Card flush>
              <Table caption={`Rent tracker for ${formatMonthLong(period)} — tenant, amount, due date, status`}>
                <thead>
                  <tr>
                    <Th>Tenant</Th>
                    <Th>Unit / property</Th>
                    <Th align="right">Amount</Th>
                    <Th>Due</Th>
                    <Th>Status</Th>
                    <Th>Paid</Th>
                    <Th stickyRight>
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const info = statusInfo(row);
                    const unpaid =
                      row.status === 'due' ||
                      row.status === 'late' ||
                      row.status === 'failed' ||
                      row.status === 'partial';
                    return (
                      <Tr key={row.rentPaymentId}>
                        <Td className="font-medium">
                          {row.tenants.length > 1 ? (
                            <ul className="flex flex-col gap-0.5">
                              {row.tenants.map((t) => (
                                <li key={t.tenantId} className="flex items-center gap-2">
                                  <span>{t.tenantName}</span>
                                  <span className="text-xs font-normal text-ink-muted">
                                    {formatUsd(t.shareCents)}
                                    {t.shareSpecified ? '' : ' (even split)'} ·{' '}
                                    {t.settled
                                      ? 'paid'
                                      : t.paidCents > 0
                                        ? `${formatUsd(t.paidCents)} of share`
                                        : 'due'}
                                  </span>
                                </li>
                              ))}
                              {row.sharesMismatch && (
                                <li className="text-xs font-normal text-warning">
                                  Shares don&rsquo;t add up to the {formatUsd(row.amountCents)}{' '}
                                  charge
                                </li>
                              )}
                            </ul>
                          ) : (
                            row.tenantName
                          )}
                        </Td>
                        <Td>
                          {row.unitLabel}
                          <span className="text-ink-muted"> · {row.propertyLabel}</span>
                        </Td>
                        <Td align="right">{formatUsd(row.amountCents)}</Td>
                        <Td className="whitespace-nowrap">{formatDate(row.dueDate)}</Td>
                        <Td>
                          <StatusBadge tone={info.tone} icon={info.clock ? 'clock' : undefined}>
                            {info.label}
                          </StatusBadge>
                        </Td>
                        <Td className="whitespace-nowrap">
                          {row.paidAt ? (
                            <>
                              {formatDate(row.paidAt)}
                              {row.method && (
                                <span className="text-xs text-ink-muted"> · {row.method}</span>
                              )}
                            </>
                          ) : (
                            '—'
                          )}
                        </Td>
                        <Td stickyRight>
                          {canRent && (
                          <RowActions
                            context={row.tenantName}
                            actions={[
                              ...(row.status === 'late' ||
                              (row.status === 'partial' && row.daysLate != null)
                                ? [
                                    {
                                      label: 'Remind',
                                      icon: <IconBell size={12} />,
                                      variant: 'secondary' as const,
                                      busy: remind.isPending,
                                      onClick: () => remindOne(row),
                                    },
                                  ]
                                : []),
                              ...(unpaid
                                ? [
                                    {
                                      label: row.status === 'partial' ? 'Record payment' : 'Mark paid',
                                      icon: <IconCheck size={14} />,
                                      onClick: () => {
                                        setPayMethod('manual');
                                        setPayAmount(
                                          ((row.amountCents - row.paidCents) / 100).toFixed(2),
                                        );
                                        setPayError(null);
                                        setPayTenantId('');
                                        setPayRow(row);
                                      },
                                    },
                                  ]
                                : []),
                              ...(row.deposits.length > 0
                                ? [
                                    {
                                      label: 'Deposits',
                                      variant: 'secondary' as const,
                                      onClick: () => setDepositsRow(row),
                                    },
                                  ]
                                : []),
                            ]}
                          />
                          )}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            </Card>
          )}
        </>
      )}

      <Modal
        open={bulkConfirmOpen}
        onClose={() => setBulkConfirmOpen(false)}
        title="Send reminders to all late tenants?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulkConfirmOpen(false)}>
              Cancel
            </Button>
            <Button busy={remind.isPending} onClick={remindAllLate}>
              Send {lateRows.length} reminder{lateRows.length === 1 ? '' : 's'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">
          A payment reminder email will be composed for{' '}
          {lateRows.map((row) => row.tenantName).join(', ')} — you'll get a link to open and send
          each one from your own mail app. Already-paid rows are skipped.
        </p>
      </Modal>

      <ComposedRemindersModal
        reminders={composedReminders}
        onClose={() => setComposedReminders([])}
      />

      <Modal
        open={payRow !== null}
        onClose={() => setPayRow(null)}
        title={payRow ? `Record payment — ${payRow.tenantName}` : 'Record payment'}
        size="sm"
      >
        {payRow && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-ink-muted">
              {payRow.paidCents > 0
                ? `${formatUsd(payRow.amountCents - payRow.paidCents)} remaining of ${formatUsd(payRow.amountCents)}`
                : formatUsd(payRow.amountCents)}{' '}
              for {formatMonthLong(period)} · {payRow.unitLabel} · {payRow.propertyLabel}
            </p>
            <FormField
              label="Amount received (USD)"
              htmlFor="pay-amount"
              error={payError ?? undefined}
              hint="Less than the remaining balance records a partial payment."
              required
            >
              <Input
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
              />
            </FormField>
            {payRow.tenants.length > 1 && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="pay-tenant" className="text-sm font-medium text-ink">
                  Paid by
                </label>
                <Select
                  id="pay-tenant"
                  value={payTenantId}
                  onChange={(e) => setPayTenantId(e.target.value)}
                >
                  <option value="">Not specified</option>
                  {payRow.tenants.map((t) => (
                    <option key={t.tenantId} value={t.tenantId}>
                      {t.tenantName} — {formatUsd(t.shareCents)} share
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="pay-method" className="text-sm font-medium text-ink">
                Payment method
              </label>
              <Select
                id="pay-method"
                value={payMethod}
                onChange={(e) => setPayMethod(e.target.value as RentPaymentMethod)}
              >
                <option value="manual">Manual (check / cash)</option>
                <option value="online">Online (recorded manually)</option>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPayRow(null)}>
                Cancel
              </Button>
              <Button busy={record.isPending} onClick={recordPayment}>
                Record payment
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={depositsRow !== null}
        onClose={() => setDepositsRow(null)}
        title={depositsRow ? `Deposits — ${depositsRow.tenantName}` : 'Deposits'}
        size="sm"
      >
        {depositsRow && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-ink-muted">
              {formatUsd(depositsRow.paidCents)} of {formatUsd(depositsRow.amountCents)} received for{' '}
              {formatMonthLong(period)}. Unlinking a deposit recomputes the charge; the ledger
              transaction itself is kept.
            </p>
            <ul className="flex flex-col gap-2">
              {depositsRow.deposits.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border-strong px-3 py-2 text-sm"
                >
                  <span className="tabular-nums font-medium text-ink">
                    {formatUsd(d.amountCents)}
                  </span>
                  <span className="text-ink-muted">
                    {formatDate(d.paidAt)}
                    {d.method ? ` · ${d.method}` : ''}
                  </span>
                  {canRent && (
                    <Button
                      variant="ghost"
                      busy={unlink.isPending}
                      onClick={() => unlinkDeposit(depositsRow, d.id)}
                    >
                      Unlink
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => setDepositsRow(null)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
