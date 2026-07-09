// Upload a document (POST /documents, multipart). Used with a fixed attach
// target from a detail page, or — when no target is passed — with an "Attach
// to" picker (property or tenant) on the central Documents page. The dropzone
// mirrors the receipt-scan pattern on AddTransaction.
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { DocumentTypeSchema } from '@hearth/shared';
import type { DocumentEntityType, DocumentType } from '@hearth/shared';
import { useProperties, useTenants, useUploadDocument } from '../../api/queries';
import { Button } from '../ui/Button';
import { FormField, Input } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { useToast } from '../ui/Toast';
import { IconUpload } from '../ui/icons';
import { cx } from '../../lib/cx';
import { formatBytes } from '../../lib/format';

/** Readable labels for the shared DocumentType enum. */
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  lease: 'Lease',
  insurance: 'Insurance',
  receipt: 'Receipt',
  inspection: 'Inspection',
  notice: 'Notice',
  tax: 'Tax',
  other: 'Other',
};

// Client-side hint only — the server enforces its own allowlist and size cap.
const ACCEPT = '.pdf,image/*,.docx';
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface DocumentUploadTarget {
  entityType: DocumentEntityType;
  entityId: string;
}

export interface DocumentUploadModalProps {
  open: boolean;
  onClose: () => void;
  /** Fixed attach target. When omitted, the modal shows an "Attach to" picker. */
  target?: DocumentUploadTarget;
}

export function DocumentUploadModal({ open, onClose, target }: DocumentUploadModalProps) {
  const upload = useUploadDocument();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState<DocumentType>('other');
  const [name, setName] = useState('');
  const [dragging, setDragging] = useState(false);
  const [errors, setErrors] = useState<{ file?: string; target?: string }>({});

  // Target picker state (only used when no fixed target is passed).
  const pickerMode = !target;
  const [targetKind, setTargetKind] = useState<'property' | 'tenant'>('property');
  const [targetId, setTargetId] = useState('');
  const properties = useProperties();
  const tenants = useTenants();

  useEffect(() => {
    if (open) {
      setFile(null);
      setType('other');
      setName('');
      setDragging(false);
      setErrors({});
      setTargetKind('property');
      setTargetId('');
    }
  }, [open]);

  const handleFile = (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size > MAX_SIZE_BYTES) {
      setFile(null);
      setErrors((prev) => ({
        ...prev,
        file: `That file is ${formatBytes(picked.size)} — the limit is 10 MB.`,
      }));
      return;
    }
    setFile(picked);
    setName((prev) => prev || picked.name);
    setErrors((prev) => ({ ...prev, file: undefined }));
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    handleFile(event.dataTransfer.files?.[0]);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: typeof errors = {};
    if (!file) nextErrors.file = 'Choose a file to upload.';
    if (pickerMode && !targetId) {
      nextErrors.target = `Choose the ${targetKind} this document belongs to.`;
    }
    setErrors(nextErrors);
    if (!file || nextErrors.target) return;

    const entityType: DocumentEntityType = target ? target.entityType : targetKind;
    const entityId = target ? target.entityId : targetId;

    // Text fields must precede the file part — the server reads the fields off
    // the first file part, so anything appended after the file is not seen.
    const form = new FormData();
    form.append('entityType', entityType);
    form.append('entityId', entityId);
    form.append('type', type);
    if (name.trim() && name.trim() !== file.name) form.append('name', name.trim());
    form.append('file', file);

    upload.mutate(form, {
      onSuccess: (doc) => {
        toast(`${doc.name} uploaded.`, 'positive');
        onClose();
      },
      onError: (err) =>
        toast(err instanceof Error ? err.message : 'Could not upload the document.', 'danger'),
    });
  };

  const fileDescribedBy =
    [errors.file ? 'doc-file-error' : undefined, 'doc-file-hint'].filter(Boolean).join(' ') ||
    undefined;

  return (
    <Modal open={open} onClose={onClose} title="Upload document">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="doc-file" className="text-sm font-medium text-ink">
            File
            <span aria-hidden="true" className="text-danger">
              {' '}
              *
            </span>
          </label>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cx(
              'flex flex-col items-center gap-2 rounded-md border-2 border-dashed px-6 py-6 text-center transition-colors duration-fast',
              dragging ? 'border-brand bg-brand-soft' : 'border-border-strong',
            )}
          >
            <span aria-hidden="true" className="text-ink-faint">
              <IconUpload size={24} />
            </span>
            {file ? (
              <p className="text-sm text-ink">
                {file.name} <span className="text-ink-muted">({formatBytes(file.size)})</span>
              </p>
            ) : (
              <p className="text-sm text-ink-muted">Drag a file here, or choose one below.</p>
            )}
            <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
              {file ? 'Choose a different file' : 'Choose a file'}
            </Button>
            <input
              ref={fileInputRef}
              id="doc-file"
              type="file"
              accept={ACCEPT}
              className="sr-only"
              aria-describedby={fileDescribedBy}
              aria-invalid={errors.file ? true : undefined}
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
          </div>
          <p id="doc-file-hint" className="text-xs text-ink-muted">
            PDF, image, or Word (.docx) — up to 10 MB.
          </p>
          {errors.file && (
            <p id="doc-file-error" className="text-xs font-medium text-danger">
              {errors.file}
            </p>
          )}
        </div>

        {pickerMode && (
          <>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-ink">Attach to</legend>
              <div className="flex gap-4" role="radiogroup" aria-label="Attach to">
                {(['property', 'tenant'] as const).map((kind) => (
                  <label key={kind} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                    <input
                      type="radio"
                      name="doc-target-kind"
                      value={kind}
                      checked={targetKind === kind}
                      onChange={() => {
                        setTargetKind(kind);
                        setTargetId('');
                      }}
                      className="h-4 w-4 border-border-strong text-brand"
                    />
                    <span>{kind === 'property' ? 'Property' : 'Tenant'}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <FormField
              label={targetKind === 'property' ? 'Property' : 'Tenant'}
              htmlFor="doc-target"
              error={errors.target}
              required
            >
              <Select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                <option value="">Choose a {targetKind}…</option>
                {targetKind === 'property'
                  ? (properties.data ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nickname ?? p.addressLine1}
                      </option>
                    ))
                  : (tenants.data ?? []).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.fullName}
                      </option>
                    ))}
              </Select>
            </FormField>
          </>
        )}

        <FormField label="Document type" htmlFor="doc-type" required>
          <Select value={type} onChange={(e) => setType(e.target.value as DocumentType)}>
            {DocumentTypeSchema.options.map((option) => (
              <option key={option} value={option}>
                {DOCUMENT_TYPE_LABELS[option]}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField label="Name" htmlFor="doc-name" hint="Optional — defaults to the file name.">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={upload.isPending}>
            Upload
          </Button>
        </div>
      </form>
    </Modal>
  );
}
