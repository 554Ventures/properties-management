// AI Insights (PRD §5.7): the auto-generated monthly review — bottom line,
// net-cash-flow trend, by-property breakdown, watch items — plus an archive
// of past reviews. All review content is AI-authored → rendered inside
// AiSurface. The dataJson shape is not part of the frozen contract
// (ReportDetailResponse.data is `unknown`), so rendering is defensive: known
// keys get rich treatment, everything else falls back to ReportData tables.
import { useMemo } from 'react';
import { formatUsdWhole } from '@hearth/shared';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  useGenerateMonthlyReview,
  useMonthlyReviewDetail,
  useMonthlyReviews,
} from '../api/queries';
import { AiBadge, AiSurface } from '../components/ai/AiSurface';
import { ChartContainer } from '../components/charts/ChartContainer';
import { LineChart } from '../components/charts/LineChart';
import { EmailAccountantButton, ExportLinks } from '../components/reports/ReportActions';
import { ReportData } from '../components/reports/ReportData';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { Skeleton } from '../components/ui/Skeleton';
import { IconSparkle } from '../components/ui/icons';
import { useToast } from '../components/ui/Toast';
import { cx } from '../lib/cx';
import { formatDate } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';

// ---- defensive extraction from the untyped monthly-review snapshot ---------

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Dict)
    : null;
}

function pickString(d: Dict, keys: string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const v = d[key];
    if (typeof v === 'string' && v.trim()) return { key, value: v };
  }
  return null;
}

function pickArray(d: Dict, keys: string[]): { key: string; value: unknown[] } | null {
  for (const key of keys) {
    const v = d[key];
    if (Array.isArray(v) && v.length > 0) return { key, value: v };
  }
  return null;
}

interface TrendPoint {
  x: string;
  y: number;
}

function toTrendPoints(items: unknown[]): TrendPoint[] | null {
  const points: TrendPoint[] = [];
  for (const item of items) {
    const d = asDict(item);
    if (!d) return null;
    const x = ['month', 'period', 'label', 'x'].map((k) => d[k]).find((v) => typeof v === 'string');
    const y = ['netCents', 'netCashFlowCents', 'valueCents', 'y', 'value', 'net']
      .map((k) => d[k])
      .find((v) => typeof v === 'number');
    if (typeof x !== 'string' || typeof y !== 'number') return null;
    points.push({ x, y });
  }
  return points.length > 1 ? points : null;
}

// ----------------------------------------------------------------------------

