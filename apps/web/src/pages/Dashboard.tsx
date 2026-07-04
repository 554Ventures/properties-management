// Dashboard — PRD §5.1 "Classic KPI overview": greeting, 4 KPI tiles,
// 6-month income-vs-expense chart, exactly one AI insight card, activity feed.
import { formatUsd, formatUsdWhole } from '@hearth/shared';
import { Link } from 'react-router-dom';
import {
  useActivity,
  useCashflowSeries,
  useDashboardInsight,
  useDashboardKpis,
  useProperties,
} from '../api/queries';
import { InsightCard } from '../components/ai/InsightCard';
import { BarChart } from '../components/charts/BarChart';
import { ChartContainer } from '../components/charts/ChartContainer';
import { PageHeader } from '../components/shell/PageHeader';
import { buttonClasses } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { KpiTile, KpiTileSkeleton } from '../components/ui/KpiTile';
import { LiveRegion } from '../components/ui/LiveRegion';
import { ProgressBar } from '../components/ui/ProgressBar';
import { Skeleton } from '../components/ui/Skeleton';
import {
  IconBell,
  IconCheck,
  IconDollar,
  IconFileText,
  IconPlus,
  IconSparkle,
} from '../components/ui/icons';
import { formatDate, formatMonth, trendText } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const activityIcons = {
  transaction: IconDollar,
  rent_payment: IconCheck,
  reminder: IconBell,
  report: IconFileText,
  insight: IconSparkle,
} as const;

