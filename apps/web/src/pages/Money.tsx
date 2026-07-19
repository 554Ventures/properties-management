// Money — transactions ledger with per-header sort/filter, a description/vendor
// search, and numbered server-side pagination (PRD §5.4). All searching,
// filtering, sorting, and paging run on the server via the DataTable `manual`
// mode; the review-queue link shows the pending count.
import { useEffect, useMemo, useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type {
  Transaction,
  TransactionListQuery,
  TransactionSortField,
  TransactionStatus,
  TransactionType,
} from '@hearth/shared';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiClientError } from '../api/client';
import {
  useCategories,
  useDeleteTransaction,
  useImportTransactions,
  useInsights,
  useIntegrations,
  useProperties,
  useRestoreTransaction,
  useReviewQueue,
  useTransactions,
} from '../api/queries';
import { InsightCard } from '../components/ai/InsightCard';
import { TransactionEditModal } from '../components/forms/TransactionEditModal';
import { PageHeader } from '../components/shell/PageHeader';
import { Button, buttonClasses } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import {
  DataTable,
  emptyDataTableState,
  type DataTableColumn,
  type DataTableState,
  type FilterValue,
} from '../components/ui/DataTable';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { LiveRegion } from '../components/ui/LiveRegion';
import { RowActions, type RowAction } from '../components/ui/RowActions';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge } from '../components/ui/StatusBadge';
import { useToast } from '../components/ui/Toast';
import {
  IconDollar,
  IconDownload,
  IconPaperclip,
  IconPencil,
  IconPlus,
  IconTrash,
  IconX,
} from '../components/ui/icons';
import { cx } from '../lib/cx';
import { formatDate, formatDateTime } from '../lib/format';
import { importToastMessage } from '../lib/importToastMessage';
import { usePageTitle } from '../lib/usePageTitle';

const PAGE_SIZE = 20;

// Column id → server sort field. Only these columns show a sort control.
const SORT_FIELD: Record<string, TransactionSortField> = {
  date: 'date',
  description: 'description',
  amount: 'amountCents',
  status: 'status',
};

const TYPE_OPTIONS = [
  { value: 'income', label: 'Income' },
  { value: 'expense', label: 'Expenses' },
];
const STATUS_OPTIONS = [
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'pending_review', label: 'Needs review' },
  { value: 'dismissed', label: 'Dismissed' },
];

// The single selected value of a select filter (server params are single-value).
function selected(filters: Record<string, FilterValue>, id: string): string | undefined {
  const f = filters[id];
  return f?.kind === 'select' && f.values.length > 0 ? f.values[0] : undefined;
}

/** ?type=&categoryId=&propertyId= deep links (insight cards, push
 *  notifications) pre-apply the matching column filters. Pure and exported
 *  for tests; unknown or empty params fall back to the empty state. A stale
 *  id (e.g. a deleted category) just yields an empty filtered table. */
export function moneyStateFromParams(params: URLSearchParams): DataTableState {
  const filters: Record<string, FilterValue> = {};
  const type = params.get('type');
  if (type === 'income' || type === 'expense') filters.amount = { kind: 'select', values: [type] };
  const categoryId = params.get('categoryId');
  if (categoryId) filters.category = { kind: 'select', values: [categoryId] };
  const propertyId = params.get('propertyId');
  if (propertyId) filters.property = { kind: 'select', values: [propertyId] };
  return { ...emptyDataTableState, filters };
}

/** ?unassigned=true deep link (the `unassigned_transactions` insight card) —
 *  kept separate from `moneyStateFromParams`'s DataTableState, not folded
 *  into `filters`: it isn't a per-column table filter, and DataTable's own
 *  `onStateChange` round-trips a plain DataTableState on every sort/search/
 *  page interaction, which would silently drop an extra field riding along
 *  inside it. Pure and exported for tests. */
export function unassignedFromParams(params: URLSearchParams): boolean {
  return params.get('unassigned') === 'true';
}

function hasCriteria(state: DataTableState, unassignedOnly: boolean): boolean {
  if (unassignedOnly) return true;
  if (state.search.trim() !== '') return true;
  return Object.values(state.filters).some((f) =>
    f.kind === 'text'
      ? f.text.trim() !== ''
      : f.kind === 'select'
        ? f.values.length > 0
        : f.min.trim() !== '' || f.max.trim() !== '',
  );
}

