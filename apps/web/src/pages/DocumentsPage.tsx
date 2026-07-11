// Central documents library: every uploaded file across the portfolio with
// server-side property/tenant/type filters (so derived context — a lease doc
// showing under its property — matches GET /documents), client-side name
// search/sort via DataTable, and upload with an attach-to picker.
import { useMemo, useState } from 'react';
import { DocumentTypeSchema } from '@hearth/shared';
import type { DocumentListQuery, DocumentListRow, DocumentType } from '@hearth/shared';
import { Link } from 'react-router-dom';
import { downloadFile } from '../api/client';
import { useDeleteDocument, useDocuments, useProperties, useTenants } from '../api/queries';
import {
  DOCUMENT_TYPE_LABELS,
  DocumentUploadModal,
} from '../components/documents/DocumentUploadModal';
import { PageHeader } from '../components/shell/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { DataTable, type DataTableColumn } from '../components/ui/DataTable';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorNotice } from '../components/ui/ErrorNotice';
import { FormField } from '../components/ui/FormField';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';
import { RowActions } from '../components/ui/RowActions';
import { IconDownload, IconFileText, IconTrash, IconUpload } from '../components/ui/icons';
import { formatBytes, formatDate } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';

export function DocumentsPage() {
  usePageTitle('Documents');
  const { toast } = useToast();

  // Property/tenant/type go through the server query so derivation applies
  // (e.g. a lease document shows when its property is selected). Name search
  // stays client-side via the DataTable search box.
  const [propertyId, setPropertyId] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [type, setType] = useState('');

  const query: DocumentListQuery = useMemo(
    () => ({
      propertyId: propertyId || undefined,
      tenantId: tenantId || undefined,
      type: (type || undefined) as DocumentType | undefined,
    }),
    [propertyId, tenantId, type],
  );

  const documents = useDocuments(query);
  const properties = useProperties();
  const tenants = useTenants();
  const deleteDocument = useDeleteDocument();

  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleting, setDeleting] = useState<DocumentListRow | null>(null);

  const filtered = Boolean(propertyId || tenantId || type);
  const rows = documents.data?.documents ?? [];

  // Fetch-based download: a plain anchor can't carry the bearer token and
  // would 401 in production (Supabase auth mode).
  const download = (d: DocumentListRow) => {
    downloadFile(`/documents/${d.id}/download`, d.name).catch((err: unknown) =>
      toast(err instanceof Error ? err.message : 'Could not download the document.', 'danger'),
    );
  };

  const columns: DataTableColumn<DocumentListRow>[] = [
    {
      id: 'name',
      header: 'Name',
      sortAccessor: (d) => d.name,
      searchAccessor: (d) => d.name,
      cell: (d) => (
        <button
          type="button"
          onClick={() => download(d)}
          className="text-left font-medium text-ink transition-colors duration-fast hover:text-brand"
        >
          {d.name}
          <span className="sr-only"> (download)</span>
        </button>
      ),
    },
    {
      id: 'type',
      header: 'Type',
      sortAccessor: (d) => DOCUMENT_TYPE_LABELS[d.type],
      cell: (d) => DOCUMENT_TYPE_LABELS[d.type],
    },
    {
      id: 'linked',
      header: 'Linked to',
      sortAccessor: (d) => d.entityLabel,
      searchAccessor: (d) => d.entityLabel,
      cell: (d) => {
        const to =
          d.entityType === 'tenant' && d.tenantId
            ? `/tenants/${d.tenantId}`
            : d.propertyId
              ? `/properties/${d.propertyId}`
              : null;
        return to ? (
          <Link to={to} className="text-ink transition-colors duration-fast hover:text-brand">
            {d.entityLabel}
          </Link>
        ) : (
          d.entityLabel
        );
      },
    },
    {
      id: 'size',
      header: 'Size',
      align: 'right',
      sortAccessor: (d) => d.sizeBytes,
      cell: (d) => formatBytes(d.sizeBytes),
    },
    {
      id: 'uploaded',
      header: 'Uploaded',
      sortAccessor: (d) => d.createdAt,
      cellClassName: 'whitespace-nowrap',
      cell: (d) => formatDate(d.createdAt),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      stickyRight: true,
      cell: (d) => (
        <RowActions
          context={d.name}
          actions={[
            { label: 'Download', icon: <IconDownload size={14} />, onClick: () => download(d) },
            { label: 'Delete', icon: <IconTrash size={14} />, onClick: () => setDeleting(d) },
          ]}
        />
      ),
    },
  ];

  const confirmDelete = () => {
    if (!deleting) return;
    deleteDocument.mutate(deleting.id, {
      onSuccess: () => {
        toast(`${deleting.name} deleted.`, 'positive');
        setDeleting(null);
      },
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not delete the document.', 'danger'),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Documents"
        breadcrumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Documents' }]}
        actions={
          <Button onClick={() => setUploadOpen(true)}>
            <IconUpload size={16} />
            Upload document
          </Button>
        }
      />

      <div className="flex flex-wrap gap-4">
        <FormField label="Property" htmlFor="doc-filter-property" className="w-56">
          <Select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
            <option value="">All properties</option>
            {(properties.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.nickname ?? p.addressLine1}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Tenant" htmlFor="doc-filter-tenant" className="w-56">
          <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            <option value="">All tenants</option>
            {(tenants.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.fullName}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Type" htmlFor="doc-filter-type" className="w-44">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            {DocumentTypeSchema.options.map((option) => (
              <option key={option} value={option}>
                {DOCUMENT_TYPE_LABELS[option]}
              </option>
            ))}
          </Select>
        </FormField>
      </div>

      {documents.isPending ? (
        <Card flush className="p-4">
          <Skeleton className="h-64 w-full" />
        </Card>
      ) : documents.isError ? (
        <ErrorNotice error={documents.error} onRetry={() => void documents.refetch()} />
      ) : rows.length === 0 && !filtered ? (
        <Card flush>
          <EmptyState
            icon={<IconFileText size={28} />}
            title="No documents yet"
            body="Upload leases, receipts, insurance policies, and notices to keep everything in one place."
            action={
              <Button onClick={() => setUploadOpen(true)}>
                <IconUpload size={16} />
                Upload document
              </Button>
            }
          />
        </Card>
      ) : (
        <Card flush>
          <DataTable
            caption="Documents — name, type, linked entity, size, and upload date"
            columns={columns}
            data={rows}
            rowKey={(d) => d.id}
            searchPlaceholder="Search documents"
            pageSize={20}
            itemNoun={{ one: 'document', other: 'documents' }}
            emptyState="No documents match these filters."
          />
        </Card>
      )}

      <DocumentUploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title="Delete document"
        confirmLabel="Delete"
        busy={deleteDocument.isPending}
        body={
          <>
            This permanently deletes <strong>{deleting?.name}</strong>. It can’t be restored.
          </>
        }
      />
    </div>
  );
}