export function Insights() {
  usePageTitle('AI Insights');
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const reviews = useMonthlyReviews();
  const generateReview = useGenerateMonthlyReview();

  const sorted = useMemo(
    () =>
      [...(reviews.data ?? [])].sort(
        (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime(),
      ),
    [reviews.data],
  );
  const selectedId = reportId ?? sorted[0]?.id;
  const detail = useMonthlyReviewDetail(selectedId);

  const generateNow = () => {
    generateReview.mutate(undefined, {
      onSuccess: (report) => {
        toast('Monthly review generated.', 'positive');
        navigate(`/insights/${report.id}`);
      },
      onError: () => toast('Could not generate the review. Try again.', 'danger'),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="AI Insights"
        description="Hearth reviews your portfolio each month and writes up what it noticed — no prompting required."
        breadcrumbs={[{ label: 'Dashboard', to: '/' }, { label: 'AI Insights' }]}
        actions={
          // Dev/demo trigger for the scheduled monthly job.
          <Button variant="ghost" busy={generateReview.isPending} onClick={generateNow}>
            <IconSparkle size={14} />
            Generate now
          </Button>
        }
      />

      {reviews.isPending ? (
        <Card>
          <Skeleton className="h-72 w-full" />
        </Card>
      ) : reviews.isError ? (
        <ErrorNotice error={reviews.error} onRetry={() => void reviews.refetch()} />
      ) : sorted.length === 0 ? (
        <Card flush>
          <EmptyState
            icon={<IconSparkle size={28} />}
            title="No monthly reviews yet"
            body="The first review is generated automatically at the start of next month — or create one now."
            action={
              <Button busy={generateReview.isPending} onClick={generateNow}>
                Generate now
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
          <div className="flex flex-col gap-4 lg:col-span-3">
            {detail.isPending ? (
              <Card>
                <Skeleton className="h-72 w-full" />
              </Card>
            ) : detail.isError ? (
              <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} />
            ) : (
              <MonthlyReview
                title={detail.data.title}
                generatedAt={detail.data.generatedAt}
                reportId={detail.data.id}
                data={detail.data.data}
              />
            )}
          </div>

          <section aria-label="Past reviews">
            <h2 className="mb-3 text-sm font-semibold text-ink">Archive</h2>
            <ul className="flex flex-col gap-1">
              {sorted.map((report) => {
                const isCurrent = report.id === selectedId;
                return (
                  <li key={report.id}>
                    <Link
                      to={`/insights/${report.id}`}
                      aria-current={isCurrent ? 'page' : undefined}
                      className={cx(
                        'block rounded-md px-3 py-2 text-sm transition-colors duration-fast',
                        isCurrent
                          ? 'bg-surface-ai font-medium text-ink-ai'
                          : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
                      )}
                    >
                      {report.title}
                      <span className="block text-xs text-ink-faint">
                        {formatDate(report.generatedAt)}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

function MonthlyReview({
  title,
  generatedAt,
  reportId,
  data,
}: {
  title: string;
  generatedAt: string;
  reportId: string;
  data: unknown;
}) {
  const dict = asDict(data);
  const bottomLine = dict
    ? pickString(dict, ['bottomLine', 'bottom_line', 'summary', 'headline'])
    : null;
  const trendEntry = dict
    ? pickArray(dict, ['netCashflowSeries', 'netCashFlowSeries', 'cashflowSeries', 'trend', 'series'])
    : null;
  const trendPoints = trendEntry ? toTrendPoints(trendEntry.value) : null;
  const byPropertyEntry = dict
    ? pickArray(dict, ['byProperty', 'properties', 'propertyBreakdown', 'perProperty'])
    : null;
  const watchEntry = dict
    ? pickArray(dict, ['watchItems', 'watch_items', 'watchlist', 'watching'])
    : null;

  const handledKeys = new Set(
    [bottomLine?.key, trendEntry?.key, byPropertyEntry?.key, watchEntry?.key].filter(
      (k): k is string => Boolean(k),
    ),
  );
  const rest = dict
    ? Object.fromEntries(Object.entries(dict).filter(([key]) => !handledKeys.has(key)))
    : null;
  const hasRest = rest !== null && Object.keys(rest).length > 0;

  return (
    <AiSurface badge={false} className="p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <AiBadge className="mb-1" />
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          <p className="text-xs text-ink-muted">Generated {formatDate(generatedAt)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ExportLinks reportId={reportId} formats={['pdf']} />
          <EmailAccountantButton reportId={reportId} />
        </div>
      </div>

      <div className="flex flex-col gap-5">
        {bottomLine && (
          <Card>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Bottom line
            </h3>
            <p className="text-sm leading-relaxed text-ink">{bottomLine.value}</p>
          </Card>
        )}

        {trendPoints && (
          <ChartContainer
            title="Net cash flow trend"
            description={`Net cash flow by month: ${trendPoints
              .map((p) => `${p.x} ${formatUsdWhole(p.y)}`)
              .join('; ')}.`}
            headingLevel={3}
            height={220}
            table={{
              columns: [
                { key: 'x', label: 'Month' },
                { key: 'y', label: 'Net cash flow', align: 'right', format: 'usd' },
              ],
              rows: trendPoints.map((p) => ({ x: p.x, y: p.y })),
            }}
          >
            <LineChart
              data={trendPoints.map((p) => ({ x: p.x, y: p.y }))}
              xKey="x"
              series={[{ key: 'y', label: 'Net cash flow', role: 'ai' }]}
            />
          </ChartContainer>
        )}

        {byPropertyEntry && (
          <Card>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              By property
            </h3>
            <ReportData data={byPropertyEntry.value} caption="By property" level={4} />
          </Card>
        )}

        {watchEntry && (
          <Card>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Watch items
            </h3>
            <ul className="flex flex-col gap-3">
              {watchEntry.value.map((item, i) => {
                const d = asDict(item);
                const itemTitle = d ? pickString(d, ['title', 'name', 'label'])?.value : null;
                const itemBody = d
                  ? pickString(d, ['body', 'detail', 'description', 'text', 'recommendation'])?.value
                  : null;
                return (
                  <li key={i} className="flex gap-2 text-sm">
                    <span aria-hidden="true" className="mt-0.5 shrink-0 text-ink-ai">
                      <IconSparkle size={14} />
                    </span>
                    <div>
                      {typeof item === 'string' ? (
                        <p className="text-ink">{item}</p>
                      ) : (
                        <>
                          {itemTitle && <p className="font-medium text-ink">{itemTitle}</p>}
                          {itemBody && <p className="text-ink-muted">{itemBody}</p>}
                          {!itemTitle && !itemBody && (
                            <ReportData data={item} caption={`Watch item ${i + 1}`} level={4} />
                          )}
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        {/* Anything the snapshot contains beyond the known sections. */}
        {hasRest && (
          <Card>
            <ReportData data={rest} caption={title} level={3} />
          </Card>
        )}
        {!dict && (
          <Card>
            <ReportData data={data} caption={title} level={3} />
          </Card>
        )}
      </div>
    </AiSurface>
  );
}
