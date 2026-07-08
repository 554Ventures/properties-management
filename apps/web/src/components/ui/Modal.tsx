import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/cx';
import { IconX } from './icons';
import { useFocusTrap } from './useFocusTrap';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const sizeClasses = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' };

export function Modal({ open, onClose, title, children, footer, size = 'md' }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(open, panelRef, onClose);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex w-[100dvw] items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-black/40 transition-opacity duration-fast"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          'relative flex max-h-[85vh] w-full flex-col rounded-lg border border-border bg-surface shadow-overlay',
          sizeClasses[size],
        )}
      >
        <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
          <h2 id={titleId} className="text-base font-semibold text-ink">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-md p-1.5 text-ink-muted transition-colors duration-fast hover:bg-surface-sunken hover:text-ink"
          >
            <IconX />
          </button>
        </header>
        <div className="overflow-y-auto px-6 py-4">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-3 border-t border-border px-6 py-4">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
