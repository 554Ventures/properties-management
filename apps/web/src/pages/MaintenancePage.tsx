// /maintenance — work order index (PRD §5.10, PLAN-MAINTENANCE §6). List of
// title/property·unit/status/priority/contractor/schedule/derived cost, open
// work ahead of completed/cancelled (the API already orders it that way).
// Contractors joins as a sibling tab under the same Maintenance section.
import { useState } from 'react';
import { formatUsdWhole } from '@hearth/shared';
import type { WorkOrderListRow, WorkOrderPriority, WorkOrderStatus } from '@hearth/shared';
import { Link } from 'react-router';
import { useProperties, useWorkOrders } from '../api/queries';
import { WorkOrderFormModal } from '../components/forms/WorkOrderFormModal';
import { MaintenanceTabs } from '../components/shell/MaintenanceTabs';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { DataTable, type DataTableColumn } from '../components/ui/DataTable';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge, type BadgeTone } from '../components/ui/StatusBadge';
import { IconPlus, IconWrench } from '../components/ui/icons';
import { cx } from '../lib/cx';
import { formatCalendarDate } from '../lib/format';
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
const STATUS_OPTIONS = (Object.keys(STATUS_LABEL) as WorkOrderStatus[]).map((value) => ({
  value,
  label: STATUS_LABEL[value],
}));
const PRIORITY_OPTIONS = (Object.keys(PRIORITY_LABEL) as WorkOrderPriority[]).map((value) => ({
  value,
  label: PRIORITY_LABEL[value],
}));

export function MaintenancePage() {
  usePageTitle('Work orders');
  const workOrders = useWorkOrders();
  const properties = useProperties();
  const { can } = usePermissions();
  const canProperties = can('properties');
  const [createOpen, setCreateOpen] = useState(false);

  const propertyOptions = (properties.data ?? []).map((p) => ({
    value: p.id,
    label: p.nickname ?? p.addressLine1,
  }));

  const columns: DataTableColumn<WorkOrderListRow>[] = [
    {
      id: 'title',
      header: 'Work order',
      sortAccessor: (row) => row.title,
      searchAccessor: (row) => `${row.title} ${row.contractorName ?? ''}`,
      cell: (row) => (
        <Link
          to={`/maintenance/${row.id}`}
          className="font-medium text-ink transition-colors duration-fast hover:text-brand"
        >
          {row.title}
        </Link>
      ),
    },
    {
      id: 'property',
      header: 'Property',
      sortAccessor: (row) => row.propertyLabel,
      filter: { kind: 'select', single: true, accessor: (row) => row.propertyId, options: propertyOptions },
      cell: (row) => (
        <span>
          {row.propertyLabel}
          {row.unitLabel && <span className="text-ink-muted"> · {row.unitLabel}</span>}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortAccessor: (row) => row.status,
      filter: { kind: 'select', single: true, accessor: (row) => row.status, options: STATUS_OPTIONS },
      cell: (row) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</StatusBadge>
          {/* Overdue is never color alone — visible text alongside the badge. */}
          {row.overdue && <span className="text-xs font-medium text-danger">Overdue</span>}
        </div>
      ),
    },
    {
      id: 'priority',
      header: 'Priority',
      sortAccessor: (row) => row.priority,
      filter: { kind: 'select', single: true, accessor: (row) => row.priority, options: PRIORITY_OPTIONS },
      cell: (row) => (
        <span className={cx('text-sm', row.priority === 'emergency' ? 'font-semibold text-danger' : 'text-ink')}>
          {PRIORITY_LABEL[row.priority]}
        </span>
      ),
    },
    {
      id: 'contractor',
      header: 'Contractor',
      cell: (row) => row.contractorName ?? <span className="text-ink-muted">Unassigned</span>,
    },
    {
      id: 'schedule',
      header: 'Scheduled / due',
      sortAccessor: (row) => row.scheduledFor ?? row.dueBy ?? '',
      cell: (row) =>
        row.scheduledFor ? (
          formatCalendarDate(row.scheduledFor)
        ) : row.dueBy ? (
          <span>Due {formatCalendarDate(row.dueBy)}</span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      id: 'cost',
      header: 'Cost',
      align: 'right',
      sortAccessor: (row) => row.costCents,
      cell: (row) => formatUsdWhole(row.costCents),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Maintenance"
        description="Work orders across your portfolio — from the call to the invoice."
        breadcrumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Maintenance' }]}
        actions={
          canProperties ? (
            <Button onClick={() => setCreateOpen(true)}>
              <IconPlus size={16} />
              New work order
            </Button>
          ) : undefined
        }
      />

      <MaintenanceTabs />

      {workOrders.isPending ? (
        <Card flush className="p-4">
          <Skeleton className="h-64 w-full" />
        </Card>
      ) : workOrders.isError ? (
        <ErrorNotice error={workOrders.error} onRetry={() => void workOrders.refetch()} />
      ) : workOrders.data.length === 0 ? (
        <Card flush>
          <EmptyState
            icon={<IconWrench size={28} />}
            title="No work orders yet"
            body="Track a repair from the first call to the final invoice — the linked expense is where the cost comes from."
            action={
              canProperties ? (
                <Button onClick={() => setCreateOpen(true)}>
                  <IconPlus size={16} />
                  New work order
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card flush>
          <DataTable
            caption="Work orders — property, status, priority, contractor, schedule, and derived cost"
            columns={columns}
            data={workOrders.data}
            rowKey={(row) => row.id}
            searchPlaceholder="Search work orders"
            pageSize={20}
            itemNoun={{ one: 'work order', other: 'work orders' }}
          />
        </Card>
      )}

      <WorkOrderFormModal mode="create" open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
