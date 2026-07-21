// Rent Collection (PRD §5.5) — KpiTile summary row (collected/outstanding
// against billed, units-paid progress) and a single triage-first table
// (late → partial → due → paid) with status filter chips and per-row actions
// incl. manual payment recording. The ledger itself stays deterministic; ALL
// AI content shares one AiSurface panel at the top — the single most recent
// late_rent insight (this is the page that insight is about) plus any
// unlinked rent-deposit suggestions — so the page has exactly one ✦ AI area.
import { useEffect, useMemo, useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type { RentPaymentMethod, RentTrackerRow, SendRemindersResponse } from '@hearth/shared';
import { useSearchParams } from 'react-router-dom';
import {
  useApplyLateFee,
  useConfirmTransaction,
  useInsights,
  useRecordPayment,
  useRentTracker,
  useSendReminders,
  useUnlinkDeposit,
  useUnlinkedRentDeposits,
  useWaiveLateFee,
} from '../api/queries';
import { AiSurface } from '../components/ai/AiSurface';
import { InsightCard } from '../components/ai/InsightCard';
import {
  ComposedRemindersModal,
  type ComposedReminder,
} from '../components/rent/ComposedRemindersModal';
import { PaymentDetailsModal } from '../components/rent/PaymentDetailsModal';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { FilterChips } from '../components/ui/FilterChips';
import { KpiTile, KpiTileSkeleton } from '../components/ui/KpiTile';
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
import { IconBell, IconCalendarCheck, IconCheck, IconDollar } from '../components/ui/icons';
import { currentPeriod, formatDate, formatMonthLong, recentPeriods } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';
import { usePermissions } from '../lib/usePermissions';

// Badges stay short and glanceable — paid-so-far and late-fee detail live in
// the Amount/Remaining columns, not the status label.
function statusInfo(row: RentTrackerRow): { tone: BadgeTone; label: string; clock?: boolean } {
  switch (row.status) {
    case 'paid':
      return { tone: 'positive', label: 'Paid' };
    case 'partial':
      return {
        tone: 'warning',
        label: row.daysLate != null ? `Partial · ${row.daysLate}d` : 'Partial',
      };
    case 'late':
      return { tone: 'danger', label: row.daysLate != null ? `Late · ${row.daysLate}d` : 'Late' };
    case 'processing':
      return { tone: 'neutral', label: 'Processing', clock: true };
    case 'failed':
      return { tone: 'danger', label: 'Failed' };
    default:
      return { tone: 'neutral', label: 'Due' };
  }
}

type StatusFilter = 'all' | 'late' | 'partial' | 'due' | 'paid';

// Chip buckets: Due absorbs processing/failed (the badge still distinguishes
// them inside the bucket); Partial covers both in-grace and late partials.
const FILTER_STATUSES: Record<
  Exclude<StatusFilter, 'all'>,
  ReadonlyArray<RentTrackerRow['status']>
> = {
  late: ['late'],
  partial: ['partial'],
  due: ['due', 'processing', 'failed'],
  paid: ['paid'],
};

const FILTER_LABELS: Record<StatusFilter, string> = {
  all: 'All',
  late: 'Late',
  partial: 'Partial',
  due: 'Due',
  paid: 'Paid',
};

// Triage order — rows needing action float to the top; a partial past its
// grace window outranks one still in grace.
function triageRank(row: RentTrackerRow): number {
  if (row.status === 'late') return 0;
  if (row.status === 'partial') return row.daysLate != null ? 1 : 2;
  if (row.status === 'failed') return 3;
  if (row.status === 'due') return 4;
  if (row.status === 'processing') return 5;
  return 6; // paid
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
  const applyFee = useApplyLateFee();
  const waiveFee = useWaiveLateFee();
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
  const [detailsRow, setDetailsRow] = useState<RentTrackerRow | null>(null);
  const [composedReminders, setComposedReminders] = useState<ComposedReminder[]>([]);
  const unlink = useUnlinkDeposit();
  // Apply/waive confirm dialogs (WS7) — separate top-level dialogs rather
  // than nesting inside the details modal, matching the rest of the page's
  // one-dialog-at-a-time pattern.
  const [feeRow, setFeeRow] = useState<RentTrackerRow | null>(null);
  const [waiveRow, setWaiveRow] = useState<RentTrackerRow | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // Exactly one contextual AI card (newest late_rent) — this page is where
  // that insight points, so it surfaces here instead of a separate AI page.
  const insights = useInsights({ status: 'active' });
  const lateRentInsight = insights.data?.find((i) => i.type === 'late_rent');

  const rows = tracker.data?.rows ?? [];
  const unlinkedItems = unlinkedDeposits.data?.items ?? [];
  // Partial-but-past-grace rows are still owed and remindable.
  const lateRows = rows.filter(
    (row) => row.status === 'late' || (row.status === 'partial' && row.daysLate != null),
  );

  const sortedRows = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          triageRank(a) - triageRank(b) ||
          (b.daysLate ?? -1) - (a.daysLate ?? -1) ||
          a.dueDate.localeCompare(b.dueDate) ||
          a.tenantName.localeCompare(b.tenantName),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracker.data],
  );
  const visibleRows =
    statusFilter === 'all'
      ? sortedRows
      : sortedRows.filter((row) => FILTER_STATUSES[statusFilter].includes(row.status));
  const chipOptions = (['all', 'late', 'partial', 'due', 'paid'] as const).map((value) => ({
    value,
    label: FILTER_LABELS[value],
    count:
      value === 'all'
        ? rows.length
        : rows.filter((row) => FILTER_STATUSES[value].includes(row.status)).length,
  }));

  const billedCents = (tracker.data?.collectedCents ?? 0) + (tracker.data?.outstandingCents ?? 0);
  const paidPct =
    tracker.data && tracker.data.totalUnits > 0
      ? Math.round((tracker.data.paidUnits / tracker.data.totalUnits) * 100)
      : 0;

  // "2 sent, 1 composed for manual send" — a row only counts as *sent* when
  // the server really emailed it (deliveredVia 'email', F1); mailto rows were
  // only composed and still need the user's own mail app.
  const summarizeReminders = (results: SendRemindersResponse['results']) => {
    const sentRows = results.filter((r) => r.status === 'sent');
    const emailed = sentRows.filter((r) => r.deliveredVia === 'email').length;
    const composed = sentRows.length - emailed;
    const skipped = results.length - sentRows.length;
    const parts: string[] = [];
    if (emailed > 0) parts.push(`${emailed} reminder${emailed === 1 ? '' : 's'} sent`);
    if (composed > 0)
      parts.push(
        emailed > 0
          ? `${composed} composed for manual send`
          : `${composed} reminder${composed === 1 ? '' : 's'} composed`,
      );
    if (parts.length === 0) parts.push('0 reminders composed');
    toast(
      `${parts.join(', ')}${skipped > 0 ? `, ${skipped} skipped` : ''}.`,
      sentRows.length > 0 ? 'positive' : 'neutral',
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
              {
                tenantName: row.tenantName,
                mailto: result.mailto,
                subject: result.subject,
                deliveredVia: result.deliveredVia,
                to: result.to,
              },
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
            return row
              ? [
                  {
                    tenantName: row.tenantName,
                    mailto: r.mailto,
                    subject: r.subject,
                    deliveredVia: r.deliveredVia,
                    to: r.to,
                  },
                ]
              : [];
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
    // Remaining balance is against the total the charge owes, not just base
    // rent (WS7: totalDue = amountCents + lateFeeCents).
    const remainingCents = payRow.amountCents + payRow.lateFeeCents - payRow.paidCents;
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
          setDetailsRow(null);
        },
        onError: () => toast('Could not unlink the deposit. Try again.', 'danger'),
      },
    );
  };

  // Server resolves the effective policy (lease override or account
  // default) — the tracker doesn't know the amount up front, so feeCents is
  // omitted and the confirm copy stays amount-free until the response lands.
  const confirmApplyFee = () => {
    if (!feeRow) return;
    applyFee.mutate(
      { id: feeRow.rentPaymentId },
      {
        onSuccess: (updated) => {
          toast(`Late fee of ${formatUsd(updated.lateFeeCents)} applied.`, 'positive');
          setFeeRow(null);
        },
        onError: (err) =>
          toast(
            err instanceof Error ? err.message : 'Could not apply the late fee. Try again.',
            'danger',
          ),
      },
    );
  };

  const confirmWaiveFee = () => {
    if (!waiveRow) return;
    waiveFee.mutate(waiveRow.rentPaymentId, {
      onSuccess: () => {
        toast(`Late fee waived for ${waiveRow.tenantName}.`, 'positive');
        setWaiveRow(null);
      },
      onError: (err) =>
        toast(
          err instanceof Error ? err.message : 'Could not waive the late fee. Try again.',
          'danger',
        ),
    });
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

      {/* The page's single AI panel — the newest late_rent insight and any
          unlinked-deposit suggestions share one AiSurface (one ✦ badge)
          instead of stacking separate bordered boxes around the KPI row. */}
      <LiveRegion>
        {(lateRentInsight || unlinkedItems.length > 0) && (
          <section aria-label="AI insights">
            <AiSurface>
              {lateRentInsight && (
                <InsightCard insight={lateRentInsight} headingLevel={2} surface={false} />
              )}
              {unlinkedItems.length > 0 && (
                <div
                  className={
                    lateRentInsight ? 'mt-4 flex flex-col gap-1 border-t border-border pt-3' : 'flex flex-col gap-1'
                  }
                >
                  <p className="text-sm font-medium text-ink">
                    {unlinkedItems.length === 1
                      ? 'A Rent-categorized deposit isn’t linked to a rent charge'
                      : `${unlinkedItems.length} Rent-categorized deposits aren’t linked to rent charges`}
                  </p>
                  <ul className="divide-y divide-border">
                    {unlinkedItems.map((item) => (
                      <li
                        key={item.transactionId}
                        className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="text-sm">
                          <p className="text-ink">
                            <span className="font-medium tabular-nums">
                              {formatUsd(item.amountCents)}
                            </span>
                            <span className="text-ink-muted">
                              {' '}
                              · &ldquo;{item.description}&rdquo; · {formatDate(item.date)}
                            </span>
                          </p>
                          <p className="text-xs text-ink-muted">
                            Could apply to {item.tenantName}&rsquo;s {formatMonthLong(item.period)}{' '}
                            charge — {formatUsd(item.remainingCents)} still due for {item.unitLabel}{' '}
                            at {item.propertyLabel}
                          </p>
                        </div>
                        {canMoney && (
                          <Button
                            variant="secondary"
                            size="sm"
                            busy={
                              linkDeposit.isPending &&
                              linkDeposit.variables?.id === item.transactionId
                            }
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
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </AiSurface>
          </section>
        )}
      </LiveRegion>

      {tracker.isPending ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <KpiTileSkeleton />
            <KpiTileSkeleton />
            <KpiTileSkeleton />
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
            <KpiTile
              label="Collected"
              value={formatUsd(tracker.data.collectedCents)}
              ariaLabel={`Collected, ${formatUsd(tracker.data.collectedCents)} of ${formatUsd(billedCents)} billed${
                tracker.data.partialUnits > 0
                  ? `, including ${tracker.data.partialUnits} partial payment${tracker.data.partialUnits === 1 ? '' : 's'}`
                  : ''
              }`}
            >
              <p className="text-xs text-ink-muted">
                of {formatUsd(billedCents)} billed
                {tracker.data.partialUnits > 0 && ` · ${tracker.data.partialUnits} partial`}
              </p>
            </KpiTile>
            <KpiTile
              label="Outstanding"
              value={formatUsd(tracker.data.outstandingCents)}
              tone={tracker.data.outstandingCents > 0 ? 'danger' : undefined}
              ariaLabel={`Outstanding, ${formatUsd(tracker.data.outstandingCents)} of ${formatUsd(billedCents)} billed`}
            >
              <p className="text-xs text-ink-muted">of {formatUsd(billedCents)} billed</p>
            </KpiTile>
            <KpiTile
              label="Units paid"
              value={`${tracker.data.paidUnits} of ${tracker.data.totalUnits}`}
              ariaLabel={`Units paid, ${tracker.data.paidUnits} of ${tracker.data.totalUnits}, ${paidPct} percent collected`}
            >
              <ProgressBar
                value={tracker.data.paidUnits}
                max={tracker.data.totalUnits}
                label={`Rent collected for ${formatMonthLong(period)}`}
                text={`${paidPct}%`}
              />
            </KpiTile>
          </section>

          {rows.length === 0 ? (
            <Card flush>
              <EmptyState
                icon={<IconCalendarCheck size={28} />}
                title="No rent due this period"
                body="Rows appear here once active leases exist for the selected month."
              />
            </Card>
          ) : (
            <section
              aria-label={`Rent by tenant for ${formatMonthLong(period)}`}
              className="flex flex-col"
            >
              <p role="status" className="sr-only">
                Showing {visibleRows.length} of {rows.length} tenants
                {statusFilter !== 'all' && ` — ${FILTER_LABELS[statusFilter]}`}.
              </p>
              <Card flush>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                  <FilterChips
                    label="Filter by status"
                    options={chipOptions}
                    value={statusFilter}
                    onChange={setStatusFilter}
                  />
                  {canRent && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={lateRows.length === 0}
                      onClick={() => setBulkConfirmOpen(true)}
                    >
                      <IconBell size={14} />
                      Remind all late ({lateRows.length})
                    </Button>
                  )}
                </div>
                <Table
                  caption={`Rent tracker for ${formatMonthLong(period)} — tenant, amount, due date, status`}
                >
                  <thead>
                    <tr>
                      <Th>Tenant</Th>
                      <Th>Unit / property</Th>
                      <Th>Status</Th>
                      <Th align="right">Amount</Th>
                      <Th align="right">Remaining</Th>
                      <Th>Due</Th>
                      <Th>Paid</Th>
                      <Th stickyRight>
                        <span className="sr-only">Actions</span>
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.length === 0 ? (
                      <Tr>
                        <Td colSpan={8} className="py-8 text-center">
                          <span className="text-sm text-ink-muted">
                            No {FILTER_LABELS[statusFilter].toLowerCase()} rows for{' '}
                            {formatMonthLong(period)}.
                          </span>{' '}
                          <Button variant="ghost" size="sm" onClick={() => setStatusFilter('all')}>
                            Show all
                          </Button>
                        </Td>
                      </Tr>
                    ) : (
                      visibleRows.map((row) => {
                        const info = statusInfo(row);
                        const remainingCents = row.amountCents + row.lateFeeCents - row.paidCents;
                        const unpaid =
                          row.status === 'due' ||
                          row.status === 'late' ||
                          row.status === 'failed' ||
                          row.status === 'partial';
                        // Past its grace period (late outright, or a partial that's
                        // still late) — the condition Remind and Apply late fee share.
                        const pastGrace =
                          row.status === 'late' ||
                          (row.status === 'partial' && row.daysLate != null);
                        return (
                          <Tr key={row.rentPaymentId}>
                            <Td className="font-medium">
                              {row.tenantName}
                              {row.tenants.length > 1 && (
                                <div className="mt-0.5 flex flex-wrap items-center gap-2 font-normal">
                                  <button
                                    type="button"
                                    className="text-xs text-ink-muted underline decoration-dotted underline-offset-2 transition-colors duration-fast hover:text-ink"
                                    onClick={() => setDetailsRow(row)}
                                  >
                                    {row.tenants.length} tenants
                                    <span className="sr-only">
                                      {' '}
                                      — view shares for {row.tenantName}
                                    </span>
                                  </button>
                                  {row.sharesMismatch && (
                                    <StatusBadge tone="warning">
                                      Shares don&rsquo;t match
                                    </StatusBadge>
                                  )}
                                </div>
                              )}
                            </Td>
                            <Td>
                              {row.unitLabel}
                              <span className="text-ink-muted"> · {row.propertyLabel}</span>
                            </Td>
                            <Td>
                              <StatusBadge
                                tone={info.tone}
                                icon={info.clock ? 'clock' : undefined}
                              >
                                {info.label}
                              </StatusBadge>
                            </Td>
                            <Td align="right">
                              {formatUsd(row.amountCents)}
                              {row.lateFeeCents > 0 && (
                                <div className="text-xs font-normal text-ink-muted">
                                  +{formatUsd(row.lateFeeCents)} late fee
                                </div>
                              )}
                            </Td>
                            <Td align="right">
                              {remainingCents > 0 ? formatUsd(remainingCents) : '—'}
                              {row.paidCents > 0 && remainingCents > 0 && (
                                <div className="text-xs font-normal text-ink-muted">
                                  {formatUsd(row.paidCents)} paid
                                </div>
                              )}
                            </Td>
                            <Td className="whitespace-nowrap">{formatDate(row.dueDate)}</Td>
                            <Td className="whitespace-nowrap">
                              {row.paidAt ? (
                                <>
                                  {formatDate(row.paidAt)}
                                  {row.method && (
                                    <span className="text-xs text-ink-muted"> · {row.method}</span>
                                  )}
                                </>
                              ) : row.lastDepositAt ? (
                                <>
                                  {formatDate(row.lastDepositAt)}
                                  <span className="text-xs text-ink-muted"> (partial)</span>
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
                                    ...(unpaid
                                      ? [
                                          {
                                            label:
                                              row.status === 'partial'
                                                ? 'Record payment'
                                                : 'Mark paid',
                                            icon: <IconCheck size={14} />,
                                            onClick: () => {
                                              setPayMethod('manual');
                                              setPayAmount(
                                                (
                                                  (row.amountCents +
                                                    row.lateFeeCents -
                                                    row.paidCents) /
                                                  100
                                                ).toFixed(2),
                                              );
                                              setPayError(null);
                                              setPayTenantId('');
                                              setPayRow(row);
                                            },
                                          },
                                        ]
                                      : []),
                                    ...(pastGrace
                                      ? [
                                          {
                                            label: 'Remind',
                                            icon: <IconBell size={12} />,
                                            variant: 'secondary' as const,
                                            // Only the row whose reminder is in flight
                                            // shows busy (bulk send marks all its rows).
                                            busy:
                                              remind.isPending &&
                                              (remind.variables?.rentPaymentIds.includes(
                                                row.rentPaymentId,
                                              ) ??
                                                false),
                                            onClick: () => remindOne(row),
                                          },
                                        ]
                                      : []),
                                    // Late-fee amount isn't knowable client-side (the
                                    // row doesn't carry the lease's effective policy),
                                    // so the label stays amount-free until the confirm
                                    // succeeds and the toast reports the real figure.
                                    ...(pastGrace && row.lateFeeCents === 0
                                      ? [
                                          {
                                            label: 'Apply late fee',
                                            icon: <IconDollar size={12} />,
                                            variant: 'secondary' as const,
                                            busy: applyFee.isPending,
                                            onClick: () => setFeeRow(row),
                                          },
                                        ]
                                      : []),
                                    ...(row.deposits.length > 0 ||
                                    row.lateFeeCents > 0 ||
                                    row.tenants.length > 1
                                      ? [
                                          {
                                            label: 'Details',
                                            variant: 'secondary' as const,
                                            onClick: () => setDetailsRow(row),
                                          },
                                        ]
                                      : []),
                                  ]}
                                />
                              )}
                            </Td>
                          </Tr>
                        );
                      })
                    )}
                  </tbody>
                </Table>
              </Card>
            </section>
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
                ? `${formatUsd(payRow.amountCents + payRow.lateFeeCents - payRow.paidCents)} remaining of ${formatUsd(payRow.amountCents + payRow.lateFeeCents)}`
                : formatUsd(payRow.amountCents + payRow.lateFeeCents)}
              {payRow.lateFeeCents > 0 && ` (includes ${formatUsd(payRow.lateFeeCents)} late fee)`}{' '}
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

      <PaymentDetailsModal
        row={detailsRow}
        period={period}
        canRent={canRent}
        unlinkBusy={unlink.isPending}
        onUnlink={(depositId) => detailsRow && unlinkDeposit(detailsRow, depositId)}
        onWaive={() => {
          if (!detailsRow) return;
          setWaiveRow(detailsRow);
          setDetailsRow(null);
        }}
        onClose={() => setDetailsRow(null)}
      />

      <ConfirmDialog
        open={feeRow !== null}
        onClose={() => setFeeRow(null)}
        onConfirm={confirmApplyFee}
        title="Apply late fee?"
        confirmLabel="Apply late fee"
        confirmVariant="primary"
        busy={applyFee.isPending}
        body={
          <>
            Applies {feeRow?.tenantName}&rsquo;s lease late-fee policy (or your account default) to
            this charge. The fee is added to what&rsquo;s owed for this period — it only shows up in
            your income once collected.
          </>
        }
      />

      <ConfirmDialog
        open={waiveRow !== null}
        onClose={() => setWaiveRow(null)}
        onConfirm={confirmWaiveFee}
        title="Waive late fee?"
        confirmLabel="Waive fee"
        confirmVariant="secondary"
        busy={waiveFee.isPending}
        body={
          <>
            Removes the {waiveRow ? formatUsd(waiveRow.lateFeeCents) : ''} late fee from what&rsquo;s
            owed for this period. You can apply a new fee later if it&rsquo;s still warranted.
          </>
        }
      />
    </div>
  );
}
