// Compact optional file picker for attaching the signed agreement inline in
// the lease create/renewal forms. Full document management (types, renames,
// deletes) stays in DocumentsCard/DocumentUploadModal — this is just the
// "hand over the PDF while you're here" affordance. Validation (size cap)
// lives in the parent, mirroring DocumentUploadModal's handleFile pattern.
import { useRef } from 'react';
import { formatBytes } from '../../lib/format';
import { Button } from '../ui/Button';
import { IconUpload, IconX } from '../ui/icons';

// Client-side hints only — the server enforces its own allowlist and cap.
export const AGREEMENT_ACCEPT = '.pdf,image/*,.docx';
export const AGREEMENT_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface AgreementFileFieldProps {
  /** Unique id for the hidden file input (label/error wiring). */
  id: string;
  file: File | null;
  error?: string;
  hint: string;
  onPick: (file: File | undefined) => void;
  onRemove: () => void;
}

export function AgreementFileField({
  id,
  file,
  error,
  hint,
  onPick,
  onRemove,
}: AgreementFileFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = `${id}-hint`;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        Signed agreement <span className="font-normal text-ink-muted">(optional)</span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => inputRef.current?.click()}>
          <IconUpload size={14} />
          {file ? 'Choose a different file' : 'Attach file'}
        </Button>
        {file && (
          <>
            <span className="text-sm text-ink">
              {file.name} <span className="text-ink-muted">({formatBytes(file.size)})</span>
            </span>
            <Button variant="ghost" size="sm" aria-label="Remove attached file" onClick={onRemove}>
              <IconX size={14} />
            </Button>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={AGREEMENT_ACCEPT}
        className="sr-only"
        aria-describedby={[errorId, hintId].filter(Boolean).join(' ')}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onPick(e.target.files?.[0])}
      />
      <p id={hintId} className="text-xs text-ink-muted">
        {hint}
      </p>
      {error && (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
