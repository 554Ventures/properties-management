// Tenant detail (PRD §5.3): contact card, lease terms, payment history, and
// the "Draft renewal" flow (proposal modal + mock e-sign send).
import { useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type { RenewalDraftResponse, TenantLease } from '@hearth/shared';
import { useParams } from 'react-router-dom';
import { useDraftRenewal, useSendEsign, useTenantDetail } from '../api/queries';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { Modal } from '../components/ui/Modal';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge, type BadgeTone } from '../components/ui/StatusBadge';
import { Table, Td, Th, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { formatDate, formatMonth } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';

const leaseStatusBadge: Record<string, { tone: BadgeTone; label: string }> = {
  active: { tone: 'positive', label: 'Active' },
  pending_signature: { tone: 'warning', label: 'Pending signature' },
  ended: { tone: 'neutral', label: 'Ended' },
};

const rentStatusBadge: Record<string, { tone: BadgeTone; label: string }> = {
  paid: { tone: 'positive', label: 'Paid' },
  due: { tone: 'neutral', label: 'Due' },
  processing: { tone: 'neutral', label: 'Processing' },
  failed: { tone: 'danger', label: 'Failed' },
  late: { tone: 'danger', label: 'Late' },
};

export function TenantDetail() {
  const { id } = useParams<{ id: string }>();
  const detail = useTenantDetail(id);
  const title = detail.data?.tenant.fullName ?? 'Tenant';
  usePageTitle(title);

  const [draft, setDraft] = useState<RenewalDraftResponse | null>(null);
  const draftRenewal = useDraftRenewal();
  const sendEsign = useSendEsign();
  const { toast } = useToast();

  if (detail.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Tenant"
          breadcrumbs={[{ label: 'Tenants & Leases', to: '/tenants' }, { label: 'Detail' }]}
        />
        <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { tenant, leases, paymentHistory, documents } = detail.data;

  const startDraft = (lease: TenantLease) => {
    draftRenewal.mutate(lease.id, {
      onSuccess: (proposal) => setDraft(proposal),
      onError: () => toast('Could not draft a renewal. Try again.', 'danger'),
    });
  };

  const sendForSignature = () => {
    if (!draft) return;
    sendEsign.mutate(draft.leaseId, {
      onSuccess: (envelope) => {
        toast(`Renewal sent for e-signature (envelope ${envelope.envelopeId}).`, 'positive');
        setDraft(null);
      },
      onError: () => toast('Could not send for e-signature. Try again.', 'danger'),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={tenant.fullName}
        breadcrumbs={[{ label: 'Tenants & Leases', to: '/tenants' }, { label: tenant.fullName }]}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-ink">Contact</h2>
          <dl className="flex flex-col gap-2 text-sm">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">Email</dt>
              <dd>
                {tenant.email ? (
                  <a href={`mailto:${tenant.email}`} className="text-ink hover:text-brand">
                    {tenant.email}
                  </a>
                ) : (
                  <span className="text-ink-muted">Not on file</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">Phone</dt>
              <dd>
                {tenant.phone ? (
                  <a href={`tel:${tenant.phone}`} className="text-ink hover:text-brand">
                    {tenant.phone}
                  </a>
                ) : (
                  <span className="text-ink-muted">Not on file</span>
                )}
              </dd>
            </div>
            {tenant.notes && (
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">Notes</dt>
                <dd className="text-ink-muted">{tenant.notes}</dd>
              </div>
            )}
          </dl>
        </Card>

        <div className="flex flex-col gap-4 lg:col-span-2">
          {leases.length === 0 ? (
            <Card>
              <p className="text-sm text-ink-muted">No leases on file for this tenant.</p>
            </Card>
          ) : (
            leases.map((lease) => {
              const badge = leaseStatusBadge[lease.status] ?? leaseStatusBadge.ended;
              return (
                <Card key={lease.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold text-ink">
                        {lease.unitLabel} · {lease.propertyLabel}
                      </h2>
                      <p className="mt-1 text-sm text-ink-muted">
                        {formatUsd(lease.rentCents)}/mo · due day {lease.dueDay} ·{' '}
                        {formatDate(lease.startDate)} – {formatDate(lease.endDate)}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {badge && <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}
                        {lease.esignStatus && (
                          <StatusBadge tone={lease.esignStatus === 'signed' ? 'positive' : 'neutral'}>
                            E-sign: {lease.esignStatus}
                          </StatusBadge>
                        )}
                      </div>
                    </div>
                    {lease.status === 'active' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        busy={draftRenewal.isPending}
                        onClick={() => startDraft(lease)}
                      >
                        Draft renewal
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })
          )}

          <Card>
            <h2 className="mb-2 text-sm font-semibold text-ink">Documents</h2>
            {documents.length === 0 ? (
              <p className="text-sm text-ink-muted">No documents on file.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-sm">
                {documents.map((doc) => (
                  <li key={doc.id}>
                    <a href={doc.url} className="text-ink hover:text-brand">
                      {doc.name}
                    </a>
                    <span className="text-xs text-ink-muted"> · {formatDate(doc.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <section aria-label="Payment history" className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-ink">Payment history</h2>
        <Card flush>
          {paymentHistory.length === 0 ? (
            <p className="p-5 text-sm text-ink-muted">No rent payments recorded yet.</p>
          ) : (
            <Table caption={`${tenant.fullName} — rent payment history`}>
              <thead>
                <tr>
                  <Th>Period</Th>
                  <Th>Due date</Th>
                  <Th align="right">Amount</Th>
                  <Th>Status</Th>
                  <Th>Method</Th>
                  <Th>Paid</Th>
                </tr>
              </thead>
              <tbody>
                {paymentHistory.map((row) => {
                  const badge = rentStatusBadge[row.status] ?? rentStatusBadge.due;
                  return (
                    <Tr key={row.id}>
                      <Td>{formatMonth(row.period)}</Td>
                      <Td>{formatDate(row.dueDate)}</Td>
                      <Td align="right">{formatUsd(row.amountCents)}</Td>
                      <Td>
                        {badge && (
                          <StatusBadge tone={badge.tone}>
                            {row.status === 'late' && row.daysLate != null
                              ? `${row.daysLate} ${row.daysLate === 1 ? 'day' : 'days'} late`
                              : badge.label}
                          </StatusBadge>
                        )}
                      </Td>
                      <Td className="capitalize">{row.method ?? '—'}</Td>
                      <Td>{row.paidAt ? formatDate(row.paidAt) : '—'}</Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      </section>

      <Modal open={draft !== null} onClose={() => setDraft(null)} title="Renewal proposal">
        {draft && (
          <div className="flex flex-col gap-4">
            <Table caption="Proposed renewal terms">
              <tbody>
                <Tr>
                  <Th scope="row" className="normal-case tracking-normal">Current rent</Th>
                  <Td align="right">{formatUsd(draft.currentRentCents)}/mo</Td>
                </Tr>
                <Tr>
                  <Th scope="row" className="normal-case tracking-normal">Suggested rent</Th>
                  <Td align="right" className="font-semibold">
                    {formatUsd(draft.suggestedRentCents)}/mo
                  </Td>
                </Tr>
                {draft.marketRentCents != null && (
                  <Tr>
                    <Th scope="row" className="normal-case tracking-normal">Market rent</Th>
                    <Td align="right">{formatUsd(draft.marketRentCents)}/mo</Td>
                  </Tr>
                )}
                <Tr>
                  <Th scope="row" className="normal-case tracking-normal">Proposed term</Th>
                  <Td align="right">
                    {formatDate(draft.proposedStartDate)} – {formatDate(draft.proposedEndDate)}
                  </Td>
                </Tr>
                <Tr>
                  <Th scope="row" className="normal-case tracking-normal">Rent due day</Th>
                  <Td align="right">{draft.dueDay}</Td>
                </Tr>
              </tbody>
            </Table>
            <p className="text-xs text-ink-muted">
              Sending creates a Docusign envelope (mocked in this environment) — the tenant signs
              electronically and the lease status updates here.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button busy={sendEsign.isPending} onClick={sendForSignature}>
                Send for e-signature
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
