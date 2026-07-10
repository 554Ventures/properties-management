// Contractor detail (Maintenance): contact card, derived usage stats, and the
// job history matched from confirmed expense transactions (ARCHITECTURE §4).
import { useState } from 'react';
import { formatUsd, formatUsdWhole } from '@hearth/shared';
import { useNavigate, useParams } from 'react-router-dom';
import { useArchiveContractor, useContractor } from '../api/queries';
import { ContractorFormModal } from '../components/forms/ContractorFormModal';
import { LogJobModal } from '../components/forms/LogJobModal';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { KpiTile } from '../components/ui/KpiTile';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Table, Td, Th, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { IconStar, IconWrench } from '../components/ui/icons';
import { cx } from '../lib/cx';
import { formatDate, formatMonth } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';

/** Stored websites are free text ("riveraplumbing.com") — prefix a scheme for the href. */
function websiteHref(website: string): string {
  return website.startsWith('http://') || website.startsWith('https://')
    ? website
    : `https://${website}`;
}

export function ContractorDetail() {
  const { id } = useParams<{ id: string }>();
  const detail = useContractor(id);
  const title = detail.data?.contractor.name ?? 'Contractor';
  usePageTitle(title);

  const navigate = useNavigate();
  const archive = useArchiveContractor();
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [logJobOpen, setLogJobOpen] = useState(false);

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
          title="Contractor"
          breadcrumbs={[
            { label: 'Dashboard', to: '/' },
            { label: 'Maintenance', to: '/maintenance' },
            { label: 'Contractors', to: '/maintenance/contractors' },
            { label: 'Detail' },
          ]}
        />
        <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { contractor, jobsCount, avgCostCents, lastUsedAt, jobs } = detail.data;
  const lowSample = jobsCount < 3;

  const doDelete = () => {
    archive.mutate(contractor.id, {
      onSuccess: () => {
        toast(`${contractor.name} removed from your contractors.`, 'positive');
        setConfirmDelete(false);
        navigate('/maintenance/contractors');
      },
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not delete the contractor.', 'danger'),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={contractor.name}
        description={contractor.trade}
        breadcrumbs={[
          { label: 'Dashboard', to: '/' },
          { label: 'Maintenance', to: '/maintenance' },
          { label: 'Contractors', to: '/maintenance/contractors' },
          { label: contractor.name },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
              Edit
            </Button>
            {contractor.archivedAt ? (
              // Detail serves archived contractors too — state via icon + text,
              // never color alone, and no Delete action for an archived row.
              <StatusBadge tone="neutral">Archived</StatusBadge>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiTile label="Jobs" value={String(jobsCount)} ariaLabel={`Jobs, ${jobsCount}`} />
        <KpiTile
          label="Avg cost"
          value={avgCostCents != null ? formatUsdWhole(avgCostCents) : '—'}
          ariaLabel={
            avgCostCents != null
              ? `Average cost, ${formatUsdWhole(avgCostCents)}`
              : 'Average cost, none yet'
          }
        />
        <KpiTile
          label="Last used"
          value={lastUsedAt ? formatMonth(lastUsedAt.slice(0, 7)) : '—'}
          ariaLabel={
            lastUsedAt ? `Last used, ${formatMonth(lastUsedAt.slice(0, 7))}` : 'Last used, never'
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">Contact</h2>
          <dl className="flex flex-col gap-2 text-sm">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">Rating</dt>
              <dd>
                {contractor.rating != null ? (
                  // Fewer than 3 jobs → thin signal: muted styling plus visible
                  // "low sample" text (same rule as the list page).
                  <span
                    className={cx(
                      'inline-flex items-center gap-1',
                      lowSample ? 'text-ink-muted' : 'text-ink',
                    )}
                  >
                    <IconStar size={13} />
                    {contractor.rating.toFixed(1)}
                    {lowSample && <span className="text-xs">· low sample</span>}
                  </span>
                ) : (
                  <span className="text-ink-muted">—</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">Phone</dt>
              <dd>
                {contractor.phone ? (
                  <a href={`tel:${contractor.phone}`} className="text-ink hover:text-brand">
                    {contractor.phone}
                  </a>
                ) : (
                  <span className="text-ink-muted">Not on file</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">Email</dt>
              <dd>
                {contractor.email ? (
                  <a href={`mailto:${contractor.email}`} className="text-ink hover:text-brand">
                    {contractor.email}
                  </a>
                ) : (
                  <span className="text-ink-muted">Not on file</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                Website
              </dt>
              <dd>
                {contractor.website ? (
                  <a
                    href={websiteHref(contractor.website)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-ink hover:text-brand"
                  >
                    {contractor.website}
                  </a>
                ) : (
                  <span className="text-ink-muted">Not on file</span>
                )}
              </dd>
            </div>
            {contractor.notes && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Notes
                </dt>
                <dd className="text-ink-muted">{contractor.notes}</dd>
              </div>
            )}
          </dl>
        </Card>

        <section aria-label="Job history" className="flex flex-col gap-3 lg:col-span-2">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-base font-semibold text-ink">Job history</h2>
            <Button variant="secondary" size="sm" onClick={() => setLogJobOpen(true)}>
              <IconWrench size={14} />
              Log a job
            </Button>
          </div>
          <Card flush>
            {jobs.length === 0 ? (
              <p className="p-5 text-sm text-ink-muted">
                No jobs matched yet — job history and stats build automatically from confirmed
                expenses whose vendor matches this contractor&rsquo;s name.
              </p>
            ) : (
              <Table caption={`${contractor.name} — job history from matched expenses`}>
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Description</Th>
                    <Th>Property</Th>
                    <Th align="right">Amount</Th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <Tr key={job.id}>
                      <Td>{formatDate(job.date)}</Td>
                      <Td>{job.description}</Td>
                      <Td>{job.propertyLabel ?? '—'}</Td>
                      <Td align="right">{formatUsd(job.amountCents)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </section>
      </div>

      <ContractorFormModal
        mode="edit"
        open={editOpen}
        contractor={contractor}
        onClose={() => setEditOpen(false)}
      />
      <LogJobModal
        open={logJobOpen}
        onClose={() => setLogJobOpen(false)}
        contractorId={contractor.id}
        contractorName={contractor.name}
      />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={doDelete}
        title="Delete contractor"
        confirmLabel="Delete"
        busy={archive.isPending}
        body={
          <>
            This removes <strong>{contractor.name}</strong> from your directory. Their past jobs
            stay on your transaction history.
          </>
        }
      />
    </div>
  );
}
