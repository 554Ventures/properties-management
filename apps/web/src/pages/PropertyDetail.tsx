// Property detail: header, MTD/YTD P&L summary, per-unit list with lease and
// tenant status, property-scoped AI insight cards (PRD §5.2).
import { formatUsd, formatUsdWhole } from '@hearth/shared';
import { Link, useParams } from 'react-router-dom';
import { usePropertyDetail } from '../api/queries';
import { InsightCard } from '../components/ai/InsightCard';
import { PageHeader } from '../components/shell/PageHeader';
import { Card } from '../components/ui/Card';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { LiveRegion } from '../components/ui/LiveRegion';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Table, Td, Th, Tr } from '../components/ui/Table';
import { formatDate } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';

export function PropertyDetail() {
  const { id } = useParams<{ id: string }>();
  const detail = usePropertyDetail(id);
  const title = detail.data
    ? (detail.data.property.nickname ?? detail.data.property.addressLine1)
    : 'Property';
  usePageTitle(title);

  if (detail.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Property"
          breadcrumbs={[{ label: 'Properties', to: '/properties' }, { label: 'Detail' }]}
        />
        <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { property, units, pnl, insights } = detail.data;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={title}
        breadcrumbs={[{ label: 'Properties', to: '/properties' }, { label: title }]}
        description={
          <>
            {property.nickname ? `${property.addressLine1} · ` : ''}
            {property.city}, {property.state} {property.zip}
            {property.acquisitionDate && (
              <> · Acquired {formatDate(property.acquisitionDate)}
                {property.acquisitionCostCents != null &&
                  ` for ${formatUsdWhole(property.acquisitionCostCents)}`}
              </>
            )}
          </>
        }
      />

      <section aria-label="Profit and loss summary">
        <Card flush>
          <Table
            caption={`${title} — profit and loss, month to date and year to date`}
            captionVisible
            className="px-4"
          >
            <thead>
              <tr>
                <Th> </Th>
                <Th align="right">Month to date</Th>
                <Th align="right">Year to date</Th>
              </tr>
            </thead>
            <tbody>
              <Tr>
                <Th scope="row" className="normal-case tracking-normal">Income</Th>
                <Td align="right">{formatUsd(pnl.mtd.incomeCents)}</Td>
                <Td align="right">{formatUsd(pnl.ytd.incomeCents)}</Td>
              </Tr>
              <Tr>
                <Th scope="row" className="normal-case tracking-normal">Expenses</Th>
                <Td align="right">{formatUsd(pnl.mtd.expenseCents)}</Td>
                <Td align="right">{formatUsd(pnl.ytd.expenseCents)}</Td>
              </Tr>
              <Tr className="font-semibold">
                <Th scope="row" className="normal-case tracking-normal">Net</Th>
                <Td align="right">{formatUsd(pnl.mtd.netCents)}</Td>
                <Td align="right">{formatUsd(pnl.ytd.netCents)}</Td>
              </Tr>
            </tbody>
          </Table>
        </Card>
      </section>

      <section aria-label="Units" className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-ink">Units</h2>
        <Card flush>
          <Table caption={`${title} — units, tenants, rent, and lease status`}>
            <thead>
              <tr>
                <Th>Unit</Th>
                <Th>Tenant</Th>
                <Th align="right">Rent / mo</Th>
                <Th>Lease ends</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {units.map((unit) => {
                const lease = unit.currentLease;
                return (
                  <Tr key={unit.id}>
                    <Td className="font-medium">{unit.label}</Td>
                    <Td>
                      {lease && lease.tenants.length > 0 ? (
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
                    <Td align="right">{lease ? formatUsd(lease.rentCents) : '—'}</Td>
                    <Td>{lease ? formatDate(lease.endDate) : '—'}</Td>
                    <Td>
                      {unit.status === 'occupied' ? (
                        <StatusBadge tone="positive">Occupied</StatusBadge>
                      ) : (
                        <StatusBadge tone="warning">Vacant</StatusBadge>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      </section>

      <LiveRegion className="flex flex-col gap-4">
        {insights.map((insight) => (
          <InsightCard key={insight.id} insight={insight} />
        ))}
      </LiveRegion>
    </div>
  );
}
