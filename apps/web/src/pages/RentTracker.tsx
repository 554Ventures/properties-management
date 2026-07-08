// Rent Collection (PRD §5.5): period selector, collected/outstanding/progress
// tiles, per-tenant rows with status text + days late, individual Remind and
// a confirmed "Remind all late" bulk action, and manual payment recording.
// Deliberately no AI banner here — this ledger reads as deterministic.
import { useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type { RentPaymentMethod, RentTrackerRow } from '@hearth/shared';
import { useRecordPayment, useRentTracker, useSendReminders } from '../api/queries';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { Modal } from '../components/ui/Modal';
import { ProgressBar } from '../components/ui/ProgressBar';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge, type BadgeTone } from '../components/ui/StatusBadge';
import { Table, Td, Th, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { IconBell, IconCalendarCheck } from '../components/ui/icons';
import { currentPeriod, formatDate, formatMonthLong } from '../lib/format';
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
  const [period, setPeriod] = useState(currentPeriod());
  const tracker = useRentTracker(period);
  const remind = useSendReminders();
  const record = useRecordPayment();
  const { toast } = useToast();

  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [payRow, setPayRow] = useState<RentTrackerRow | null>(null);
  const [payMethod, setPayMethod] = useState<RentPaymentMethod>('manual');

  const rows = tracker.data?.rows ?? [];
  const lateRows = rows.filter((row) => row.status === 'late');

  const summarizeReminders = (results: { status: 'sent' | 'skipped' }[]) => {
    const sent = results.filter((r) => r.status === 'sent').length;
    const skipped = results.length - sent;
    toast(
      `${sent} reminder${sent === 1 ? '' : 's'} sent${skipped > 0 ? `, ${skipped} skipped` : ''}.`,
      sent > 0 ? 'positive' : 'neutral',
    );
  };

  const remindOne = (row: RentTrackerRow) => {
    remind.mutate(
      { rentPaymentIds: [row.rentPaymentId] },
      {
        onSuccess: (res) => summarizeReminders(res.results),
        onError: () => toast('Could not send the reminder. Try again.', 'danger'),
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
        },
        onError: () => {
          setBulkConfirmOpen(false);
          toast('Could not send reminders. Try again.', 'danger');
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
            <input
              id="rent-period"
              type="month"
              value={period}
              onChange={(e) => e.target.value && setPeriod(e.target.value)}
              className="rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink"
            />
          </div>
        }
      />

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
                          <div className="flex justify-end gap-2">
                            {row.status === 'late' && (
                              <Button
                                variant="secondary"
                                size="sm"
                                busy={remind.isPending}
                                onClick={() => remindOne(row)}
                              >
                                <IconBell size={12} />
                                Remind
                              </Button>
                            )}
                            {unpaid && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setPayMethod('manual');
                                  setPayRow(row);
                                }}
                              >
                                Mark paid
                              </Button>
                            )}
                          </div>
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
          A payment reminder email will be sent to{' '}
          {lateRows.map((row) => row.tenantName).join(', ')}. Tenants reminded very recently may be
          skipped.
        </p>
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
