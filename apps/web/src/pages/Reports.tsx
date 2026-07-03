// Reports & Tax (PRD §5.6): library of the 13 report types with tax-year and
// property filters, per-type Generate, recent generated reports, and the
// "Ask AI to build a custom report" entry (AiSurface card).
import { useState } from 'react';
import type { ReportTypeInfo } from '@hearth/shared';
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
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { StatusBadge } from '../components/ui/StatusBadge';
import { useToast } from '../components/ui/Toast';
import { formatDate } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';

export function Reports() {
  usePageTitle('Reports & Tax');
  const navigate = useNavigate();
  const { toast } = useToast();
  const library = useReportsLibrary();
  const recent = useReports();
  const properties = useProperties();
  const generate = useGenerateReport();

  const thisYear = new Date().getFullYear();
  const [taxYear, setTaxYear] = useState(thisYear);
  const [propertyId, setPropertyId] = useState('');
  const [pendingType, setPendingType] = useState<string | null>(null);

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

      <Card className="p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:max-w-xl">
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
      </Card>

      {/* TODO(chat-drawer, build-order task 9): open the assistant drawer with
          report-building context instead of navigating with ?chat=open. */}
      <AiSurface>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Ask AI to build a custom report</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Describe what you need — “rents by unit for 88 Oak Ave last quarter” — and the
              assistant assembles it from your ledger.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => navigate('/?chat=open')}>
            Open assistant
          </Button>
        </div>
      </AiSurface>

      <section aria-label="Report library" className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-ink">Report library</h2>
        {library.isPending ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Card key={i}>
                <Skeleton className="h-24 w-full" />
              </Card>
            ))}
          </div>
        ) : library.isError ? (
          <ErrorNotice error={library.error} onRetry={() => void library.refetch()} />
        ) : (
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {library.data.map((info) => (
              <li key={info.type}>
                <Card className="flex h-full flex-col gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-semibold text-ink">{info.name}</h3>
                    {info.maturity === 'simplified' && (
                      <StatusBadge tone="neutral">Simplified</StatusBadge>
                    )}
                  </div>
                  <p className="flex-1 text-sm leading-relaxed text-ink-muted">{info.description}</p>
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      busy={generate.isPending && pendingType === info.type}
                      onClick={() => generateReport(info)}
                    >
                      Generate
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Recently generated reports" className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-ink">Recently generated</h2>
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
              Nothing generated yet — pick a report above to create your first one.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {recent.data.map((report) => (
                <li key={report.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <Link
                      to={`/reports/${report.id}`}
                      className="text-sm font-medium text-ink transition-colors duration-fast hover:text-brand"
                    >
                      {report.title}
                    </Link>
                    <p className="text-xs text-ink-muted">
                      Generated {formatDate(report.generatedAt)}
                      {report.taxYear != null && ` · tax year ${report.taxYear}`}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}
