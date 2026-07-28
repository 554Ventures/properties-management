// Review queue — pending_review transactions with the AI category suggestion
// as an AiChip; the user confirms (accepting or overriding) before anything
// counts toward reports/taxes (PRD §5.4). Income items that look like a
// lease's open expected rent also carry a rent-match suggestion — accepting it
// links the deposit to the Rent Tracker instead of double-counting the month.
// The queue is searchable, filterable, and cursor-paged; bulk confirm/dismiss
// apply to the whole filtered set (rent matches stay per-item decisions).
import { useEffect, useMemo, useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type {
  BankDiscrepancyRow,
  Category,
  RentChargeOption,
  ReviewQueueFilter,
  ReviewQueueItem,
  TransactionClassification,
} from '@hearth/shared';
import { ApiClientError } from '../api/client';
import {
  useAcceptBankDiscrepancy,
  useBankDiscrepancies,
  useCategories,
  useConfirmAllReview,
  useConfirmTransaction,
  useDismissAllReview,
  useDismissBankDiscrepancy,
  useDismissTransaction,
  useOpenRentCharges,
  useProperties,
  usePropertyDetail,
  useReviewQueue,
  useUnlinkDeposit,
} from '../api/queries';
import { AiChip } from '../components/ai/AiChip';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { Input } from '../components/ui/FormField';
import { Modal } from '../components/ui/Modal';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge } from '../components/ui/StatusBadge';
import { useToast } from '../components/ui/Toast';
import { IconAlertTriangle, IconCheck } from '../components/ui/icons';
import { cx } from '../lib/cx';
import { formatDate, formatMonth, formatShortDate } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';

