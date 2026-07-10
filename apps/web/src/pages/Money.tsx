// Money — transactions ledger with per-header sort/filter, a description/vendor
// search, and numbered server-side pagination (PRD §5.4). All searching,
// filtering, sorting, and paging run on the server via the DataTable `manual`
// mode; the review-queue link shows the pending count.
import { useMemo, useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type {
  ImportTransactionsResponse,
  Transaction,
  TransactionListQuery,
  TransactionSortField,
  TransactionStatus,
  TransactionType,
} from '@hearth/shared';
import { Link, useNavigate } from 'react-router-dom';
import { ApiClientError } from '../api/client';
import {
  useCategories,
  useImportTransactions,
  useIntegrations,
  useProperties,
  useReviewQueue,
  useTransactions,
} from '../api/queries';
import { TransactionEditModal } from '../components/forms/TransactionEditModal';
import { PageHeader } from '../components/shell/PageHeader';
import { Button, buttonClasses } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import {
  DataTable,
  emptyDataTableState,
  type DataTableColumn,
  type DataTableState,
  type FilterValue,
} from '../components/ui/DataTable';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge } from '../components/ui/StatusBadge';
import { useToast } from '../components/ui/Toast';
import { IconDollar, IconDownload, IconPlus } from '../components/ui/icons';
import { cx } from '../lib/cx';
import { formatDate, formatDateTime } from '../lib/format';
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

/** Toast copy for a bank-import result. Exported for tests. */
export function importToastMessage(
  res: ImportTransactionsResponse,
  plaidConnected: boolean,
): { message: string; tone: 'positive' | 'neutral' } {
  const s = (n: number) => (n === 1 ? '' : 's');
  const parts: string[] = [];
  if (res.imported > 0) {
    parts.push(`Imported ${res.imported} new bank transaction${s(res.imported)} into the review queue.`);
  }
  if (res.updated > 0) {
    parts.push(`Updated ${res.updated} pending transaction${s(res.updated)} with bank corrections.`);
  }
  if (res.removed > 0) {
    parts.push(`Removed ${res.removed} transaction${s(res.removed)} voided by the bank.`);
  }
  if (parts.length > 0) return { message: parts.join(' '), tone: 'positive' };
  if (res.skipped > 0) {
    return {
      message: `Already up to date — ${res.skipped} previously imported transaction${s(res.skipped)} unchanged.`,
      tone: 'neutral',
    };
  }
  return {
    message: plaidConnected
      ? 'No new transactions yet — bank sync can take a minute after connecting. Try again shortly.'
      : 'No new bank transactions to import.',
    tone: 'neutral',
  };
}

// The single selected value of a select filter (server params are single-value).
function selected(filters: Record<string, FilterValue>, id: string): string | undefined {
  const f = filters[id];
  return f?.kind === 'select' && f.values.length > 0 ? f.values[0] : undefined;
}

function hasCriteria(state: DataTableState): boolean {
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
  const [state, setState] = useState<DataTableState>(emptyDataTableState);
  const [editing, setEditing] = useState<Transaction | null>(null);

  const query: TransactionListQuery = useMemo(() => {
    const sortField = state.sort ? SORT_FIELD[state.sort.columnId] : undefined;
    return {
      q: state.search.trim() || undefined,
      propertyId: selected(state.filters, 'property'),
      categoryId: selected(state.filters, 'category'),
      type: selected(state.filters, 'amount') as TransactionType | undefined,
      status: selected(state.filters, 'status') as TransactionStatus | undefined,
      sort: sortField,
      dir: sortField ? state.sort?.dir : undefined,
      limit: PAGE_SIZE,
      offset: state.page * PAGE_SIZE,
    };
  }, [state]);

  const transactions = useTransactions(query);
  const review = useReviewQueue();
  const categories = useCategories();
  const properties = useProperties();
  const integrations = useIntegrations();
  const importBank = useImportTransactions();
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

  const plaid = integrations.data?.find((i) => i.type === 'plaid');
  // Server-driven cooldown: set from an import_rate_limited (429) response.
  // The server stays the authority — mock/demo mode has no cooldown, so the
  // button is never disabled preemptively.
  const [nextImportAt, setNextImportAt] = useState<string | null>(null);
  const importCoolingDown =
    nextImportAt !== null && new Date(nextImportAt).getTime() > Date.now();

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
      cell: (txn) => (
        <Button variant="ghost" onClick={() => setEditing(txn)}>
          Edit
          <span className="sr-only"> “{txn.description}”</span>
        </Button>
      ),
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
            {plaid?.lastSyncedAt && (
              <span className="self-center text-xs text-ink-muted">
                Last imported {formatDateTime(plaid.lastSyncedAt)}
              </span>
            )}
            <Button
              variant="ghost"
              busy={importBank.isPending}
              disabled={importCoolingDown}
              onClick={() =>
                importBank.mutate(undefined, {
                  onSuccess: (res) => {
                    const { message, tone } = importToastMessage(
                      res,
                      plaid?.status === 'connected',
                    );
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

      {transactions.isPending ? (
        <Card flush className="p-4">
          <Skeleton className="h-64 w-full" />
        </Card>
      ) : transactions.isError ? (
        <ErrorNotice error={transactions.error} onRetry={() => void transactions.refetch()} />
      ) : transactions.data.total === 0 && !hasCriteria(state) ? (
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
    </div>
  );
}
