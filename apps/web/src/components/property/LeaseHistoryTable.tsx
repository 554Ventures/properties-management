// A unit's full lease history — extracted from UnitDetail so the property
// page's lease-history modal renders the identical table. Callers provide the
// surrounding chrome (section/Card on UnitDetail, Modal on PropertyDetail).
import { formatUsd } from '@hearth/shared';
import type { LeaseWithTenants } from '@hearth/shared';
import { Link } from 'react-router-dom';
import { formatDate } from '../../lib/format';
import { leaseStatusBadge } from '../../lib/statusBadges';
import { StatusBadge } from '../ui/StatusBadge';
import { Table, Td, Th, Tr } from '../ui/Table';

export interface LeaseHistoryTableProps {
  leases: LeaseWithTenants[];
  unitLabel: string;
}

export function LeaseHistoryTable({ leases, unitLabel }: LeaseHistoryTableProps) {
  if (leases.length === 0) {
    return <p className="p-5 text-sm text-ink-muted">No leases on file for this unit.</p>;
  }

  return (
    <Table caption={`${unitLabel} — lease history`}>
      <thead>
        <tr>
          <Th>Tenant</Th>
          <Th align="right">Rent / mo</Th>
          <Th>Term</Th>
          <Th>Status</Th>
        </tr>
      </thead>
      <tbody>
        {leases.map((lease) => {
          const badge = leaseStatusBadge[lease.status] ?? leaseStatusBadge.ended;
          return (
            <Tr key={lease.id}>
              <Td>
                {lease.tenants.length > 0 ? (
                  lease.tenants.map((tenant, i) => (
                    <span key={tenant.id}>
                      {i > 0 && ', '}
                      <Link
                        to={`/tenants/${tenant.id}`}
                        className="text-ink transition-colors duration-fast hover:text-brand"
                      >
                        {tenant.fullName}
                      </Link>
                    </span>
                  ))
                ) : (
                  <span className="text-ink-muted">—</span>
                )}
              </Td>
              <Td align="right">{formatUsd(lease.rentCents)}</Td>
              <Td>
                {formatDate(lease.startDate)} – {formatDate(lease.endDate)}
              </Td>
              <Td>
                <div className="flex flex-wrap gap-2">
                  {badge && <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}
                  {lease.esignStatus && (
                    <StatusBadge tone={lease.esignStatus === 'signed' ? 'positive' : 'neutral'}>
                      E-sign: {lease.esignStatus}
                    </StatusBadge>
                  )}
                </div>
              </Td>
            </Tr>
          );
        })}
      </tbody>
    </Table>
  );
}