const SEARCH_DEBOUNCE_MS = 300;

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

  const categoriesByType = useMemo(() => {
    const all = categories.data ?? [];
    return {
      income: all.filter((c) => c.type === 'income'),
      expense: all.filter((c) => c.type === 'expense'),
    };
  }, [categories.data]);

  const items = useMemo(
    () => (review.data?.pages ?? []).flatMap((p) => p.items),
    [review.data],
  );
  const total = review.data?.pages[0]?.total ?? 0;

  const runConfirmAll = () => {
    confirmAll.mutate(filters, {
      onSuccess: (res) => {
        setBulkDialog(null);
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
        toast(`Dismissed ${res.dismissed} transactions. They won't count toward reports.`, 'positive');
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
        }
      />

      {(discrepancies.data?.items.length ?? 0) > 0 && (
        <BankDiscrepancySection items={discrepancies.data!.items} />
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
      ) : items.length === 0 ? (
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
        <>
          <p className="text-sm text-ink-muted" role="status">
            Showing {items.length} of {total} pending {total === 1 ? 'transaction' : 'transactions'}
            {hasFilters ? ' matching your filters' : ''}.
          </p>
          <ul className="flex flex-col gap-4">
            {items.map((item) => (
              <li key={item.id}>
                <ReviewItemCard item={item} categoryOptions={categoriesByType[item.type]} />
              </li>
            ))}
          </ul>
          {review.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                busy={review.isFetchingNextPage}
                onClick={() => void review.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </>
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

// One card per queue item. A component (not an inline map body) so each card
// can hold its own selection state and fetch its chosen property's units.
function ReviewItemCard({
  item,
  categoryOptions,
}: {
  item: ReviewQueueItem;
  categoryOptions: Category[];
}) {
  const confirm = useConfirmTransaction();
  const dismiss = useDismissTransaction();
  const properties = useProperties();
  const { toast } = useToast();
  const [categoryId, setCategoryId] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [unitId, setUnitId] = useState('');
  // '' = ordinary income/expense; transfer/owner money leaves P&L, refunds net.
  const [classification, setClassification] = useState<TransactionClassification | ''>('');
  // The one armed rent link, however it got picked — the AI-suggested chip or
  // the manual picker — both explicit user actions (never auto-applied), and
  // mutually exclusive since this is a single piece of state.
  const [linkedRent, setLinkedRent] = useState<{
    rentPaymentId: string;
    tenantName: string;
    period: string;
    propertyLabel: string;
    unitLabel: string;
    // Audit provenance: an accepted AI chip audits ai_suggested_user_confirmed,
    // a hand-picked charge audits plain 'user'.
    source: 'suggestion' | 'manual';
  } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const propertyDetail = usePropertyDetail(propertyId || undefined);
  const units = propertyDetail.data?.units ?? [];
  const rentMatch = item.rentMatch;

  const confirmItem = () => {
    const payload = linkedRent
      ? { id: item.id, rentPaymentId: linkedRent.rentPaymentId, linkSource: linkedRent.source }
      : {
          id: item.id,
          categoryId: categoryId || undefined,
          propertyId: propertyId || undefined,
          unitId: unitId || undefined,
          classification: classification || undefined,
        };
    // A rent-linked confirm always attributes to the lease's property; only
    // the plain-confirm path can leave the row unassigned.
    const staysUnassigned = !linkedRent && !propertyId;
    confirm.mutate(payload, {
      onSuccess: () => {
        toast(
          linkedRent
            ? `Confirmed and marked ${linkedRent.tenantName}'s ${formatMonth(linkedRent.period)} rent paid.`
            : `Confirmed “${item.description}”.`,
          'positive',
        );
        // Portfolio-level bank rows are common (e.g. a shared insurance
        // policy) and legitimate, but a nudge here is cheap insurance against
        // an unintentional skip — manual/receipt entries already went through
        // a form where "no property" was a deliberate choice.
        if (staysUnassigned && item.source === 'bank') {
          toast(
            "Confirmed without a property — assign one from the ledger's Edit action to keep per-property reports complete.",
            'neutral',
          );
        }
      },
      onError: (err) =>
        toast(
          err instanceof ApiClientError ? err.message : 'Could not confirm the transaction. Try again.',
          'danger',
        ),
    });
  };

  const dismissItem = () => {
    dismiss.mutate(item.id, {
      onSuccess: () => toast(`Dismissed “${item.description}” — it won't count toward reports.`, 'positive'),
      onError: (err) =>
        toast(
          err instanceof ApiClientError ? err.message : 'Could not dismiss the transaction. Try again.',
          'danger',
        ),
    });
  };

  return (
    <>
      <Card>
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <p className="font-medium text-ink">{item.description}</p>
            <p className="mt-0.5 text-sm text-ink-muted">
              {item.vendor ? `${item.vendor} · ` : ''}
              {formatDate(item.date)} ·{' '}
              <span className="font-medium tabular-nums text-ink">
                {item.type === 'income' ? '+' : '−'}
                {formatUsd(item.amountCents)}
              </span>
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {rentMatch && (
                <AiChip
                  name={`${rentMatch.tenantName}'s ${formatMonth(rentMatch.period)} rent — ${rentMatch.propertyLabel} · ${rentMatch.unitLabel}`}
                  confidence={rentMatch.confidence}
                  applied={linkedRent?.rentPaymentId === rentMatch.rentPaymentId}
                  onApply={() =>
                    setLinkedRent({
                      rentPaymentId: rentMatch.rentPaymentId,
                      tenantName: rentMatch.tenantName,
                      period: rentMatch.period,
                      propertyLabel: rentMatch.propertyLabel,
                      unitLabel: rentMatch.unitLabel,
                      source: 'suggestion',
                    })
                  }
                  note={rentMatch.matchedName ? `deposit names ${rentMatch.matchedName}` : undefined}
                />
              )}
              {item.aiSuggestedCategoryId && item.aiSuggestedCategoryName && !linkedRent && (
                <AiChip
                  name={item.aiSuggestedCategoryName}
                  confidence={item.aiConfidence ?? 0}
                  applied={categoryId === item.aiSuggestedCategoryId}
                  onApply={() => setCategoryId(item.aiSuggestedCategoryId as string)}
                  note={item.suggestionSource === 'learned' ? 'from your past choice' : undefined}
                />
              )}
              {item.aiConfidence != null && item.aiConfidence < 0.7 && (
                <StatusBadge tone="warning">Low confidence — check this one</StatusBadge>
              )}
              {/* Manual path (not AI content — a plain button, not an AiChip):
                  lets the user pick from every open charge, for the cases the
                  heuristic missed entirely. Stays reachable even after a
                  suggestion is accepted so a manual pick can replace it
                  (mutually exclusive — one rentPaymentId). */}
              {item.type === 'income' && (
                <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
                  Link to rent…
                </Button>
              )}
            </div>
            {item.possibleDuplicate && (
              <p className="mt-2 text-sm text-warning">
                <span className="font-medium">Possible duplicate:</span>{' '}
                {item.possibleDuplicate.rentPeriod ? (
                  <>
                    this looks like the deposit behind the rent you recorded manually for{' '}
                    {formatMonth(item.possibleDuplicate.rentPeriod)} (&ldquo;
                    {item.possibleDuplicate.description}&rdquo;, {formatDate(item.possibleDuplicate.date)}
                    ). If it&rsquo;s the same money, Dismiss this one — or unlink the manual payment
                    on the Rent page first.
                  </>
                ) : (
                  <>
                    a confirmed {item.possibleDuplicate.source} transaction matches this amount and
                    date (&ldquo;{item.possibleDuplicate.description}&rdquo;,{' '}
                    {formatDate(item.possibleDuplicate.date)}). If it&rsquo;s the same money, Dismiss
                    this one.
                  </>
                )}
              </p>
            )}
          </div>
          <div className="flex w-full flex-col gap-2 md:w-64">
            {linkedRent ? (
              <>
                <p className="text-sm text-ink-muted">
                  Confirming marks{' '}
                  <span className="font-medium text-ink">{linkedRent.tenantName}</span>
                  ’s {formatMonth(linkedRent.period)} rent paid and files this under{' '}
                  <span className="font-medium text-ink">
                    {linkedRent.propertyLabel} · {linkedRent.unitLabel}
                  </span>{' '}
                  as Rent.
                </p>
                <Button variant="ghost" onClick={() => setLinkedRent(null)}>
                  Don't link to rent
                </Button>
              </>
            ) : (
              <>
                <label
                  htmlFor={`review-category-${item.id}`}
                  className="text-xs font-medium text-ink-muted"
                >
                  Category
                </label>
                <Select
                  id={`review-category-${item.id}`}
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                >
                  <option value="">
                    {item.aiSuggestedCategoryName
                      ? `Accept suggestion (${item.aiSuggestedCategoryName})`
                      : 'Choose a category'}
                  </option>
                  {categoryOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
                <label
                  htmlFor={`review-property-${item.id}`}
                  className="text-xs font-medium text-ink-muted"
                >
                  Property
                </label>
                <Select
                  id={`review-property-${item.id}`}
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
                <label
                  htmlFor={`review-unit-${item.id}`}
                  className="text-xs font-medium text-ink-muted"
                >
                  Unit
                </label>
                <Select
                  id={`review-unit-${item.id}`}
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
                <label
                  htmlFor={`review-classification-${item.id}`}
                  className="text-xs font-medium text-ink-muted"
                >
                  Treatment
                </label>
                <Select
                  id={`review-classification-${item.id}`}
                  value={classification}
                  onChange={(e) =>
                    setClassification(e.target.value as TransactionClassification | '')
                  }
                >
                  <option value="">
                    Ordinary {item.type === 'income' ? 'income' : 'expense'}
                  </option>
                  <option value="transfer">Transfer between my accounts (not counted)</option>
                  <option value="owner_contribution">Owner contribution (not counted)</option>
                  {item.type === 'income' && (
                    <option value="refund">Refund — nets against its expense category</option>
                  )}
                </Select>
              </>
            )}
            <Button busy={confirm.isPending} onClick={confirmItem}>
              <IconCheck size={14} />
              Confirm
            </Button>
            <Button variant="ghost" busy={dismiss.isPending} onClick={dismissItem}>
              Dismiss
              <span className="sr-only"> “{item.description}”</span>
            </Button>
          </div>
        </div>
      </Card>
      {item.type === 'income' && (
        <RentChargePickerModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          amountCents={item.amountCents}
          onChoose={(option) => {
            setLinkedRent({
              rentPaymentId: option.rentPaymentId,
              tenantName: option.tenantName,
              period: option.period,
              propertyLabel: option.propertyLabel,
              unitLabel: option.unitLabel,
              source: 'manual',
            });
            setPickerOpen(false);
          }}
        />
      )}
    </>
  );
}

// The manual charge picker (rent-match v2): every open charge, radio-group
// select, for deposits the heuristic missed or attributed below the remaining
// balance. A plain user-initiated modal, not AI content.
function RentChargePickerModal({
  open,
  onClose,
  amountCents,
  onChoose,
}: {
  open: boolean;
  onClose: () => void;
  amountCents: number;
  onChoose: (option: RentChargeOption) => void;
}) {
  const openCharges = useOpenRentCharges(open);
  const [selectedId, setSelectedId] = useState('');
  const items = openCharges.data?.items ?? [];

  // A stale pick from a previous open shouldn't carry over.
  useEffect(() => {
    if (open) setSelectedId('');
  }, [open]);

  const confirmPick = () => {
    const option = items.find((i) => i.rentPaymentId === selectedId);
    if (option) onChoose(option);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Link to a rent charge"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!selectedId} onClick={confirmPick}>
            Link
          </Button>
        </>
      }
    >
      {openCharges.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : openCharges.isError ? (
        <ErrorNotice error={openCharges.error} onRetry={() => void openCharges.refetch()} />
      ) : items.length === 0 ? (
        <p className="text-sm text-ink-muted">No open rent charges to link to.</p>
      ) : (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-2 text-sm font-medium text-ink">Choose a charge</legend>
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {items.map((option) => {
              const disabled = option.remainingCents < amountCents;
              // The note lives outside the <label> (not as a sibling text
              // node inside it) so the radio's accessible name stays just the
              // option itself; aria-describedby still surfaces the note to
              // assistive tech, and it's rendered as visible text either way
              // (never color alone).
              const noteId = `rent-charge-note-${option.rentPaymentId}`;
              return (
                <div
                  key={option.rentPaymentId}
                  className={cx(
                    'flex flex-col gap-0.5 rounded-md border border-border px-3 py-2 text-sm',
                    disabled ? 'opacity-60' : 'hover:bg-surface-sunken',
                  )}
                >
                  <label className={cx('flex items-start gap-2', disabled ? '' : 'cursor-pointer')}>
                    <input
                      type="radio"
                      name="rent-charge-option"
                      value={option.rentPaymentId}
                      checked={selectedId === option.rentPaymentId}
                      disabled={disabled}
                      aria-describedby={disabled ? noteId : undefined}
                      onChange={() => setSelectedId(option.rentPaymentId)}
                      className="mt-0.5 h-4 w-4 border-border-strong text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
                    />
                    <span className="text-ink">
                      {option.tenantName} — {formatMonth(option.period)} — {option.propertyLabel} ·{' '}
                      {option.unitLabel} — {formatUsd(option.remainingCents)} remaining
                    </span>
                  </label>
                  {disabled && (
                    <p id={noteId} className="ml-6 text-xs text-warning">
                      deposit exceeds remaining
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      )}
    </Modal>
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

function BankDiscrepancySection({ items }: { items: BankDiscrepancyRow[] }) {
  return (
    <Card className="bg-warning-soft">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-warning">
          <IconAlertTriangle size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-ink">Bank changed these after you confirmed</h2>
          <p className="mt-1 text-sm text-ink">
            Your bank restated or removed these transactions after you already reviewed them.
            Accept the bank's version, or keep yours.
          </p>
          <ul className="mt-3 flex flex-col gap-3">
            {items.map((item) => (
              <li key={item.id}>
                <BankDiscrepancyItem item={item} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

function BankDiscrepancyItem({ item }: { item: BankDiscrepancyRow }) {
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
          err instanceof ApiClientError ? err.message : 'Could not dismiss the bank change. Try again.',
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
        : "Your bank re-sent this transaction with the same details.";

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
        <div className="flex w-full flex-col gap-2 md:w-56">
          {item.rentPaymentId && item.depositId && (
            <Button variant="secondary" busy={unlink.isPending} onClick={unlinkItem}>
              Unlink deposit
            </Button>
          )}
          <Button
            busy={accept.isPending}
            disabled={!txn}
            title={!txn ? 'This transaction is no longer in your ledger — dismiss instead.' : undefined}
            onClick={acceptItem}
          >
            Accept bank version
          </Button>
          <Button variant="ghost" busy={dismiss.isPending} onClick={dismissItem}>
            Keep my version
          </Button>
        </div>
      </div>
    </div>
  );
}
