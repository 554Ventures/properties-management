// Reports & Tax (PRD §5.6): library of the 13 report types with tax-year and
// property filters, per-type Generate, generated reports in a searchable/
// sortable/filterable table, and the "Ask AI to build a custom report" entry
// (AiSurface card).
import { useState } from 'react';
import type { Report, ReportTypeInfo } from '@hearth/shared';
import { Link, useNavigate } from 'react-router-dom';
import {
  useGenerateReport,
  useProperties,
  useReports,
  useReportsLibrary,
} from '../api/queries';
import { AiSurface } from '../components/ai/AiSurface';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { DataTable, type DataTableColumn } from '../components/ui/DataTable';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge } from '../components/ui/StatusBadge';
import { useToast } from '../components/ui/Toast';
import { formatDate, humanizeKey } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';
import { useChat } from '../state/chat';

export function Reports() {
  usePageTitle('Reports & Tax');
  const navigate = useNavigate();
  const { openWithContext } = useChat();
  const { toast } = useToast();
  const library = useReportsLibrary();
  const recent = useReports();
  const properties = useProperties();
  const generate = useGenerateReport();

  const thisYear = new Date().getFullYear();
  const [taxYear, setTaxYear] = useState(thisYear);
  const [propertyId, setPropertyId] = useState('');
  const [pendingType, setPendingType] = useState<string | null>(null);

  // Friendly labels for the generated-reports table; both lists are already
  // fetched for the library/filters above.
  const typeName = new Map((library.data ?? []).map((info) => [info.type as string, info.name]));
  const propertyLabel = new Map(
    (properties.data ?? []).map((p) => [p.id, p.nickname ?? p.addressLine1]),
  );
  const reportType = (report: Report) => typeName.get(report.type) ?? humanizeKey(report.type);
  const reportScope = (report: Report) =>
    report.propertyId ? (propertyLabel.get(report.propertyId) ?? 'One property') : 'Whole portfolio';

  const reportColumns: DataTableColumn<Report>[] = [
    {
      id: 'report',
      header: 'Report',
      sortAccessor: (report) => report.title,
      filter: { kind: 'text', accessor: (report) => report.title },
      searchAccessor: (report) => `${report.title} ${reportType(report)} ${reportScope(report)}`,
      cell: (report) => (
        <Link
          to={`/reports/${report.id}`}
          className="font-medium text-ink transition-colors duration-fast hover:text-brand"
        >
          {report.title}
        </Link>
      ),
    },
    {
      id: 'type',
      header: 'Type',
      sortAccessor: reportType,
      filter: { kind: 'select', accessor: reportType },
      cell: reportType,
    },
    {
      id: 'period',
      header: 'Period',
      sortAccessor: (report) => report.periodStart,
      cell: (report) => (
        <>
          {formatDate(report.periodStart)}
          <span className="text-ink-muted"> – {formatDate(report.periodEnd)}</span>
        </>
      ),
    },
    {
      id: 'taxYear',
      header: 'Tax year',
      sortAccessor: (report) => report.taxYear,
      filter: {
        kind: 'select',
        accessor: (report) => (report.taxYear != null ? String(report.taxYear) : ''),
      },
      cell: (report) => (report.taxYear != null ? String(report.taxYear) : '—'),
    },
    {
      id: 'scope',
      header: 'Scope',
      sortAccessor: reportScope,
      filter: { kind: 'select', accessor: reportScope },
      cell: reportScope,
    },
    {
      id: 'generated',
      header: 'Generated',
      sortAccessor: (report) => report.generatedAt,
      cell: (report) => formatDate(report.generatedAt),
    },
  ];

  const generateReport = (info: ReportTypeInfo) => {
    setPendingType(info.type);
    generate.mutate(
      {
        type: info.type,
        taxYear: info.supportedFilters.includes('taxYear') ? taxYear : undefined,
        propertyId:
          info.supportedFilters.includes('property') && propertyId ? propertyId : undefined,
      },
      {
        onSuccess: (report) => {
          setPendingType(null);
          toast(`${report.title} generated.`, 'positive');
          navigate(`/reports/${report.id}`);
        },
        onError: () => {
          setPendingType(null);
          toast('Could not generate the report. Try again.', 'danger');
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reports & Tax"
        description="Every report is generated from your confirmed ledger and snapshotted, so a filed year never silently changes."
        breadcrumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Reports & Tax' }]}
      />

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        {/* Main column: the reports you've generated. */}
        <section aria-label="Generated reports" className="flex flex-col gap-3 lg:col-span-2">
          <h2 className="text-base font-semibold text-ink">Generated reports</h2>
          <Card flush>
            {recent.isPending ? (
              <div className="p-5">
                <Skeleton className="h-24 w-full" />
              </div>
            ) : recent.isError ? (
              <div className="p-5">
                <ErrorNotice error={recent.error} onRetry={() => void recent.refetch()} />
              </div>
            ) : recent.data.length === 0 ? (
              <p className="p-5 text-sm text-ink-muted">
                Nothing generated yet — pick a report from the library to create your first one.
              </p>
            ) : (
              <DataTable
                caption="Generated reports — type, period, scope, and generation date"
                columns={reportColumns}
                data={recent.data}
                rowKey={(report) => report.id}
                searchPlaceholder="Search reports"
                pageSize={10}
                itemNoun={{ one: 'report', other: 'reports' }}
              />
            )}
          </Card>
        </section>

        {/* Side column: generate new reports (library + filters), then the AI entry. */}
        <div className="flex flex-col gap-6">
          <section aria-label="Report library" className="flex flex-col gap-3">
            <h2 className="text-base font-semibold text-ink">Report library</h2>
            <Card flush>
              <div className="grid grid-cols-1 gap-3 border-b border-border p-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="report-tax-year" className="text-xs font-medium text-ink-muted">
                    Tax year
                  </label>
                  <Select
                    id="report-tax-year"
                    value={taxYear}
                    onChange={(e) => setTaxYear(Number(e.target.value))}
                  >
                    {[thisYear, thisYear - 1, thisYear - 2].map((year) => (
                      <option key={year} value={year}>
                        {year}
                        {year === thisYear ? ' (year to date)' : ''}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="report-property" className="text-xs font-medium text-ink-muted">
                    Property
                  </label>
                  <Select
                    id="report-property"
                    value={propertyId}
                    onChange={(e) => setPropertyId(e.target.value)}
                  >
                    <option value="">Whole portfolio</option>
                    {(properties.data ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nickname ?? p.addressLine1}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              {library.isPending ? (
                <div className="p-4">
                  <Skeleton className="h-40 w-full" />
                </div>
              ) : library.isError ? (
                <div className="p-4">
                  <ErrorNotice error={library.error} onRetry={() => void library.refetch()} />
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {library.data.map((info) => (
                    <li key={info.type} className="flex items-start justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-semibold text-ink">{info.name}</h3>
                          {info.maturity === 'simplified' && (
                            <StatusBadge tone="neutral">Simplified</StatusBadge>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                          {info.description}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        busy={generate.isPending && pendingType === info.type}
                        onClick={() => generateReport(info)}
                      >
                        Generate
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>

          <AiSurface>
            <div className="flex flex-col gap-3">
              <div>
                <h2 className="text-sm font-semibold text-ink">Ask AI to build a custom report</h2>
                <p className="mt-1 text-sm text-ink-muted">
                  Describe what you need — “rents by unit for 88 Oak Ave last quarter” — and the
                  assistant assembles it from your ledger.
                </p>
              </div>
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => openWithContext({ screen: 'reports' })}
                >
                  Open assistant
                </Button>
              </div>
            </div>
          </AiSurface>
        </div>
      </div>
    </div>
  );
}
