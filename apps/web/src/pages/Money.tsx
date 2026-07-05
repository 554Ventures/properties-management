// Money — transactions ledger with filters, review-queue link with pending
// count, and mock bank import (PRD §5.4).
import { useMemo, useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type { TransactionStatus, TransactionType } from '@hearth/shared';
import { Link } from 'react-router-dom';
import { ApiClientError } from '../api/client';
import {
  useCategories,
  useImportTransactions,
  useIntegrations,
  useProperties,
  useReviewQueue,
  useTransactions,
} from '../api/queries';
import { PageHeader } from '../components/shell/PageHeader';
import { Button, buttonClasses } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Table, Td, Th, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { IconDollar, IconDownload, IconPlus } from '../components/ui/icons';
import { cx } from '../lib/cx';
import { formatDate } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';

export function Money() {
  usePageTitle('Money');
  const [propertyId, setPropertyId] = useState('');
  const [type, setType] = useState<'' | TransactionType>('');
  const [status, setStatus] = useState<'' | TransactionStatus>('');

  const transactions = useTransactions({
    propertyId: propertyId || undefined,
    type: type || undefined,
    status: status || undefined,
  });
  const review = useReviewQueue();
  const categories = useCategories();
  const properties = useProperties();
  const integrations = useIntegrations();
  const importBank = useImportTransactions();
  const { toast } = useToast();

  const categoryName = useMemo(
    () => new Map((categories.data ?? []).map((c) => [c.id, c.name])),
    [categories.data],
  );
  const propertyName = useMemo(
    () => new Map((properties.data ?? []).map((p) => [p.id, p.nickname ?? p.addressLine1])),
    [properties.data],
  );

  const pendingCount = review.data?.items.length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Money"
        description="Income and expenses across your portfolio."
        breadcrumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Money' }]}
        actions={
          <>
            <Button
              variant="ghost"
              busy={importBank.isPending}
              onClick={() =>
                importBank.mutate(undefined, {
                  onSuccess: (res) => {
                    if (res.imported > 0) {
                      toast(
                        `Imported ${res.imported} bank transactions into the review queue.`,
                        'positive',
                      );
                      return;
                    }
                    const plaidConnected = integrations.data?.some(
                      (i) => i.type === 'plaid' && i.status === 'connected',
                    );
                    toast(
                      plaidConnected
                        ? 'No new transactions yet — bank sync can take a minute after connecting. Try again shortly.'
                        : 'No new bank transactions to import.',
                      'neutral',
                    );
                  },
                  onError: (err) => {
                    if (err instanceof ApiClientError && err.code === 'plaid_not_connected') {
                      toast('Connect a bank account in Settings first.', 'danger');
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

      <Card className="p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="filter-property" className="text-xs font-medium text-ink-muted">
              Property
            </label>
            <Select
              id="filter-property"
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
          <div className="flex flex-col gap-1.5">
            <label htmlFor="filter-type" className="text-xs font-medium text-ink-muted">
              Type
            </label>
            <Select
              id="filter-type"
              value={type}
              onChange={(e) => setType(e.target.value as '' | TransactionType)}
            >
              <option value="">Income & expenses</option>
              <option value="income">Income</option>
              <option value="expense">Expenses</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="filter-status" className="text-xs font-medium text-ink-muted">
              Status
            </label>
            <Select
              id="filter-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as '' | TransactionStatus)}
            >
              <option value="">Any status</option>
              <option value="confirmed">Confirmed</option>
              <option value="pending_review">Needs review</option>
            </Select>
          </div>
        </div>
      </Card>

      {transactions.isPending ? (
        <Card flush className="p-4">
          <Skeleton className="h-64 w-full" />
        </Card>
      ) : transactions.isError ? (
        <ErrorNotice error={transactions.error} onRetry={() => void transactions.refetch()} />
      ) : transactions.data.items.length === 0 ? (
        <Card flush>
          <EmptyState
            icon={<IconDollar size={28} />}
            title="No transactions found"
            body="Try widening the filters, or add your first transaction."
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
          <Table caption="Transactions — date, description, property, category, amount, and status">
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Description</Th>
                <Th>Property</Th>
                <Th>Category</Th>
                <Th align="right">Amount</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {transactions.data.items.map((txn) => (
                <Tr key={txn.id}>
                  <Td className="whitespace-nowrap">{formatDate(txn.date)}</Td>
                  <Td>
                    <span className="font-medium text-ink">{txn.description}</span>
                    {txn.vendor && <p className="mt-0.5 text-xs text-ink-muted">{txn.vendor}</p>}
                  </Td>
                  <Td>
                    {txn.propertyId ? (propertyName.get(txn.propertyId) ?? '—') : (
                      <span className="text-ink-muted">Portfolio</span>
                    )}
                  </Td>
                  <Td>{txn.categoryId ? (categoryName.get(txn.categoryId) ?? '—') : '—'}</Td>
                  <Td
                    align="right"
                    className={cx('font-medium', txn.type === 'income' ? 'text-positive' : 'text-ink')}
                  >
                    {txn.type === 'income' ? '+' : '−'}
                    {formatUsd(txn.amountCents)}
                  </Td>
                  <Td>
                    {txn.status === 'confirmed' ? (
                      <StatusBadge tone="positive">Confirmed</StatusBadge>
                    ) : (
                      <StatusBadge tone="warning">Needs review</StatusBadge>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
