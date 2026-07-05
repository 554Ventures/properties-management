// Review queue — pending_review transactions with the AI category suggestion
// as an AiChip; the user confirms (accepting or overriding) before anything
// counts toward reports/taxes (PRD §5.4). Income items that look like a
// lease's open expected rent also carry a rent-match suggestion — accepting it
// links the deposit to the Rent Tracker instead of double-counting the month.
import { useMemo, useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type { Category, ReviewQueueItem } from '@hearth/shared';
import { ApiClientError } from '../api/client';
import {
  useCategories,
  useConfirmTransaction,
  useProperties,
  usePropertyDetail,
  useReviewQueue,
} from '../api/queries';
import { AiChip } from '../components/ai/AiChip';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge } from '../components/ui/StatusBadge';
import { useToast } from '../components/ui/Toast';
import { IconCheck } from '../components/ui/icons';
import { formatDate, formatMonth } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';

export function MoneyReview() {
  usePageTitle('Review queue');
  const review = useReviewQueue();
  const categories = useCategories();

  const categoriesByType = useMemo(() => {
    const all = categories.data ?? [];
    return {
      income: all.filter((c) => c.type === 'income'),
      expense: all.filter((c) => c.type === 'expense'),
    };
  }, [categories.data]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Review queue"
        description="Imported and scanned transactions wait here until you confirm the category — nothing counts toward reports or taxes until then."
        breadcrumbs={[{ label: 'Money', to: '/money' }, { label: 'Review queue' }]}
      />

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
      ) : review.data.items.length === 0 ? (
        <Card flush>
          <EmptyState
            icon={<IconCheck size={28} />}
            title="You're all caught up"
            body="New bank imports and scanned receipts will appear here for review."
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-4">
          {review.data.items.map((item) => (
            <li key={item.id}>
              <ReviewItemCard item={item} categoryOptions={categoriesByType[item.type]} />
            </li>
          ))}
        </ul>
      )}
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
  const properties = useProperties();
  const { toast } = useToast();
  const [categoryId, setCategoryId] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [unitId, setUnitId] = useState('');
  // Rent-match acceptance is an explicit user action (never auto-applied).
  const [rentAccepted, setRentAccepted] = useState(false);

  const propertyDetail = usePropertyDetail(propertyId || undefined);
  const units = propertyDetail.data?.units ?? [];
  const rentMatch = item.rentMatch;

  const confirmItem = () => {
    const payload =
      rentAccepted && rentMatch
        ? { id: item.id, rentPaymentId: rentMatch.rentPaymentId }
        : {
            id: item.id,
            categoryId: categoryId || undefined,
            propertyId: propertyId || undefined,
            unitId: unitId || undefined,
          };
    confirm.mutate(payload, {
      onSuccess: () =>
        toast(
          rentAccepted && rentMatch
            ? `Confirmed and marked ${rentMatch.tenantName}'s ${formatMonth(rentMatch.period)} rent paid.`
            : `Confirmed “${item.description}”.`,
          'positive',
        ),
      onError: (err) =>
        toast(
          err instanceof ApiClientError ? err.message : 'Could not confirm the transaction. Try again.',
          'danger',
        ),
    });
  };

  return (
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
                applied={rentAccepted}
                onApply={() => setRentAccepted(true)}
              />
            )}
            {item.aiSuggestedCategoryId && item.aiSuggestedCategoryName && !rentAccepted && (
              <AiChip
                name={item.aiSuggestedCategoryName}
                confidence={item.aiConfidence ?? 0}
                applied={categoryId === item.aiSuggestedCategoryId}
                onApply={() => setCategoryId(item.aiSuggestedCategoryId as string)}
              />
            )}
            {item.aiConfidence != null && item.aiConfidence < 0.7 && (
              <StatusBadge tone="warning">Low confidence — check this one</StatusBadge>
            )}
          </div>
        </div>
        <div className="flex w-full flex-col gap-2 md:w-64">
          {rentAccepted && rentMatch ? (
            <>
              <p className="text-sm text-ink-muted">
                Confirming marks <span className="font-medium text-ink">{rentMatch.tenantName}</span>
                ’s {formatMonth(rentMatch.period)} rent paid and files this under{' '}
                <span className="font-medium text-ink">
                  {rentMatch.propertyLabel} · {rentMatch.unitLabel}
                </span>{' '}
                as Rent.
              </p>
              <Button variant="ghost" onClick={() => setRentAccepted(false)}>
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
            </>
          )}
          <Button busy={confirm.isPending} onClick={confirmItem}>
            <IconCheck size={14} />
            Confirm
          </Button>
        </div>
      </div>
    </Card>
  );
}
