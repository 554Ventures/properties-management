// Contractor directory (Maintenance): the vendors a landlord trusts, with
// usage stats derived server-side from confirmed expense transactions.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatUsdWhole } from '@hearth/shared';
import { useArchiveContractor, useContractors, type ContractorListRow } from '../api/queries';
import { ContractorFormModal } from '../components/forms/ContractorFormModal';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { DataTable, type DataTableColumn } from '../components/ui/DataTable';
import { Skeleton } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';
import { IconPlus, IconStar, IconWrench } from '../components/ui/icons';
import { cx } from '../lib/cx';
import { formatMonth } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';

/** "Mario Rossi" → "MR" for the avatar circle (decorative; name renders beside it). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function ContractorsPage() {
  usePageTitle('Contractors');
  const contractors = useContractors();
  const archive = useArchiveContractor();
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ContractorListRow | null>(null);
  const [deleting, setDeleting] = useState<ContractorListRow | null>(null);

  const columns: DataTableColumn<ContractorListRow>[] = [
    {
      id: 'contractor',
      header: 'Contractor',
      sortAccessor: (row) => row.name,
      filter: { kind: 'text', accessor: (row) => row.name },
      searchAccessor: (row) => `${row.name} ${row.trade}`,
      cell: (row) => (
        <div className="flex items-center gap-3">
          <div
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand"
          >
            {initials(row.name)}
          </div>
          <Link
            to={`/maintenance/contractors/${row.id}`}
            className="font-medium text-ink transition-colors duration-fast hover:text-brand"
          >
            {row.name}
          </Link>
        </div>
      ),
    },
    {
      id: 'trade',
      header: 'Trade',
      sortAccessor: (row) => row.trade,
      filter: { kind: 'select', accessor: (row) => row.trade },
      cell: (row) => row.trade,
    },
    {
      id: 'rating',
      header: 'Rating',
      sortAccessor: (row) => row.rating,
      cell: (row) => {
        if (row.rating == null) return '—';
        // Fewer than 3 jobs → the rating is a thin signal: muted styling plus
        // visible "low sample" text (status is never conveyed by color alone).
        const lowSample = row.jobsCount < 3;
        return (
          <span
            className={cx('inline-flex items-center gap-1', lowSample ? 'text-ink-muted' : 'text-ink')}
          >
            <IconStar size={13} />
            {row.rating.toFixed(1)}
            {lowSample && <span className="text-xs">· low sample</span>}
          </span>
        );
      },
    },
    {
      id: 'jobs',
      header: 'Jobs',
      align: 'right',
      sortAccessor: (row) => row.jobsCount,
      cell: (row) => row.jobsCount,
    },
    {
      id: 'avgCost',
      header: 'Avg cost',
      align: 'right',
      sortAccessor: (row) => row.avgCostCents,
      filter: {
        kind: 'number',
        accessor: (row) => (row.avgCostCents != null ? row.avgCostCents / 100 : null),
        unit: '$',
      },
      cell: (row) => (row.avgCostCents != null ? formatUsdWhole(row.avgCostCents) : '—'),
    },
    {
      id: 'lastUsed',
      header: 'Last used',
      sortAccessor: (row) => row.lastUsedAt ?? '',
      // ISO datetime → "Jun 2026" via the existing period formatter.
      cell: (row) => (row.lastUsedAt ? formatMonth(row.lastUsedAt.slice(0, 7)) : '—'),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      stickyRight: true,
      cell: (row) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => setEditing(row)}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDeleting(row)}>
            Delete
          </Button>
        </div>
      ),
    },
  ];

  const confirmDelete = () => {
    if (!deleting) return;
    archive.mutate(deleting.id, {
      onSuccess: () => {
        toast(`${deleting.name} removed from your contractors.`, 'positive');
        setDeleting(null);
      },
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not delete the contractor.', 'danger'),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Your contractors"
        description={contractors.data ? `${contractors.data.length} saved` : undefined}
        breadcrumbs={[
          { label: 'Dashboard', to: '/' },
          { label: 'Maintenance', to: '/maintenance' },
          { label: 'Contractors' },
        ]}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <IconPlus size={16} />
            Add contractor
          </Button>
        }
      />

      {contractors.isPending ? (
        <Card flush className="p-4">
          <Skeleton className="h-64 w-full" />
        </Card>
      ) : contractors.isError ? (
        <ErrorNotice error={contractors.error} onRetry={() => void contractors.refetch()} />
      ) : contractors.data.length === 0 ? (
        <Card flush>
          <EmptyState
            icon={<IconWrench size={28} />}
            title="No contractors yet"
            body="Save the plumbers, painters, and handymen you trust — their job history and costs build up automatically from your expenses."
            action={
              <Button onClick={() => setCreateOpen(true)}>
                <IconPlus size={16} />
                Add contractor
              </Button>
            }
          />
        </Card>
      ) : (
        <Card flush>
          <DataTable
            caption="Contractors — trade, rating, jobs, average cost, and last used"
            columns={columns}
            data={contractors.data}
            rowKey={(row) => row.id}
            searchPlaceholder="Search contractors"
            pageSize={20}
            itemNoun={{ one: 'contractor', other: 'contractors' }}
          />
        </Card>
      )}

      <ContractorFormModal mode="create" open={createOpen} onClose={() => setCreateOpen(false)} />
      <ContractorFormModal
        mode="edit"
        open={editing !== null}
        contractor={editing ?? undefined}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title="Delete contractor"
        confirmLabel="Delete"
        busy={archive.isPending}
        body={
          <>
            This removes <strong>{deleting?.name}</strong> from your directory. Their past jobs stay
            on your transaction history.
          </>
        }
      />
    </div>
  );
}
