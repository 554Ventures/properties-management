// Review queue — pending_review transactions with the AI category suggestion
// as an AiChip; the user confirms (accepting or overriding) before anything
// counts toward reports/taxes (PRD §5.4). Income items that look like a
// lease's open expected rent also carry a rent-match suggestion — accepting it
// links the deposit to the Rent Tracker instead of double-counting the month.
// The queue is searchable, filterable, and cursor-paged; bulk confirm/dismiss
// apply to the whole filtered set (rent matches stay per-item decisions).
//
// The row itself lives in components/review/ReviewItemCard — this page owns the
// filters, the bulk actions, paging, and the settled-row bookkeeping that keeps
// the list from moving under the pointer (see `settleRow`/`flushSettled`).
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type { BankDiscrepancyRow, ReviewQueueFilter, ReviewQueueItem } from '@hearth/shared';
import { ApiClientError } from '../api/client';
import {
  useAcceptBankDiscrepancy,
  useBankDiscrepancies,
  useCategories,
  useConfirmAllReview,
  useDismissAllReview,
  useDismissBankDiscrepancy,
  useProperties,
  useReviewQueue,
  useUnlinkDeposit,
} from '../api/queries';
import { ReviewItemCard } from '../components/review/ReviewItemCard';
import { ReviewSettledCard, type SettledOutcome } from '../components/review/ReviewSettledCard';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { Input } from '../components/ui/FormField';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';
import { IconAlertTriangle, IconCheck } from '../components/ui/icons';
import { formatDate, formatMonth, formatShortDate } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';
import { usePermissions } from '../lib/usePermissions';

const SEARCH_DEBOUNCE_MS = 300;

// A row the user just confirmed or dismissed: kept on screen, at its own index
// and its own height, until the pointer/focus leaves the queue.
interface SettledRow {
  item: ReviewQueueItem;
  outcome: SettledOutcome;
  label: string;
  index: number;
  minHeight: number;
}

