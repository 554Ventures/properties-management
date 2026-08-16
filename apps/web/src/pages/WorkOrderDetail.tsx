// Work order detail (PRD §5.10, PLAN-MAINTENANCE §6): quick status/priority/
// assignment/schedule controls (auto-save — each is its own field, so there's
// no separate Save step), quote vs. the server-derived actual cost with the
// variance, the linked-cost table (which rows count toward that derived
// total and why), notes, and the shared DocumentsCard. Title/attribution/
// description/quote/notes edit through the WorkOrderFormModal (Edit button);
// see that component's header comment for why the split.
import { useState, type ReactNode } from 'react';
import { formatUsd, formatUsdWhole } from '@hearth/shared';
import type { WorkOrderPriority, WorkOrderStatus } from '@hearth/shared';
import { useNavigate, useParams } from 'react-router';
import {
  useArchiveWorkOrder,
  useContractors,
  useRestoreWorkOrder,
  useUpdateWorkOrder,
  useWorkOrderDetail,
} from '../api/queries';
import { WorkOrderFormModal } from '../components/forms/WorkOrderFormModal';
import { DocumentsCard } from '../components/documents/DocumentsCard';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { KpiTile } from '../components/ui/KpiTile';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge, type BadgeTone } from '../components/ui/StatusBadge';
import { Table, Td, Th, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { formatCalendarDate, formatDate } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';
import { usePermissions } from '../lib/usePermissions';

const STATUS_LABEL: Record<WorkOrderStatus, string> = {
  open: 'Open',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
const STATUS_TONE: Record<WorkOrderStatus, BadgeTone> = {
  open: 'warning',
  scheduled: 'neutral',
  in_progress: 'neutral',
  completed: 'positive',
  cancelled: 'neutral',
};
const PRIORITY_LABEL: Record<WorkOrderPriority, string> = {
  emergency: 'Emergency',
  normal: 'Normal',
  low: 'Low',
};

/** A quick-control field: a real `<label for>` only when there's an
 *  interactive control to associate it with — `label[for]` must reference a
 *  labelable element, so the read-only branch renders a plain heading text
 *  instead of a dangling association. */
function ControlField({
  label,
  htmlFor,
  editable,
  control,
  display,
}: {
  label: string;
  htmlFor: string;
  editable: boolean;
  control: ReactNode;
  display: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {editable ? (
        <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
          {label}
        </label>
      ) : (
        <span className="text-sm font-medium text-ink">{label}</span>
      )}
      {editable ? control : display}
    </div>
  );
}

export function WorkOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const detail = useWorkOrderDetail(id);
  const title = detail.data?.title ?? 'Work order';
  usePageTitle(title);

  const navigate = useNavigate();
  const { toast } = useToast();
  const { can } = usePermissions();
  const canProperties = can('properties');
  const contractors = useContractors();
  const update = useUpdateWorkOrder();
  const archive = useArchiveWorkOrder();
  const restore = useRestoreWorkOrder();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const onUpdateError = (err: unknown) =>
    toast(err instanceof Error ? err.message : 'Could not save the change.', 'danger');

  if (detail.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Work order"
          breadcrumbs={[
            { label: 'Dashboard', to: '/' },
            { label: 'Maintenance', to: '/maintenance' },
            { label: 'Detail' },
          ]}
        />
        <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const wo = detail.data;
  const variance = wo.quoteVarianceCents;
  const varianceTone: 'positive' | 'danger' | undefined =
    variance == null || variance === 0 ? undefined : variance > 0 ? 'danger' : 'positive';
  const varianceValue =
    variance == null
      ? '—'
      : variance === 0
        ? formatUsd(0)
        : `${formatUsd(Math.abs(variance))} ${variance > 0 ? 'over' : 'under'}`;

  const doArchive = () => {
    archive.mutate(wo.id, {
      onSuccess: () => {
        toast(`${wo.title} archived.`, 'positive');
        setConfirmArchive(false);
        navigate('/maintenance');
      },
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not archive the work order.', 'danger'),
    });
  };

  const doRestore = () => {
    restore.mutate(wo.id, {
      onSuccess: () => toast(`${wo.title} restored.`, 'positive'),
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not restore the work order.', 'danger'),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={wo.title}
        description={`${wo.propertyLabel}${wo.unitLabel ? ` · ${wo.unitLabel}` : ''}`}
        breadcrumbs={[
          { label: 'Dashboard', to: '/' },
          { label: 'Maintenance', to: '/maintenance' },
          { label: wo.title },
        ]}
        actions={
          <div className="flex items-center gap-2">
            {wo.archivedAt ? (
              <>
                {/* Archived is state, not a write control — icon + text, never
                    color alone. */}
                <StatusBadge tone="neutral">Archived</StatusBadge>
                {canProperties && (
                  <Button variant="secondary" size="sm" busy={restore.isPending} onClick={doRestore}>
                    Restore
                  </Button>
                )}
              </>
            ) : (
              canProperties && (
                <>
                  <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
                    Edit
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(true)}>
                    Archive
                  </Button>
                </>
              )
            )}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Quote"
          value={wo.quotedCents != null ? formatUsdWhole(wo.quotedCents) : '—'}
          ariaLabel={wo.quotedCents != null ? `Quote, ${formatUsdWhole(wo.quotedCents)}` : 'Quote, none entered'}
        />
        <KpiTile
          label="Actual (linked expenses)"
          value={formatUsdWhole(wo.costCents)}
          ariaLabel={`Actual cost, ${formatUsdWhole(wo.costCents)}, across ${wo.linkedTransactionCount} linked ${wo.linkedTransactionCount === 1 ? 'transaction' : 'transactions'}`}
        />
        <KpiTile
          label="Variance"
          value={varianceValue}
          tone={varianceTone}
          ariaLabel={
            variance == null
              ? 'Variance, no quote entered'
              : `Variance, ${varianceValue} quote`
          }
        />
        <KpiTile
          label="Days open"
          value={String(wo.daysOpen)}
          ariaLabel={`Days open, ${wo.daysOpen}${wo.overdue ? ', overdue' : ''}`}
        >
          {wo.overdue && <span className="text-xs font-medium text-danger">Overdue</span>}
        </KpiTile>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">Status &amp; schedule</h2>
          <div className="flex flex-col gap-4">
            <ControlField
              label="Status"
              htmlFor="wo-status-select"
              editable={canProperties}
              display={<StatusBadge tone={STATUS_TONE[wo.status]}>{STATUS_LABEL[wo.status]}</StatusBadge>}
              control={
                <Select
                  id="wo-status-select"
                  value={wo.status}
                  onChange={(e) =>
                    update.mutate(
                      { id: wo.id, status: e.target.value as WorkOrderStatus },
                      { onError: onUpdateError },
                    )
                  }
                >
                  {(Object.keys(STATUS_LABEL) as WorkOrderStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </Select>
              }
            />
            <ControlField
              label="Priority"
              htmlFor="wo-priority-select"
              editable={canProperties}
              display={<p className="text-sm text-ink">{PRIORITY_LABEL[wo.priority]}</p>}
              control={
                <Select
                  id="wo-priority-select"
                  value={wo.priority}
                  onChange={(e) =>
                    update.mutate(
                      { id: wo.id, priority: e.target.value as WorkOrderPriority },
                      { onError: onUpdateError },
                    )
                  }
                >
                  {(Object.keys(PRIORITY_LABEL) as WorkOrderPriority[]).map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </Select>
              }
            />
            <ControlField
              label="Contractor"
              htmlFor="wo-contractor-select"
              editable={canProperties}
              display={<p className="text-sm text-ink">{wo.contractorName ?? 'Unassigned'}</p>}
              control={
                <Select
                  id="wo-contractor-select"
                  value={wo.contractorId ?? ''}
                  onChange={(e) =>
                    update.mutate(
                      { id: wo.id, contractorId: e.target.value || null },
                      { onError: onUpdateError },
                    )
                  }
                >
                  <option value="">Unassigned</option>
                  {(contractors.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              }
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ControlField
                label="Scheduled for"
                htmlFor="wo-scheduled-input"
                editable={canProperties}
                display={
                  <p className="text-sm text-ink">
                    {wo.scheduledFor ? formatCalendarDate(wo.scheduledFor) : '—'}
                  </p>
                }
                control={
                  <input
                    id="wo-scheduled-input"
                    type="date"
                    value={wo.scheduledFor ?? ''}
                    onChange={(e) =>
                      update.mutate(
                        { id: wo.id, scheduledFor: e.target.value || null },
                        { onError: onUpdateError },
                      )
                    }
                    className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-ink"
                  />
                }
              />
              <ControlField
                label="Due by"
                htmlFor="wo-due-input"
                editable={canProperties}
                display={
                  <p className="text-sm text-ink">
                    {wo.dueBy ? formatCalendarDate(wo.dueBy) : '—'}
                  </p>
                }
                control={
                  <input
                    id="wo-due-input"
                    type="date"
                    value={wo.dueBy ?? ''}
                    onChange={(e) =>
                      update.mutate(
                        { id: wo.id, dueBy: e.target.value || null },
                        { onError: onUpdateError },
                      )
                    }
                    className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-ink"
                  />
                }
              />
            </div>
            {/* Every direct child of a <dl> must itself be a dt/dd group (or a
                <div> wrapping one) — nesting the two-column pair inside an
                extra grid <div> breaks that content model (axe's
                definition-list/dlitem rules), so the grid lives on the <dl>
                itself instead. */}
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Reported
                </dt>
                <dd className="text-ink">{formatCalendarDate(wo.reportedOn)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Completed
                </dt>
                <dd className="text-ink">
                  {wo.completedOn ? formatCalendarDate(wo.completedOn) : '—'}
                </dd>
              </div>
              {wo.tenantName && (
                <div className="col-span-2">
                  <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                    Reported by
                  </dt>
                  <dd className="text-ink">{wo.tenantName}</dd>
                </div>
              )}
              {wo.description && (
                <div className="col-span-2">
                  <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                    Description
                  </dt>
                  <dd className="text-ink-muted">{wo.description}</dd>
                </div>
              )}
              {wo.notes && (
                <div className="col-span-2">
                  <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                    Notes
                  </dt>
                  <dd className="text-ink-muted">{wo.notes}</dd>
                </div>
              )}
            </dl>
          </div>
        </Card>

        <section aria-label="Linked expenses" className="flex flex-col gap-3 lg:col-span-2">
          <h2 className="text-base font-semibold text-ink">Linked expenses</h2>
          <Card flush>
            {wo.costs.length === 0 ? (
              <p className="p-5 text-sm text-ink-muted">
                No expenses linked yet — link one from the Money review queue or a transaction's Edit
                action ("Link to work order…").
              </p>
            ) : (
              <>
                <p className="border-b border-border px-4 py-3 text-xs text-ink-muted">
                  A row counts toward the actual cost above only once it's a confirmed, ordinary
                  expense — a still-pending row, or one marked as a transfer, owner contribution, or
                  refund, doesn't count.
                </p>
                <Table caption={`${wo.title} — linked expenses and which count toward actual cost`}>
                  <thead>
                    <tr>
                      <Th>Date</Th>
                      <Th>Description</Th>
                      <Th align="right">Amount</Th>
                      <Th>Counted</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {wo.costs.map((c) => (
                      <Tr key={c.transactionId}>
                        <Td>{formatDate(c.date)}</Td>
                        <Td>
                          {c.description}
                          {c.vendor && <p className="mt-0.5 text-xs text-ink-muted">{c.vendor}</p>}
                        </Td>
                        <Td align="right">{formatUsd(c.amountCents)}</Td>
                        <Td>
                          {c.countedInCost ? (
                            <StatusBadge tone="positive">Counted</StatusBadge>
                          ) : (
                            <StatusBadge tone="neutral">Not counted</StatusBadge>
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </>
            )}
          </Card>

          <DocumentsCard
            filter={{ entityType: 'work_order', entityId: wo.id }}
            uploadTarget={{ entityType: 'work_order', entityId: wo.id }}
          />
        </section>
      </div>

      <WorkOrderFormModal
        mode="edit"
        open={editOpen}
        workOrder={wo}
        onClose={() => setEditOpen(false)}
      />
      <ConfirmDialog
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        onConfirm={doArchive}
        title="Archive work order"
        confirmLabel="Archive"
        busy={archive.isPending}
        body={
          <>
            This removes <strong>{wo.title}</strong> from the active list. Linked expenses and
            history stay on your ledger, and you can restore it later.
          </>
        }
      />
    </div>
  );
}
