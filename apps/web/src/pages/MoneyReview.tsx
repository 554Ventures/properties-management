// Review queue — pending_review transactions with the AI category suggestion
// as an AiChip; the user confirms (accepting or overriding) before anything
// counts toward reports/taxes (PRD §5.4).
import { useMemo, useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type { ReviewQueueItem } from '@hearth/shared';
import { useCategories, useConfirmTransaction, useReviewQueue } from '../api/queries';
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
import { formatDate } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';

export function MoneyReview() {
  usePageTitle('Review queue');
  const review = useReviewQueue();
  const categories = useCategories();
  const confirm = useConfirmTransaction();
  const { toast } = useToast();
  // Per-item category selection; empty = accept the AI suggestion server-side.
  const [selected, setSelected] = useState<Record<string, string>>({});

  const categoriesByType = useMemo(() => {
    const all = categories.data ?? [];
    return {
      income: all.filter((c) => c.type === 'income'),
      expense: all.filter((c) => c.type === 'expense'),
    };
  }, [categories.data]);

  const confirmItem = (item: ReviewQueueItem) => {
    const categoryId = selected[item.id];
    confirm.mutate(
      { id: item.id, categoryId: categoryId || undefined },
      {
        onSuccess: () => toast(`Confirmed “${item.description}”.`, 'positive'),
        onError: () => toast('Could not confirm the transaction. Try again.', 'danger'),
      },
    );
  };

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
          {review.data.items.map((item) => {
            const options = categoriesByType[item.type];
            const chosen = selected[item.id] ?? '';
            return (
              <li key={item.id}>
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
                        {item.aiSuggestedCategoryId && item.aiSuggestedCategoryName && (
                          <AiChip
                            name={item.aiSuggestedCategoryName}
                            confidence={item.aiConfidence ?? 0}
                            applied={chosen === item.aiSuggestedCategoryId}
                            onApply={() =>
                              setSelected((prev) => ({
                                ...prev,
                                [item.id]: item.aiSuggestedCategoryId as string,
                              }))
                            }
                          />
                        )}
                        {item.aiConfidence != null && item.aiConfidence < 0.7 && (
                          <StatusBadge tone="warning">Low confidence — check this one</StatusBadge>
                        )}
                      </div>
                    </div>
                    <div className="flex w-full flex-col gap-2 md:w-64">
                      <label
                        htmlFor={`review-category-${item.id}`}
                        className="text-xs font-medium text-ink-muted"
                      >
                        Category
                      </label>
                      <Select
                        id={`review-category-${item.id}`}
                        value={chosen}
                        onChange={(e) =>
                          setSelected((prev) => ({ ...prev, [item.id]: e.target.value }))
                        }
                      >
                        <option value="">
                          {item.aiSuggestedCategoryName
                            ? `Accept suggestion (${item.aiSuggestedCategoryName})`
                            : 'Choose a category'}
                        </option>
                        {options.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                      <Button busy={confirm.isPending} onClick={() => confirmItem(item)}>
                        <IconCheck size={14} />
                        Confirm
                      </Button>
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
