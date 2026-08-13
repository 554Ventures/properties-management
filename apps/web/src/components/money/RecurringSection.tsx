// "Recurring" section on the Money page (PLAN-REAL-EQUITY §2/§6 Phase 2 item
// 8): standing instructions ("rent's mortgage is $2,400 on the 1st"), never
// ledger rows themselves — the scheduler drafts the most recent due
// occurrence into the review queue as a pending row the user confirms.
// Self-contained like FinancingCard: owns its own modal state; cadence and
// next-due always render in plain words / the server's own `nextOccurrence`,
// never recomputed here.
import { useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type { Property, RecurringTemplate } from '@hearth/shared';
import {
  useArchiveRecurringTemplate,
  useRecurringTemplates,
  useRestoreRecurringTemplate,
} from '../../api/queries';
import { describeCadence, formatCalendarDate } from '../../lib/format';
import { RecurringTemplateFormModal } from '../forms/RecurringTemplateFormModal';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { ErrorNotice } from '../ui/ErrorNotice';
import { RowActions, type RowAction } from '../ui/RowActions';
import { Skeleton } from '../ui/Skeleton';
import { StatusBadge } from '../ui/StatusBadge';
import { Table, Td, Th, Tr } from '../ui/Table';
import { useToast } from '../ui/Toast';
import { IconCalendarCheck, IconPencil, IconPlus } from '../ui/icons';

type RecurringModal = { kind: 'create' } | { kind: 'edit'; template: RecurringTemplate } | null;

export interface RecurringSectionProps {
  properties: Property[];
  canMoney: boolean;
}

export function RecurringSection({ properties, canMoney }: RecurringSectionProps) {
  const templates = useRecurringTemplates(true);
  const archive = useArchiveRecurringTemplate();
  const restore = useRestoreRecurringTemplate();
  const { toast } = useToast();
  const [modal, setModal] = useState<RecurringModal>(null);
  const [showPaused, setShowPaused] = useState(false);

  const propertyName = new Map(properties.map((p) => [p.id, p.nickname ?? p.addressLine1]));

  const all = templates.data ?? [];
  const activeTemplates = all.filter((t) => !t.archivedAt);
  const pausedTemplates = all.filter((t) => t.archivedAt);
  const visible = showPaused ? [...activeTemplates, ...pausedTemplates] : activeTemplates;

  const pause = (t: RecurringTemplate) => {
    archive.mutate(t.id, {
      onSuccess: () =>
        toast(
          `"${t.description}" paused — no more automatic drafts until you resume it.`,
          'positive',
        ),
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not pause the template.', 'danger'),
    });
  };

  const resume = (t: RecurringTemplate) => {
    restore.mutate(t.id, {
      onSuccess: () =>
        toast(`"${t.description}" resumed — only the next due occurrence will draft.`, 'positive'),
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not resume the template.', 'danger'),
    });
  };

  return (
    <section aria-label="Recurring" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">Recurring</h2>
        {canMoney && (
          <Button size="sm" onClick={() => setModal({ kind: 'create' })}>
            <IconPlus size={14} />
            Add template
          </Button>
        )}
      </div>

      {all.length > 0 && (
        <p className="text-xs text-ink-muted">
          Pausing a template stops future drafts. Resuming doesn&rsquo;t backfill what was missed
          — only the next due occurrence drafts.
        </p>
      )}

      <Card flush>
        {templates.isPending ? (
          <div className="p-4">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : templates.isError ? (
          <div className="p-4">
            <ErrorNotice error={templates.error} onRetry={() => void templates.refetch()} />
          </div>
        ) : all.length === 0 ? (
          <EmptyState
            icon={<IconCalendarCheck size={28} />}
            title="No recurring templates yet"
            body="A recurring template is a standing instruction — like “rent’s mortgage is $2,400 on the 1st” — that drafts a pending row into the review queue each time it comes due, for you to confirm."
            action={
              canMoney ? (
                <Button size="sm" onClick={() => setModal({ kind: 'create' })}>
                  Add template
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="flex flex-col gap-3 p-4">
            {pausedTemplates.length > 0 && (
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-pressed={showPaused}
                  onClick={() => setShowPaused((v) => !v)}
                >
                  {showPaused ? 'Hide paused' : `Show paused (${pausedTemplates.length})`}
                </Button>
              </div>
            )}
            {visible.length === 0 ? (
              <p className="text-sm text-ink-muted">
                All templates here are paused — use &ldquo;Show paused&rdquo; above to see them.
              </p>
            ) : (
              <Table caption="Recurring templates">
                <thead>
                  <tr>
                    <Th>Description</Th>
                    <Th>Cadence</Th>
                    <Th>Next due</Th>
                    <Th>Property</Th>
                    <Th align="right">Amount</Th>
                    <Th align="right" stickyRight>
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((t) => {
                    const isPaused = Boolean(t.archivedAt);
                    const actions: RowAction[] = canMoney
                      ? [
                          {
                            label: 'Edit',
                            icon: <IconPencil size={14} />,
                            onClick: () => setModal({ kind: 'edit', template: t }),
                          },
                          {
                            label: 'Pause',
                            onClick: () => pause(t),
                            busy: archive.isPending && archive.variables === t.id,
                          },
                        ]
                      : [];
                    return (
                      <Tr key={t.id}>
                        <Td className="font-medium">
                          {t.description}
                          {t.vendor && <p className="mt-0.5 text-xs text-ink-muted">{t.vendor}</p>}
                          {isPaused && (
                            <div className="mt-1">
                              <StatusBadge tone="neutral">Paused</StatusBadge>
                            </div>
                          )}
                        </Td>
                        <Td>{describeCadence(t.cadence, t.anchorDate)}</Td>
                        <Td>
                          {isPaused ? (
                            <span className="text-ink-muted">Resume to schedule the next draft.</span>
                          ) : t.nextOccurrence ? (
                            formatCalendarDate(t.nextOccurrence)
                          ) : (
                            <span className="text-ink-muted">—</span>
                          )}
                        </Td>
                        <Td>
                          {t.propertyId ? (
                            (propertyName.get(t.propertyId) ?? '—')
                          ) : (
                            <span className="text-ink-muted">Portfolio</span>
                          )}
                        </Td>
                        <Td align="right" className="tabular-nums">
                          {formatUsd(t.amountCents)}
                        </Td>
                        <Td align="right" stickyRight>
                          {isPaused ? (
                            canMoney ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                busy={restore.isPending && restore.variables === t.id}
                                onClick={() => resume(t)}
                              >
                                Resume
                              </Button>
                            ) : null
                          ) : (
                            <RowActions context={t.description} actions={actions} />
                          )}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </div>
        )}
      </Card>

      {modal?.kind === 'create' && (
        <RecurringTemplateFormModal open mode="create" onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'edit' && (
        <RecurringTemplateFormModal
          open
          mode="edit"
          template={modal.template}
          onClose={() => setModal(null)}
        />
      )}
    </section>
  );
}