export function MoneyReview() {
  usePageTitle('Review queue');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [type, setType] = useState<'' | ReviewQueueItem['type']>('');
  const [source, setSource] = useState<'' | ReviewQueueItem['source']>('');
  const [propertyId, setPropertyId] = useState('');
  const [bulkDialog, setBulkDialog] = useState<'confirm' | 'dismiss' | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setQ(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [search]);

  const filters: ReviewQueueFilter = useMemo(
    () => ({
      q: q || undefined,
      type: type || undefined,
      source: source || undefined,
      propertyId: propertyId || undefined,
    }),
    [q, type, source, propertyId],
  );
  const hasFilters = Boolean(q || type || source || propertyId);

  const review = useReviewQueue(filters);
  const categories = useCategories();
  const properties = useProperties();
  const confirmAll = useConfirmAllReview();
  const dismissAll = useDismissAllReview();
  const discrepancies = useBankDiscrepancies();
  const { toast } = useToast();
  const { can } = usePermissions();
  const canMoney = can('money');

  const categoriesByType = useMemo(() => {
    const all = categories.data ?? [];
    return {
      income: all.filter((c) => c.type === 'income'),
      expense: all.filter((c) => c.type === 'expense'),
    };
  }, [categories.data]);

  const items = useMemo(() => (review.data?.pages ?? []).flatMap((p) => p.items), [review.data]);
  const total = review.data?.pages[0]?.total ?? 0;

  const propertyLabelFor = (id: string | null): string | null => {
    const property = (properties.data ?? []).find((p) => p.id === id);
    return property ? (property.nickname ?? property.addressLine1) : null;
  };

  // ── holding scroll position across a confirm ──────────────────────────────
  // At ~72px a row, clearing the queue is a rhythm: if a confirmed row vanishes,
  // the next row's Confirm slides up under a cursor that hasn't moved, which is
  // where accidental double-confirms come from. So a successful write never
  // removes a row from the layout. `retired` keeps it out of the live list (the
  // server drops it on the next refetch anyway) while `settled` re-renders it in
  // place, at the height it had, as a "Confirmed"/"Dismissed" row. Both are
  // flushed only once the pointer or focus has left the queue — until then the
  // list's geometry cannot change.
  const [retired, setRetired] = useState<string[]>([]);
  const [settled, setSettled] = useState<SettledRow[]>([]);
  const queueRef = useRef<HTMLDivElement>(null);

  const liveItems = useMemo(() => items.filter((i) => !retired.includes(i.id)), [items, retired]);

  // Live rows, with each settled row spliced back at the index it occupied.
  const rows = useMemo(() => {
    const out: { item: ReviewQueueItem; settled?: SettledRow }[] = liveItems.map((item) => ({
      item,
    }));
    for (const row of [...settled].sort((a, b) => a.index - b.index)) {
      out.splice(Math.min(row.index, out.length), 0, { item: row.item, settled: row });
    }
    return out;
  }, [liveItems, settled]);

  const settleRow = (
    item: ReviewQueueItem,
    outcome: SettledOutcome,
    label: string,
    minHeight: number,
  ) => {
    const index = rows.findIndex((r) => r.item.id === item.id);
    setRetired((prev) => (prev.includes(item.id) ? prev : [...prev, item.id]));
    setSettled((prev) => [
      ...prev.filter((r) => r.item.id !== item.id),
      { item, outcome, label, minHeight, index: index === -1 ? rows.length : index },
    ]);
  };

  // Only the display is dropped — `retired` still hides the rows, so a not-yet-
  // refetched queue can't flash them back as pending.
  useEffect(() => {
    const el = queueRef.current;
    if (!el) return;
    const flush = () => setSettled((prev) => (prev.length === 0 ? prev : []));
    // Only a real move to an element outside the queue counts. A null
    // relatedTarget means focus fell to the body — which is what happens when
    // the Confirm button the user just pressed unmounts, and flushing there
    // would undo the very thing this mechanism exists for.
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next && !el.contains(next)) flush();
    };
    el.addEventListener('pointerleave', flush);
    el.addEventListener('focusout', onFocusOut);
    return () => {
      el.removeEventListener('pointerleave', flush);
      el.removeEventListener('focusout', onFocusOut);
    };
  }, [rows.length]);

  // A filter change is a different list — nothing to hold in place.
  useEffect(() => {
    setRetired([]);
    setSettled([]);
  }, [filters]);

  const runConfirmAll = () => {
    confirmAll.mutate(filters, {
      onSuccess: (res) => {
        setBulkDialog(null);
        setRetired([]);
        setSettled([]);
        toast(
          res.skipped > 0
            ? `Confirmed ${res.confirmed} transactions. ${res.skipped} left in the queue — they have a rent match or no suggestion, so review them one by one.`
            : `Confirmed ${res.confirmed} transactions.`,
          'positive',
        );
      },
      onError: (err) =>
        toast(
          err instanceof ApiClientError ? err.message : 'Could not confirm the queue. Try again.',
          'danger',
        ),
    });
  };

  const runDismissAll = () => {
    dismissAll.mutate(filters, {
      onSuccess: (res) => {
        setBulkDialog(null);
        setRetired([]);
        setSettled([]);
        toast(
          `Dismissed ${res.dismissed} transactions. They won't count toward reports.`,
          'positive',
        );
      },
      onError: (err) =>
        toast(
          err instanceof ApiClientError ? err.message : 'Could not dismiss the queue. Try again.',
          'danger',
        ),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Review queue"
        description="Imported and scanned transactions wait here until you confirm the category — nothing counts toward reports or taxes until then."
        breadcrumbs={[{ label: 'Money', to: '/money' }, { label: 'Review queue' }]}
        actions={
          canMoney ? (
            <>
              <Button
                variant="ghost"
                disabled={total === 0 || review.isPending}
                onClick={() => setBulkDialog('dismiss')}
              >
                Dismiss all
              </Button>
              <Button
                variant="secondary"
                disabled={total === 0 || review.isPending}
                onClick={() => setBulkDialog('confirm')}
              >
                <IconCheck size={14} />
                Confirm all suggested
              </Button>
            </>
          ) : undefined
        }
      />

      {!canMoney && (
        <p className="rounded-md border border-border bg-surface-sunken px-4 py-2.5 text-sm text-ink-muted">
          You can see everything in this queue, but confirming, dismissing, and editing need the
          Money permission — ask an account owner to turn it on for you.
        </p>
      )}

      {(discrepancies.data?.items.length ?? 0) > 0 && (
        <BankDiscrepancySection items={discrepancies.data!.items} canMoney={canMoney} />
      )}

      <Card className="p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="review-search" className="text-xs font-medium text-ink-muted">
              Search
            </label>
            <Input
              id="review-search"
              type="search"
              placeholder="Description or vendor"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="review-filter-type" className="text-xs font-medium text-ink-muted">
              Type
            </label>
            <Select
              id="review-filter-type"
              value={type}
              onChange={(e) => setType(e.target.value as '' | ReviewQueueItem['type'])}
            >
              <option value="">Income & expenses</option>
              <option value="income">Income</option>
              <option value="expense">Expenses</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="review-filter-source" className="text-xs font-medium text-ink-muted">
              Source
            </label>
            <Select
              id="review-filter-source"
              value={source}
              onChange={(e) => setSource(e.target.value as '' | ReviewQueueItem['source'])}
            >
              <option value="">All sources</option>
              <option value="bank">Bank import</option>
              <option value="receipt">Receipt scan</option>
              <option value="manual">Manual</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="review-filter-property" className="text-xs font-medium text-ink-muted">
              Property
            </label>
            <Select
              id="review-filter-property"
              value={propertyId}
              onChange={(e) => setPropertyId(e.target.value)}
            >
              <option value="">All properties</option>
              {(properties.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nickname ?? p.addressLine1}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Card>

      {review.isPending ? (
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i}>
              <Skeleton className="h-20 w-full" />
            </Card>
          ))}
        </div>
      ) : review.isError ? (
        <ErrorNotice error={review.error} onRetry={() => void review.refetch()} />
      ) : rows.length === 0 ? (
        <Card flush>
          {hasFilters ? (
            <EmptyState
              icon={<IconCheck size={28} />}
              title="No matches"
              body="No pending transactions match these filters. Try widening or clearing them."
            />
          ) : (
            <EmptyState
              icon={<IconCheck size={28} />}
              title="You're all caught up"
              body="New bank imports and scanned receipts will appear here for review."
            />
          )}
        </Card>
      ) : (
        // The whole queue — count line, rows and "Load more" — is one hover
        // region: settled rows are flushed on leaving it, never while the
        // pointer is still travelling between controls inside it.
        <div ref={queueRef} className="flex flex-col gap-3">
          <p className="text-sm text-ink-muted" role="status">
            Showing {liveItems.length} of {total} pending{' '}
            {total === 1 ? 'transaction' : 'transactions'}
            {hasFilters ? ' matching your filters' : ''}.
            {settled.length > 0 &&
              ` ${settled.length} just cleared — still listed so nothing shifts under your cursor.`}
          </p>
          <ul aria-label="Pending transactions" className="flex flex-col gap-3">
            {rows.map(({ item, settled: settledRow }) => (
              <li key={item.id}>
                {settledRow ? (
                  <ReviewSettledCard
                    item={item}
                    outcome={settledRow.outcome}
                    label={settledRow.label}
                    minHeight={settledRow.minHeight}
                    propertyLabel={propertyLabelFor(item.propertyId)}
                  />
                ) : (
                  <ReviewItemCard
                    item={item}
                    categoryOptions={categoriesByType[item.type]}
                    canMoney={canMoney}
                    onSettled={(outcome, label, minHeight) =>
                      settleRow(item, outcome, label, minHeight)
                    }
                  />
                )}
              </li>
            ))}
          </ul>
          {review.hasNextPage && (
            <div className="flex justify-center pt-1">
              <Button
                variant="secondary"
                busy={review.isFetchingNextPage}
                onClick={() => void review.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={bulkDialog === 'confirm'}
        onClose={() => setBulkDialog(null)}
        onConfirm={runConfirmAll}
        title="Confirm all suggested?"
        body={
          <>
            Every {hasFilters ? 'filtered ' : ''}pending transaction with an AI-suggested category (
            {total} in the queue{hasFilters ? ' match' : ''}) will be confirmed with that category
            and start counting toward reports. Items with a possible rent match or no suggestion
            stay in the queue for you to review one by one.
          </>
        }
        confirmLabel="Confirm all"
        confirmVariant="primary"
        busy={confirmAll.isPending}
      />
      <ConfirmDialog
        open={bulkDialog === 'dismiss'}
        onClose={() => setBulkDialog(null)}
        onConfirm={runDismissAll}
        title="Dismiss all?"
        body={
          <>
            All {total} {hasFilters ? 'matching ' : ''}pending transactions will be dismissed. They
            never count toward reports or taxes, but stay visible in the ledger under the
            “Dismissed” status filter.
          </>
        }
        confirmLabel="Dismiss all"
        busy={dismissAll.isPending}
      />
    </div>
  );
}

// ── bank corrections (WS5) ────────────────────────────────────────────────
// Rows the bank restated or voided after the landlord already confirmed or
// dismissed them. This is bank data, not an AI suggestion — plain warning-
// tone Card (matches ReportBody's "Worth your attention" pattern), never
// AiSurface.

const TYPE_LABEL: Record<'income' | 'expense', string> = { income: 'Income', expense: 'Expense' };

/** Only the fields that actually changed, each as a "before → after" string. */
function buildDiff(
  txn: NonNullable<BankDiscrepancyRow['transaction']>,
  bankData: NonNullable<BankDiscrepancyRow['bankData']>,
): string[] {
  const parts: string[] = [];
  if (txn.amountCents !== bankData.amountCents) {
    parts.push(`${formatUsd(txn.amountCents)} → ${formatUsd(bankData.amountCents)}`);
  }
  if (txn.date.slice(0, 10) !== bankData.date.slice(0, 10)) {
    parts.push(`${formatShortDate(txn.date)} → ${formatShortDate(bankData.date)}`);
  }
  if (txn.type !== bankData.type) {
    parts.push(`${TYPE_LABEL[txn.type]} → ${TYPE_LABEL[bankData.type]}`);
  }
  if ((txn.vendor ?? '') !== (bankData.vendor ?? '')) {
    parts.push(`${txn.vendor ?? 'No vendor'} → ${bankData.vendor ?? 'No vendor'}`);
  }
  if (txn.description !== bankData.description) {
    parts.push(`“${txn.description}” → “${bankData.description}”`);
  }
  return parts;
}

function BankDiscrepancySection({
  items,
  canMoney,
}: {
  items: BankDiscrepancyRow[];
  canMoney: boolean;
}) {
  return (
    <Card className="bg-warning-soft">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-warning">
          <IconAlertTriangle size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-ink">Bank changed these after you confirmed</h2>
          <p className="mt-1 text-sm text-ink">
            Your bank restated or removed these transactions after you already reviewed them. Accept
            the bank's version, or keep yours.
          </p>
          <ul className="mt-3 flex flex-col gap-3">
            {items.map((item) => (
              <li key={item.id}>
                <BankDiscrepancyItem item={item} canMoney={canMoney} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

function BankDiscrepancyItem({ item, canMoney }: { item: BankDiscrepancyRow; canMoney: boolean }) {
  const accept = useAcceptBankDiscrepancy();
  const dismiss = useDismissBankDiscrepancy();
  const unlink = useUnlinkDeposit();
  const { toast } = useToast();
  const txn = item.transaction;

  const acceptItem = () => {
    accept.mutate(item.id, {
      onSuccess: () => toast("Accepted the bank's version.", 'positive'),
      onError: (err) =>
        toast(
          err instanceof ApiClientError
            ? err.message
            : "Could not accept the bank's version. Try again.",
          'danger',
        ),
    });
  };

  const dismissItem = () => {
    dismiss.mutate(item.id, {
      onSuccess: () => toast('Kept your version — the bank change is dismissed.', 'positive'),
      onError: (err) =>
        toast(
          err instanceof ApiClientError
            ? err.message
            : 'Could not dismiss the bank change. Try again.',
          'danger',
        ),
    });
  };

  const unlinkItem = () => {
    if (!item.rentPaymentId || !item.depositId) return;
    unlink.mutate(
      { rentPaymentId: item.rentPaymentId, depositId: item.depositId },
      {
        onSuccess: () =>
          toast("Deposit unlinked — you can now accept the bank's version.", 'positive'),
        onError: () => toast('Could not unlink the deposit. Try again.', 'danger'),
      },
    );
  };

  const diffParts =
    item.kind === 'modified' && txn && item.bankData ? buildDiff(txn, item.bankData) : [];
  const statusText = !txn
    ? 'This transaction is no longer in your ledger.'
    : item.kind === 'removed'
      ? 'Removed by your bank'
      : diffParts.length > 0
        ? diffParts.join(' · ')
        : 'Your bank re-sent this transaction with the same details.';

  return (
    <div className="rounded-md border border-border-strong bg-surface p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          {txn && (
            <>
              <p className="font-medium text-ink">{txn.description}</p>
              <p className="mt-0.5 text-sm text-ink-muted">
                {txn.vendor ? `${txn.vendor} · ` : ''}
                {formatDate(txn.date)} ·{' '}
                <span className="font-medium tabular-nums text-ink">
                  {txn.type === 'income' ? '+' : '−'}
                  {formatUsd(txn.amountCents)}
                </span>
                {txn.categoryName ? ` · ${txn.categoryName}` : ''}
              </p>
            </>
          )}
          <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-warning">
            <IconAlertTriangle size={14} />
            {statusText}
          </p>
          {item.rentPaymentId && (
            <p className="mt-2 text-sm text-ink-muted">
              This transaction backs{' '}
              <span className="font-medium text-ink">
                {item.rentPeriod ? formatMonth(item.rentPeriod) : 'a'}
              </span>{' '}
              rent.
            </p>
          )}
        </div>
        {canMoney && (
          <div className="flex w-full flex-col gap-2 md:w-56">
            {item.rentPaymentId && item.depositId && (
              <Button variant="secondary" busy={unlink.isPending} onClick={unlinkItem}>
                Unlink deposit
              </Button>
            )}
            <Button
              busy={accept.isPending}
              disabled={!txn}
              title={
                !txn ? 'This transaction is no longer in your ledger — dismiss instead.' : undefined
              }
              onClick={acceptItem}
            >
              Accept bank version
            </Button>
            <Button variant="ghost" busy={dismiss.isPending} onClick={dismissItem}>
              Keep my version
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