export function Dashboard() {
  usePageTitle('Dashboard');
  const kpis = useDashboardKpis();
  const series = useCashflowSeries(6);
  const activity = useActivity(10);
  const insight = useDashboardInsight();
  const properties = useProperties();

  const monthLabel = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const propertyCount = properties.data?.length;
  const unitCount = properties.data?.reduce((sum, p) => sum + p.unitCount, 0);
  const portfolioSummary =
    propertyCount !== undefined
      ? `${monthLabel} · ${propertyCount} ${propertyCount === 1 ? 'property' : 'properties'} · ${unitCount} units`
      : monthLabel;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={greeting()}
        description={portfolioSummary}
        actions={
          <Link to="/money/new" className={buttonClasses('primary')}>
            <IconPlus size={16} />
            Add transaction
          </Link>
        }
      />

      <section aria-label="Key metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.isPending ? (
          <>
            <KpiTileSkeleton />
            <KpiTileSkeleton />
            <KpiTileSkeleton />
            <KpiTileSkeleton />
          </>
        ) : kpis.isError ? (
          <div className="sm:col-span-2 xl:col-span-4">
            <ErrorNotice error={kpis.error} onRetry={() => void kpis.refetch()} />
          </div>
        ) : (
          <>
            <KpiTile
              label="Net cash flow (MTD)"
              value={formatUsdWhole(kpis.data.netCashFlowMtdCents)}
              ariaLabel={`Net cash flow, ${formatUsd(kpis.data.netCashFlowMtdCents)}, ${trendText(kpis.data.netCashFlowTrendPct)} versus last month`}
              trend={{ pct: kpis.data.netCashFlowTrendPct }}
            />
            <KpiTile
              label="Rent collected"
              value={`${Math.round(kpis.data.rentCollectedPct)}%`}
              ariaLabel={`Rent collected, ${Math.round(kpis.data.rentCollectedPct)} percent, ${kpis.data.paidUnits} of ${kpis.data.totalUnits} units paid`}
            >
              <ProgressBar
                value={kpis.data.paidUnits}
                max={kpis.data.totalUnits}
                label="Rent collected"
                text={`${kpis.data.paidUnits} of ${kpis.data.totalUnits} units`}
              />
            </KpiTile>
            <KpiTile
              label="Expenses (MTD)"
              value={formatUsdWhole(kpis.data.expensesMtdCents)}
              ariaLabel={`Expenses, ${formatUsd(kpis.data.expensesMtdCents)}, ${trendText(kpis.data.expensesTrendPct)} versus last month`}
              trend={{ pct: kpis.data.expensesTrendPct, goodWhenUp: false }}
            />
            <KpiTile
              label="Tax set-aside"
              value={formatUsdWhole(kpis.data.taxSetAside.currentCents)}
              ariaLabel={`Estimated tax set-aside, ${formatUsd(kpis.data.taxSetAside.currentCents)} of a ${formatUsd(kpis.data.taxSetAside.targetCents)} quarterly target. Estimate, not tax advice.`}
            >
              <p className="text-xs text-ink-muted">
                of {formatUsdWhole(kpis.data.taxSetAside.targetCents)} quarterly target
                <span className="mt-0.5 block text-ink-faint">Estimate — not tax advice</span>
              </p>
            </KpiTile>
          </>
        )}
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {series.isPending ? (
            <Card>
              <Skeleton className="mb-4 h-5 w-48" />
              <Skeleton className="h-[260px] w-full" />
            </Card>
          ) : series.isError ? (
            <ErrorNotice error={series.error} onRetry={() => void series.refetch()} />
          ) : (
            <ChartContainer
              title="Income vs. expenses — last 6 months"
              description={`Monthly income and expenses for the last ${series.data.length} months. ${series.data
                .map(
                  (p) =>
                    `${formatMonth(p.month)}: income ${formatUsdWhole(p.incomeCents)}, expenses ${formatUsdWhole(p.expenseCents)}`,
                )
                .join('; ')}.`}
              headingLevel={2}
              table={{
                columns: [
                  { key: 'month', label: 'Month' },
                  { key: 'income', label: 'Income', align: 'right', format: 'usd' },
                  { key: 'expense', label: 'Expenses', align: 'right', format: 'usd' },
                ],
                rows: series.data.map((p) => ({
                  month: formatMonth(p.month),
                  income: p.incomeCents,
                  expense: p.expenseCents,
                })),
              }}
            >
              <BarChart
                data={series.data.map((p) => ({
                  month: formatMonth(p.month),
                  income: p.incomeCents,
                  expense: p.expenseCents,
                }))}
                xKey="month"
                series={[
                  { key: 'income', label: 'Income', role: 'positive' },
                  { key: 'expense', label: 'Expenses', role: 'warning' },
                ]}
              />
            </ChartContainer>
          )}
        </div>

        <div className="flex flex-col gap-6">
          {/* Exactly one AI insight card on the dashboard (PRD §5.1). */}
          <LiveRegion>
            {insight.isPending ? (
              <Card>
                <Skeleton className="mb-2 h-4 w-12" />
                <Skeleton className="mb-2 h-5 w-40" />
                <Skeleton className="h-12 w-full" />
              </Card>
            ) : insight.data ? (
              <InsightCard insight={insight.data} />
            ) : (
              <Card>
                <h2 className="text-sm font-semibold text-ink">No new insights</h2>
                <p className="mt-1 text-sm text-ink-muted">
                  Nothing needs your attention right now. New observations appear here as Roost
                  notices them.
                </p>
              </Card>
            )}
          </LiveRegion>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-ink">Recent activity</h2>
            {activity.isPending ? (
              <div className="flex flex-col gap-3">
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            ) : activity.isError ? (
              <ErrorNotice error={activity.error} onRetry={() => void activity.refetch()} />
            ) : activity.data.length === 0 ? (
              <p className="text-sm text-ink-muted">No recent activity.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {activity.data.map((item) => {
                  const Icon = activityIcons[item.kind];
                  return (
                    <li key={item.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                      <span aria-hidden="true" className="mt-0.5 text-ink-faint">
                        <Icon size={14} />
                      </span>
                      <div className="min-w-0 flex-1">
                        {item.link ? (
                          <Link
                            to={item.link}
                            className="text-sm text-ink transition-colors duration-fast hover:text-brand"
                          >
                            {item.text}
                          </Link>
                        ) : (
                          <p className="text-sm text-ink">{item.text}</p>
                        )}
                        <p className="text-xs text-ink-muted">{formatDate(item.at)}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
