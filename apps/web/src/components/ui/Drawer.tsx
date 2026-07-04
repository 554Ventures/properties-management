import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/cx';
import { IconX } from './icons';
import { useFocusTrap } from './useFocusTrap';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog (e.g. "Roost"). */
  label: string;
  children: ReactNode;
  /** Optional visible header title; omit for custom headers. */
  title?: string;
}

/**
 * Right-side slide-over panel (full-screen below md). Used later by the chat
 * drawer (build-order task 9) — kept generic here.
 */
export function Drawer({ open, onClose, label, title, children }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, panelRef, onClose);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cx(
          'fixed inset-y-0 right-0 flex w-full flex-col border-l border-border bg-surface shadow-overlay md:max-w-md',
          'animate-page-enter',
        )}
      >
        <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          {title ? <h2 className="text-base font-semibold text-ink">{title}</h2> : <span />}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="rounded-md p-1.5 text-ink-muted transition-colors duration-fast hover:bg-surface-sunken hover:text-ink"
          >
            <IconX />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