export function Money() {
  usePageTitle('Money');
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<DataTableState>(() => moneyStateFromParams(searchParams));
  const [unassignedOnly, setUnassignedOnly] = useState(() => unassignedFromParams(searchParams));
  // The expense-spike insight card renders on this page and deep-links back to
  // it — a same-route navigation never remounts, so re-apply on param change.
  const paramsKey = searchParams.toString();
  useEffect(() => {
    const next = moneyStateFromParams(searchParams);
    if (Object.keys(next.filters).length > 0) setState(next);
    if (unassignedFromParams(searchParams)) setUnassignedOnly(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [deleting, setDeleting] = useState<Transaction | null>(null);

  const clearUnassigned = () => {
    setUnassignedOnly(false);
    setState((s) => ({ ...s, page: 0 }));
  };

  const query: TransactionListQuery & { unassigned?: boolean } = useMemo(() => {
    const sortField = state.sort ? SORT_FIELD[state.sort.columnId] : undefined;
    return {
      q: state.search.trim() || undefined,
      // Unassigned implies "no property" — it wins over any property column
      // filter rather than combining into a contradictory query.
      propertyId: unassignedOnly ? undefined : selected(state.filters, 'property'),
      categoryId: selected(state.filters, 'category'),
      type: selected(state.filters, 'amount') as TransactionType | undefined,
      status: selected(state.filters, 'status') as TransactionStatus | undefined,
      unassigned: unassignedOnly ? true : undefined,
      sort: sortField,
      dir: sortField ? state.sort?.dir : undefined,
      limit: PAGE_SIZE,
      offset: state.page * PAGE_SIZE,
    };
  }, [state, unassignedOnly]);

  const transactions = useTransactions(query);
  const review = useReviewQueue();
  const categories = useCategories();
  const properties = useProperties();
  const integrations = useIntegrations();
  const importBank = useImportTransactions();
  const deleteTransaction = useDeleteTransaction();
  const restoreTransaction = useRestoreTransaction();
  const { toast } = useToast();
  const navigate = useNavigate();

  const categoryName = useMemo(
    () => new Map((categories.data ?? []).map((c) => [c.id, c.name])),
    [categories.data],
  );
  const propertyName = useMemo(
    () => new Map((properties.data ?? []).map((p) => [p.id, p.nickname ?? p.addressLine1])),
    [properties.data],
  );
  const propertyOptions = useMemo(
    () => (properties.data ?? []).map((p) => ({ value: p.id, label: p.nickname ?? p.addressLine1 })),
    [properties.data],
  );
  const categoryOptions = useMemo(
    () => (categories.data ?? []).map((c) => ({ value: c.id, label: c.name })),
    [categories.data],
  );

  const pendingCount = review.data?.pages[0]?.total ?? 0;

  // Exactly one contextual AI card (newest expense_spike) — the spending
  // anomaly belongs on the ledger page it's about, clearly marked (AiSurface).
  const insights = useInsights({ status: 'active' });
  const spikeInsight = insights.data?.find((i) => i.type === 'expense_spike');

  // Both bank feeds (Plaid + Stripe Financial Connections) share the import
  // button; "Last imported" shows the most recent sync across them.
  const bankFeeds =
    integrations.data?.filter((i) => i.type === 'plaid' || i.type === 'stripe_fc') ?? [];
  const bankConnected = bankFeeds.some((i) => i.status === 'connected');
  const lastImportedAt =
    bankFeeds
      .map((i) => i.lastSyncedAt)
      .filter((t): t is string => t !== null)
      .sort()
      .at(-1) ?? null;
  // Server-driven cooldown: set from an import_rate_limited (429) response.
  // The server stays the authority — mock/demo mode has no cooldown, so the
  // button is never disabled preemptively.
  const [nextImportAt, setNextImportAt] = useState<string | null>(null);
  const importCoolingDown =
    nextImportAt !== null && new Date(nextImportAt).getTime() > Date.now();

  const confirmDelete = () => {
    if (!deleting) return;
    deleteTransaction.mutate(deleting.id, {
      onSuccess: () => {
        toast('Transaction deleted.', 'positive');
        setDeleting(null);
      },
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not delete the transaction.', 'danger'),
    });
  };

  const restore = (txn: Transaction) => {
    restoreTransaction.mutate(txn.id, {
      onSuccess: () => toast('Transaction restored to review.', 'positive'),
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not restore the transaction.', 'danger'),
    });
  };

  const columns: DataTableColumn<Transaction>[] = [
    {
      id: 'date',
      header: 'Date',
      sortable: true,
      cellClassName: 'whitespace-nowrap',
      cell: (txn) => formatDate(txn.date),
    },
    {
      id: 'description',
      header: 'Description',
      sortable: true,
      cell: (txn) => (
        <>
          <span className="font-medium text-ink">{txn.description}</span>
          {txn.rentLinked && (
            <span className="ml-2 text-xs text-ink-muted">· applied to rent</span>
          )}
          {txn.documentCount !== undefined && (
            <span className="ml-2 whitespace-nowrap text-xs text-ink-muted">
              · <IconPaperclip size={12} className="inline align-[-1px]" /> {txn.documentCount}
              <span className="sr-only">
                {txn.documentCount === 1 ? ' attachment' : ' attachments'}
              </span>
            </span>
          )}
          {txn.classification && (
            <span className="ml-2 text-xs text-ink-muted">
              · {txn.classification === 'owner_contribution' ? 'owner contribution' : txn.classification}
              {txn.classification === 'refund' ? '' : ' — not in P&L'}
            </span>
          )}
          {txn.vendor && <p className="mt-0.5 text-xs text-ink-muted">{txn.vendor}</p>}
        </>
      ),
    },
    {
      id: 'property',
      header: 'Property',
      filter: {
        kind: 'select',
        single: true,
        accessor: (txn) => txn.propertyId ?? '',
        options: propertyOptions,
      },
      cell: (txn) =>
        txn.propertyId ? (
          (propertyName.get(txn.propertyId) ?? '—')
        ) : (
          <span className="text-ink-muted">Portfolio</span>
        ),
    },
    {
      id: 'category',
      header: 'Category',
      filter: {
        kind: 'select',
        single: true,
        accessor: (txn) => txn.categoryId ?? '',
        options: categoryOptions,
      },
      cell: (txn) => (txn.categoryId ? (categoryName.get(txn.categoryId) ?? '—') : '—'),
    },
    {
      id: 'amount',
      header: 'Amount',
      align: 'right',
      sortable: true,
      filterLabel: 'Type',
      filter: {
        kind: 'select',
        single: true,
        accessor: (txn) => txn.type,
        options: TYPE_OPTIONS,
      },
      cell: (txn) => (
        <span className={cx('font-medium', txn.type === 'income' ? 'text-positive' : 'text-ink')}>
          {txn.type === 'income' ? '+' : '−'}
          {formatUsd(txn.amountCents)}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      filter: {
        kind: 'select',
        single: true,
        accessor: (txn) => txn.status,
        options: STATUS_OPTIONS,
      },
      cell: (txn) =>
        txn.status === 'confirmed' ? (
          <StatusBadge tone="positive">Confirmed</StatusBadge>
        ) : txn.status === 'dismissed' ? (
          <StatusBadge tone="neutral">Dismissed</StatusBadge>
        ) : (
          <StatusBadge tone="warning">Needs review</StatusBadge>
        ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      stickyRight: true,
      cell: (txn) => {
        const actions: RowAction[] = [
          { label: 'Edit', icon: <IconPencil size={14} />, onClick: () => setEditing(txn) },
        ];
        // Rent-linked rows drop Delete entirely — same guard the modal shows;
        // unlinking the deposit on the Rent page is the only way to remove it.
        if (txn.status === 'confirmed' && !txn.rentLinked) {
          actions.push({
            label: 'Delete',
            icon: <IconTrash size={14} />,
            onClick: () => setDeleting(txn),
          });
        }
        if (txn.status === 'dismissed') {
          actions.push({
            label: 'Restore to review',
            busy: restoreTransaction.isPending && restoreTransaction.variables === txn.id,
            onClick: () => restore(txn),
          });
        }
        return <RowActions context={txn.description} actions={actions} />;
      },
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Money"
        description="Income and expenses across your portfolio."
        breadcrumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Money' }]}
        actions={
          <>
            {lastImportedAt && (
              <span className="self-center text-xs text-ink-muted">
                Last imported {formatDateTime(lastImportedAt)}
              </span>
            )}
            <Button
              variant="ghost"
              busy={importBank.isPending}
              disabled={importCoolingDown}
              onClick={() =>
                importBank.mutate(undefined, {
                  onSuccess: (res) => {
                    const { message, tone } = importToastMessage(res, bankConnected);
                    toast(message, tone);
                  },
                  onError: (err) => {
                    if (err instanceof ApiClientError && err.code === 'plaid_not_connected') {
                      toast('Connect a bank account in Settings first.', 'danger', {
                        label: 'Go to Settings',
                        onClick: () => navigate('/settings#integrations'),
                      });
                      return;
                    }
                    if (err instanceof ApiClientError && err.code === 'import_rate_limited') {
                      const nextAllowedAt = err.detail?.nextAllowedAt;
                      if (nextAllowedAt) setNextImportAt(nextAllowedAt);
                      toast(
                        nextAllowedAt
                          ? `Bank already imported recently — next import available at ${formatDateTime(nextAllowedAt)}.`
                          : 'Bank already imported recently — try again later.',
                        'neutral',
                      );
                      return;
                    }
                    toast('Bank import failed. Try again.', 'danger');
                  },
                })
              }
            >
              <IconDownload size={14} />
              Import from bank
            </Button>
            <Link to="/money/review" className={buttonClasses('secondary')}>
              Review queue
              {pendingCount > 0 && (
                <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-semibold text-warning">
                  {pendingCount}
                </span>
              )}
            </Link>
            <Link to="/money/new" className={buttonClasses('primary')}>
              <IconPlus size={16} />
              Add transaction
            </Link>
          </>
        }
      />

      <LiveRegion>
        {spikeInsight && <InsightCard insight={spikeInsight} headingLevel={2} />}
      </LiveRegion>

      {/* Visible, clearable active-filter state for the ?unassigned=true deep
          link (the unassigned_transactions insight) — same "Filtered" +
          ghost-button-with-IconX Clear convention DataTable's own column
          filters use, surfaced here because "unassigned" isn't a per-column
          table filter. */}
      {unassignedOnly && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-sunken px-4 py-2.5 text-sm text-ink">
          <span>
            <span className="font-medium">Filtered:</span> showing only unassigned transactions —
            not tied to a property.
          </span>
          <Button variant="ghost" size="sm" onClick={clearUnassigned}>
            <IconX size={14} />
            Clear
          </Button>
        </div>
      )}

      {transactions.isPending ? (
        <Card flush className="p-4">
          <Skeleton className="h-64 w-full" />
        </Card>
      ) : transactions.isError ? (
        <ErrorNotice error={transactions.error} onRetry={() => void transactions.refetch()} />
      ) : transactions.data.total === 0 && !hasCriteria(state, unassignedOnly) ? (
        <Card flush>
          <EmptyState
            icon={<IconDollar size={28} />}
            title="No transactions yet"
            body="Import from your bank or add your first transaction to start tracking income and expenses."
            action={
              <Link to="/money/new" className={buttonClasses('primary')}>
                <IconPlus size={16} />
                Add transaction
              </Link>
            }
          />
        </Card>
      ) : (
        <Card flush>
          <DataTable
            caption="Transactions — date, description, property, category, amount, status, and actions"
            columns={columns}
            data={transactions.data.items}
            rowKey={(txn) => txn.id}
            searchPlaceholder="Search description or vendor"
            pageSize={PAGE_SIZE}
            itemNoun={{ one: 'transaction', other: 'transactions' }}
            emptyState="No transactions match your search and filters."
            manual={{
              total: transactions.data.total,
              loading: transactions.isFetching,
              state,
              onStateChange: setState,
            }}
          />
        </Card>
      )}

      <TransactionEditModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        transaction={editing}
      />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title="Delete transaction"
        confirmLabel="Delete"
        busy={deleteTransaction.isPending}
        body={
          <>
            This permanently deletes <strong>{deleting?.description}</strong> and removes it from
            every report. It can&rsquo;t be restored.
          </>
        }
      />
    </div>
  );
}
