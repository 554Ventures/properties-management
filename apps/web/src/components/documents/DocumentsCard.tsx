// Reusable "Documents" card for detail pages: lists the documents attached to
// (or derived onto) an entity, with upload and delete. `prependedDocs` carries
// the tenant's mock e-sign documents (external URLs) ahead of the uploaded set.
import { useState } from 'react';
import type { DocumentListQuery, DocumentListRow, TenantDocument } from '@hearth/shared';
import { downloadFile } from '../../api/client';
import { useDeleteDocument, useDocuments } from '../../api/queries';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Skeleton } from '../ui/Skeleton';
import { useToast } from '../ui/Toast';
import { IconTrash, IconUpload } from '../ui/icons';
import { formatBytes, formatDate } from '../../lib/format';
import { DOCUMENT_TYPE_LABELS, DocumentUploadModal, type DocumentUploadTarget } from './DocumentUploadModal';

export interface DocumentsCardProps {
  title?: string;
  filter: DocumentListQuery;
  uploadTarget: DocumentUploadTarget;
  /** E-sign documents (external links) rendered ahead of the uploaded set. */
  prependedDocs?: TenantDocument[];
  /** Render as a plain <section> (no Card chrome) for embedding in a modal. */
  embedded?: boolean;
  /** h3 when embedded under a modal's h2 title. Default 2. */
  headingLevel?: 2 | 3;
}

export function DocumentsCard({
  title = 'Documents',
  filter,
  uploadTarget,
  prependedDocs = [],
  embedded = false,
  headingLevel = 2,
}: DocumentsCardProps) {
  const documents = useDocuments(filter);
  const deleteDocument = useDeleteDocument();
  const { toast } = useToast();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleting, setDeleting] = useState<DocumentListRow | null>(null);

  const rows = documents.data?.documents ?? [];
  const empty = prependedDocs.length === 0 && rows.length === 0;

  // Fetch-based download: a plain anchor can't carry the bearer token and
  // would 401 in production (Supabase auth mode).
  const download = (doc: DocumentListRow) => {
    downloadFile(`/documents/${doc.id}/download`, doc.name).catch((err: unknown) =>
      toast(err instanceof Error ? err.message : 'Could not download the document.', 'danger'),
    );
  };

  const confirmDelete = () => {
    if (!deleting) return;
    deleteDocument.mutate({ id: deleting.id, entityType: deleting.entityType }, {
      onSuccess: () => {
        toast(`${deleting.name} deleted.`, 'positive');
        setDeleting(null);
      },
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not delete the document.', 'danger'),
    });
  };

  // Embedded (inside a modal, whose title is the h2): plain <section> + h3
  // instead of Card chrome; list/upload/download/delete are identical.
  const Wrapper = embedded ? 'section' : Card;
  const Heading = headingLevel === 3 ? 'h3' : 'h2';

  return (
    <Wrapper>
      <div className="mb-2 flex items-center justify-between gap-3">
        <Heading className="text-sm font-semibold text-ink">{title}</Heading>
        <Button variant="secondary" size="sm" onClick={() => setUploadOpen(true)}>
          <IconUpload size={14} />
          Upload
        </Button>
      </div>

      {documents.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : documents.isError ? (
        <p className="text-sm text-ink-muted">
          Could not load documents.{' '}
          <button
            type="button"
            onClick={() => void documents.refetch()}
            className="font-medium text-ink underline hover:text-brand"
          >
            Retry
          </button>
        </p>
      ) : empty ? (
        <p className="text-sm text-ink-muted">No documents on file.</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-sm">
          {prependedDocs.map((doc) => (
            <li key={doc.id} className="flex items-center gap-2">
              <a href={doc.url} className="min-w-0 truncate text-ink hover:text-brand">
                {doc.name}
              </a>
              <span className="shrink-0 rounded-sm border border-border px-1 text-xs text-ink-muted">
                e-sign
              </span>
              <span className="shrink-0 text-xs text-ink-muted">{formatDate(doc.createdAt)}</span>
            </li>
          ))}
          {rows.map((doc) => (
            <li key={doc.id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => download(doc)}
                className="min-w-0 truncate text-left text-ink hover:text-brand"
              >
                {doc.name}
                <span className="sr-only"> (download)</span>
              </button>
              <span className="min-w-0 shrink-0 text-xs text-ink-muted">
                {DOCUMENT_TYPE_LABELS[doc.type]} · {formatDate(doc.createdAt)} ·{' '}
                {formatBytes(doc.sizeBytes)}
              </span>
              <button
                type="button"
                onClick={() => setDeleting(doc)}
                className="ml-auto shrink-0 rounded-md p-1 text-ink-muted transition-colors duration-fast hover:bg-surface-sunken hover:text-danger"
              >
                <IconTrash size={14} />
                <span className="sr-only">Delete {doc.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <DocumentUploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        target={uploadTarget}
      />
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
    </Wrapper>
  );
}
