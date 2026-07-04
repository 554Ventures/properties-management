// The global assistant drawer (ARCHITECTURE §8, binding a11y notes):
// role="dialog" aria-label="Roost", focus trap, Esc closes and
// returns focus to the launcher. Full-screen below md; a ~420px right panel
// above. Below xl it overlays with a backdrop; at xl the page content shifts
// aside instead (AppShell adds right padding), so nothing is covered.
import { useRef } from 'react';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { useChat } from '../../state/chat';
import { IconAlertCircle, IconX } from '../ui/icons';
import { useFocusTrap } from '../ui/useFocusTrap';
import { ChatComposer } from './ChatComposer';
import { ChatTranscript } from './ChatTranscript';
import { ToolActivityIndicator } from './ToolActivityIndicator';

export function ChatDrawer() {
  const { open, close, clear, status, errorMessage, messages } = useChat();
  const panelRef = useRef<HTMLDivElement>(null);
  // At xl the drawer is docked and the page shifts aside (AppShell adds right
  // padding), so it's a non-modal panel: don't lock page scroll or trap Tab, and
  // don't claim aria-modal. Below xl it overlays with a backdrop — a real modal.
  const docked = useMediaQuery('(min-width: 1280px)');
  const modal = !docked;
  useFocusTrap(open, panelRef, close, { lockScroll: modal, trapTab: modal });

  if (!open) return null;

  return (
    <aside aria-label="Roost panel">
      {modal && (
        <div className="fixed inset-0 z-40 bg-black/40" onClick={close} aria-hidden="true" />
      )}
      {/* role="dialog" lives on an inner div — ARIA does not allow it on <aside>. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={modal}
        aria-label="Roost"
        tabIndex={-1}
        className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-border bg-surface shadow-overlay animate-drawer-enter md:w-[420px]"
      >
        <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
            <span aria-hidden="true" className="text-ink-ai">
              ✦
            </span>
            Roost
          </h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={clear}
              disabled={messages.length === 0}
              className="rounded-md px-2 py-1 text-xs font-medium text-ink-muted transition-colors duration-fast hover:bg-surface-sunken hover:text-ink disabled:pointer-events-none disabled:opacity-40"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={close}
              aria-label="Close assistant"
              className="rounded-md p-1.5 text-ink-muted transition-colors duration-fast hover:bg-surface-sunken hover:text-ink"
            >
              <IconX />
            </button>
          </div>
        </header>
        <ChatTranscript />
        <ToolActivityIndicator />
        {status === 'error' && errorMessage && (
          <div
            role="alert"
            className="mx-4 mb-2 flex items-center gap-2 rounded-md border border-border bg-danger-soft px-3 py-2 text-sm text-danger"
          >
            <IconAlertCircle size={14} className="shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}
        <ChatComposer />
      </div>
    </aside>
  );
}
