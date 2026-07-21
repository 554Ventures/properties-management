// Dashboard — PRD §5.1 "Classic KPI overview": greeting, 4 KPI tiles, the AI
// insight deck (every active insight as a stack of cards — supersedes §5.1's
// original single-card slot, 2026-07-11), 6-month income-vs-expense chart,
// activity feed.
import { ASSISTANT_NAME, formatUsd, formatUsdWhole } from '@hearth/shared';
import { Link } from 'react-router-dom';
import {
  useActivity,
  useCashflowSeries,
  useDashboardKpis,
  useExpenseBreakdown,
  useInsights,
  useNoiByProperty,
  useProperties,
} from '../api/queries';
import { InsightDeck } from '../components/ai/InsightDeck';
import { WeeklyBriefCard } from '../components/ai/WeeklyBriefCard';
import { OnboardingBanner } from '../components/onboarding/OnboardingBanner';
import { BarChart } from '../components/charts/BarChart';
import { ChartContainer } from '../components/charts/ChartContainer';
import { categoricalRole } from '../components/charts/chartTheme';
import { DonutChart } from '../components/charts/DonutChart';
import { HorizontalBarChart } from '../components/charts/HorizontalBarChart';
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
  const expenseBreakdown = useExpenseBreakdown();
  const noiByProperty = useNoiByProperty();
  // Per-property rows plus, when present, the portfolio-level "Unassigned"
  // bucket (transactions with no property — omitted by the API when zero).
  // Reconciles: sum(properties.noiCents) + unassigned.noiCents === the
  // dashboard's net-cash-flow KPI.
  const noiRows = noiByProperty.data
    ? [
        ...noiByProperty.data.properties.map((p) => ({
          label: p.label,
          income: p.incomeCents,
          expense: p.expenseCents,
          noi: p.noiCents,
          neutral: false,
        })),
        ...(noiByProperty.data.unassigned
          ? [
              {
                label: 'Unassigned',
                income: noiByProperty.data.unassigned.incomeCents,
                expense: noiByProperty.data.unassigned.expenseCents,
                noi: noiByProperty.data.unassigned.noiCents,
                neutral: true,
              },
            ]
          : []),
      ]
    : [];
  const activity = useActivity(10);
  const insights = useInsights({ status: 'active' });
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

      <OnboardingBanner />

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
        <div className="flex flex-col gap-6 lg:col-span-2">
          {/* The weekly AI brief (W1) — renders nothing until the first brief
              exists, so the column stays quiet on fresh accounts. */}
          <WeeklyBriefCard />

          {/* The AI insight deck — every active insight, sharing the charts'
              column width. Announced politely as cards surface. */}
          <LiveRegion>
            {insights.isPending ? (
              <Card>
                <Skeleton className="mb-2 h-4 w-12" />
                <Skeleton className="mb-2 h-5 w-40" />
                <Skeleton className="h-12 w-full" />
              </Card>
            ) : insights.isError ? null : insights.data.length === 0 ? (
              <Card>
                <h2 className="text-sm font-semibold text-ink">No new insights</h2>
                <p className="mt-1 text-sm text-ink-muted">
                  Nothing needs your attention right now. New observations appear here as{' '}
                  {ASSISTANT_NAME} notices them.
                </p>
              </Card>
            ) : (
              <InsightDeck insights={insights.data} />
            )}
          </LiveRegion>

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

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            {expenseBreakdown.isPending ? (
              <Card>
                <Skeleton className="mb-4 h-5 w-48" />
                <Skeleton className="h-[260px] w-full" />
              </Card>
            ) : expenseBreakdown.isError ? (
              <ErrorNotice
                error={expenseBreakdown.error}
                onRetry={() => void expenseBreakdown.refetch()}
              />
            ) : expenseBreakdown.data.slices.length === 0 ? (
              <Card>
                <h2 className="mb-1 text-sm font-semibold text-ink">Where expenses went</h2>
                <p className="text-sm text-ink-muted">No expenses recorded this month yet.</p>
              </Card>
            ) : (
              <ChartContainer
                title="Where expenses went — this month"
                description={`This month's ${formatUsdWhole(expenseBreakdown.data.totalCents)} in expenses by category. ${expenseBreakdown.data.slices
                  .map((s) => `${s.categoryName}: ${formatUsdWhole(s.amountCents)}`)
                  .join('; ')}.`}
                headingLevel={2}
                table={{
                  columns: [
                    { key: 'category', label: 'Category' },
                    { key: 'amount', label: 'Amount', align: 'right', format: 'usd' },
                  ],
                  rows: expenseBreakdown.data.slices.map((s) => ({
                    category: s.categoryName,
                    amount: s.amountCents,
                  })),
                }}
              >
                <DonutChart
                  data={expenseBreakdown.data.slices.map((s, i) => ({
                    name: s.categoryName,
                    value: s.amountCents,
                    // "Other" (folded bucket, null id) reads as the neutral slot.
                    role: s.categoryId === null ? 'neutral' : categoricalRole(i),
                  }))}
                />
              </ChartContainer>
            )}

            {noiByProperty.isPending ? (
              <Card>
                <Skeleton className="mb-4 h-5 w-48" />
                <Skeleton className="h-[260px] w-full" />
              </Card>
            ) : noiByProperty.isError ? (
              <ErrorNotice
                error={noiByProperty.error}
                onRetry={() => void noiByProperty.refetch()}
              />
            ) : noiByProperty.data.properties.length === 0 ? (
              <Card>
                <h2 className="mb-1 text-sm font-semibold text-ink">
                  Operating income by property
                </h2>
                <p className="text-sm text-ink-muted">
                  Add a property to see per-property performance.
                </p>
              </Card>
            ) : (
              <div className="flex flex-col gap-2">
                <ChartContainer
                  title="Operating income by property — this month"
                  description={`This month's operating income (rent collected minus directly-billed expenses) per property.${
                    noiByProperty.data.unassigned
                      ? ' Includes a separate Unassigned bucket for transactions not tied to one property.'
                      : ''
                  } ${noiRows.map((r) => `${r.label}: ${formatUsdWhole(r.noi)}`).join('; ')}.`}
                  headingLevel={2}
                  table={{
                    columns: [
                      { key: 'label', label: 'Property' },
                      { key: 'income', label: 'Income', align: 'right', format: 'usd' },
                      { key: 'expense', label: 'Expenses', align: 'right', format: 'usd' },
                      { key: 'noi', label: 'Net', align: 'right', format: 'usd' },
                    ],
                    rows: noiRows.map((r) => ({
                      label: r.label,
                      income: r.income,
                      expense: r.expense,
                      noi: r.noi,
                    })),
                  }}
                >
                  <HorizontalBarChart
                    data={noiRows.map((r) => ({
                      label: r.label,
                      value: r.noi,
                      neutral: r.neutral,
                    }))}
                    valueLabel="Net operating income"
                  />
                </ChartContainer>
                {noiByProperty.data.unassigned && (
                  <p className="px-1 text-xs text-ink-faint">
                    Includes unassigned transactions — totals match the dashboard KPIs.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-6">
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
