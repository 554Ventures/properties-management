// Report viewer: title/period header, then a type-aware body that leads with
// headline figures and callouts before the detail table (ReportBody), CSV/PDF
// export, "Email accountant", and the persistent tax disclaimer on tax
// surfaces (PRD §7.3 / §13.4).
import { useParams } from 'react-router-dom';
import { useReportDetail } from '../api/queries';
import { AiSurface } from '../components/ai/AiSurface';
import { EmailAccountantButton, ExportLinks } from '../components/reports/ReportActions';
import { ReportBody } from '../components/reports/ReportBody';
import { PageHeader } from '../components/shell/PageHeader';
import { Card } from '../components/ui/Card';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { Skeleton } from '../components/ui/Skeleton';
import { formatDate } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';

const TAX_REPORT_TYPES = new Set(['schedule_e', 'tax_package']);

export function ReportViewer() {
  const { id } = useParams<{ id: string }>();
  const report = useReportDetail(id);
  usePageTitle(report.data?.title ?? 'Report');

  if (report.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-9 w-80" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (report.isError) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Report"
          breadcrumbs={[{ label: 'Reports & Tax', to: '/reports' }, { label: 'Report' }]}
        />
        <ErrorNotice error={report.error} onRetry={() => void report.refetch()} />
      </div>
    );
  }

  const data = report.data;
  const isTaxReport = TAX_REPORT_TYPES.has(data.type) || data.taxYear != null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={data.title}
        breadcrumbs={[{ label: 'Reports & Tax', to: '/reports' }, { label: data.title }]}
        description={
          <>
            {formatDate(data.periodStart)} – {formatDate(data.periodEnd)}
            {data.taxYear != null && ` · tax year ${data.taxYear}`}
            {' · generated '}
            {formatDate(data.generatedAt)}
          </>
        }
        actions={
          <>
            <ExportLinks reportId={data.id} />
            <EmailAccountantButton reportId={data.id} />
          </>
        }
      />

      {/* The monthly review is AI-authored (Roost writes it up), so it renders
          inside AiSurface; every other report is a deterministic ledger
          snapshot and stays unwrapped. */}
      {data.type === 'monthly_review' ? (
        <AiSurface className="p-5">
          <ReportBody type={data.type} data={data.data} title={data.title} />
        </AiSurface>
      ) : (
        <ReportBody type={data.type} data={data.data} title={data.title} />
      )}

      {isTaxReport && (
        <Card className="bg-surface-sunken">
          <p className="text-xs leading-relaxed text-ink-muted">
            <strong className="font-semibold text-ink">Not tax advice.</strong> 554 Properties
            organizes your records and computes estimates to help you prepare — it is not a certified tax
            preparation service. Confirm figures with a licensed tax professional before filing.
          </p>
        </Card>
      )}
    </div>
  );
}
