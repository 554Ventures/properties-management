import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/cx';
import { IconX } from './icons';
import { useFocusTrap } from './useFocusTrap';

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog (e.g. "More menu"). */
  label: string;
  children: ReactNode;
  /** Optional visible header title. */
  title?: string;
}

/**
 * Mobile-only bottom sheet: a focus-trapped dialog that slides up from the
 * bottom, sitting above the tab bar. Built from the same primitives as Drawer
 * (portal + backdrop + useFocusTrap, which closes on Escape and returns focus
 * to the trigger). Hidden at md+ — it's a small-screen affordance.
 */
export function BottomSheet({ open, onClose, label, title, children }: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, panelRef, onClose);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 md:hidden">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cx(
          'fixed inset-x-0 bottom-0 flex max-h-[80vh] flex-col rounded-t-xl border-t border-border bg-surface shadow-overlay',
          'pb-[env(safe-area-inset-bottom)] animate-sheet-enter',
        )}
      >
        <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          {title ? <h2 className="text-base font-semibold text-ink">{title}</h2> : <span />}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="rounded-md p-1.5 text-ink-muted transition-colors duration-fast hover:bg-surface-sunken hover:text-ink"
          >
            <IconX />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-3 py-3">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
