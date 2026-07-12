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
import { useInsights, useRecordPayment, useRentTracker, useSendReminders } from '../api/queries';
import { InsightCard } from '../components/ai/InsightCard';
import { PageHeader } from '../components/shell/PageHeader';
import { Button, buttonClasses } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { LiveRegion } from '../components/ui/LiveRegion';
import { Modal } from '../components/ui/Modal';
import { ProgressBar } from '../components/ui/ProgressBar';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge, type BadgeTone } from '../components/ui/StatusBadge';
import { RowActions } from '../components/ui/RowActions';
import { Table, Td, Th, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { IconBell, IconCalendarCheck, IconCheck } from '../components/ui/icons';
import { currentPeriod, formatDate, formatMonthLong, recentPeriods } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';

function statusInfo(row: RentTrackerRow): { tone: BadgeTone; label: string; clock?: boolean } {
  switch (row.status) {
    case 'paid':
      return { tone: 'positive', label: 'Paid' };
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
  const remind = useSendReminders();
  const record = useRecordPayment();
  const { toast } = useToast();

  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [payRow, setPayRow] = useState<RentTrackerRow | null>(null);
  const [payMethod, setPayMethod] = useState<RentPaymentMethod>('manual');
  const [composedReminders, setComposedReminders] = useState<
    { tenantName: string; mailto: string; subject?: string }[]
  >([]);

  // Exactly one contextual AI card (newest late_rent) — this page is where
  // that insight points, so it surfaces here instead of a separate AI page.
  const insights = useInsights({ status: 'active' });
  const lateRentInsight = insights.data?.find((i) => i.type === 'late_rent');

  const rows = tracker.data?.rows ?? [];
  const lateRows = rows.filter((row) => row.status === 'late');

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
    record.mutate(
      {
        leaseId: payRow.leaseId,
        period,
        amountCents: payRow.amountCents,
        method: payMethod,
      },
      {
        onSuccess: () => {
          toast(`Payment recorded for ${payRow.tenantName}.`, 'positive');
          setPayRow(null);
        },
        onError: () => toast('Could not record the payment. Try again.', 'danger'),
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

          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-ink">
              {formatMonthLong(period)} — per tenant
            </h2>
            <Button
              variant="secondary"
              disabled={lateRows.length === 0}
              onClick={() => setBulkConfirmOpen(true)}
            >
              <IconBell size={14} />
              Remind all late ({lateRows.length})
            </Button>
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
                      row.status === 'due' || row.status === 'late' || row.status === 'failed';
                    return (
                      <Tr key={row.rentPaymentId}>
                        <Td className="font-medium">{row.tenantName}</Td>
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
                          <RowActions
                            context={row.tenantName}
                            actions={[
                              ...(row.status === 'late'
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
                                      label: 'Mark paid',
                                      icon: <IconCheck size={14} />,
                                      onClick: () => {
                                        setPayMethod('manual');
                                        setPayRow(row);
                                      },
                                    },
                                  ]
                                : []),
                            ]}
                          />
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

      <Modal
        open={composedReminders.length > 0}
        onClose={() => setComposedReminders([])}
        title="Reminders composed"
        size="sm"
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink-muted">
            Open each one to review and send it from your own mail app.
          </p>
          <ul className="flex flex-col gap-2">
            {composedReminders.map((r) => (
              <li key={r.tenantName} className="flex items-center justify-between gap-2">
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-ink">{r.tenantName}</span>
                  {r.subject && (
                    <span className="text-xs text-ink-muted">{r.subject}</span>
                  )}
                </span>
                <a href={r.mailto} className={buttonClasses('secondary', 'sm')}>
                  <IconBell size={12} />
                  Open email
                </a>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={() => setComposedReminders([])}>
              Done
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={payRow !== null}
        onClose={() => setPayRow(null)}
        title={payRow ? `Record payment — ${payRow.tenantName}` : 'Record payment'}
        size="sm"
      >
        {payRow && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-ink-muted">
              {formatUsd(payRow.amountCents)} for {formatMonthLong(period)} · {payRow.unitLabel} ·{' '}
              {payRow.propertyLabel}
            </p>
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
    </div>
  );
}
