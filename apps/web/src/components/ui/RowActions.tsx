// Compact per-row actions for tables. At md+ it renders the familiar inline
// text buttons; below md — where a sticky actions column can eat a third of
// the viewport — it collapses to a single icon-only button (one action) or a
// "⋯" button opening the focus-trapped BottomSheet (several actions).
// `collapseAfter` caps how many buttons stay inline at md+ — the rest move to
// a "⋯" overflow (a small focus-trapped popover). Below md the BottomSheet
// already holds every action, so the cap changes nothing there.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { BottomSheet } from './BottomSheet';
import { Button, buttonClasses, type ButtonVariant } from './Button';
import { IconDotsHorizontal } from './icons';
import { useFocusTrap } from './useFocusTrap';

export interface RowAction {
  /** Visible button text on desktop; the list-item label in the mobile sheet. */
  label: string;
  /** Icon shown with the label; also the icon-only face for a single action. */
  icon?: ReactNode;
  onClick: () => void;
  busy?: boolean;
  /** Desktop button variant (default ghost). */
  variant?: ButtonVariant;
}

export interface RowActionsProps {
  /** What the actions act on (e.g. the row's name) — used in accessible names
   * ("Actions for 12 Maple St") and as the mobile sheet's title. */
  context: string;
  actions: RowAction[];
  /** At md+, actions beyond this count collapse into a "⋯" overflow popover.
   * Default Infinity — every action stays inline, exactly as before. */
  collapseAfter?: number;
}

export function RowActions({ context, actions, collapseAfter = Infinity }: RowActionsProps) {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [open, setOpen] = useState(false);

  if (actions.length === 0) return null;

  if (isDesktop) {
    const visible = actions.slice(0, collapseAfter);
    const overflow = actions.slice(visible.length);
    return (
      <div className="flex flex-wrap items-center justify-end gap-1">
        {visible.map((action) => (
          <Button
            key={action.label}
            variant={action.variant ?? 'ghost'}
            size="sm"
            busy={action.busy}
            onClick={action.onClick}
          >
            {action.icon}
            {action.label}
            <span className="sr-only"> — {context}</span>
          </Button>
        ))}
        {overflow.length > 0 && <OverflowPopover context={context} actions={overflow} />}
      </div>
    );
  }

  // Mobile, one action with an icon: a single icon-only button beats a
  // two-tap menu.
  const single = actions.length === 1 ? actions[0] : undefined;
  if (single?.icon) {
    return (
      <Button
        variant={single.variant ?? 'ghost'}
        size="sm"
        busy={single.busy}
        aria-label={`${single.label} — ${context}`}
        onClick={single.onClick}
      >
        {single.icon}
      </Button>
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Actions for ${context}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <IconDotsHorizontal size={16} />
      </Button>
      <BottomSheet open={open} onClose={() => setOpen(false)} label={`Actions for ${context}`} title={context}>
        <ActionList actions={actions} onAction={() => setOpen(false)} />
      </BottomSheet>
    </>
  );
}

// The shared list-of-actions markup (mobile sheet + desktop overflow popover).
function ActionList({ actions, onAction }: { actions: RowAction[]; onAction: () => void }) {
  return (
    <ul className="flex flex-col">
      {actions.map((action) => (
        <li key={action.label}>
          <button
            type="button"
            disabled={action.busy}
            className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm font-medium text-ink transition-colors duration-fast hover:bg-surface-sunken disabled:pointer-events-none disabled:opacity-50"
            onClick={() => {
              onAction();
              action.onClick();
            }}
          >
            <span aria-hidden="true" className="text-ink-muted">
              {action.icon}
            </span>
            {action.busy ? 'Working…' : action.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

// --- Desktop overflow popover -----------------------------------------------
// A "⋯" trigger opening a small focus-trapped panel, portaled and right-aligned
// to the trigger, clamped inside the viewport (precedent: DataTable's
// FilterPopover). Escape/focus-restore come from the shared useFocusTrap.

const OVERFLOW_PANEL_WIDTH = 200;

function OverflowPopover({ context, actions }: { context: string; actions: RowAction[] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const left = Math.max(
        Math.min(r.right - OVERFLOW_PANEL_WIDTH, window.innerWidth - OVERFLOW_PANEL_WIDTH - 8),
        8,
      );
      setPos({ left, top: r.bottom + 4 });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  // The trap activates once the panel is mounted (pos set) so it can move
  // focus in; it handles Escape and restores focus to the trigger on close.
  useFocusTrap(open && pos !== null, panelRef, () => setOpen(false), { lockScroll: false });

  // Close on outside press (Escape is the trap's job).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  return (
    <>
      {/* Raw <button> + buttonClasses: Button doesn't forward the ref the
          positioning math needs. */}
      <button
        ref={triggerRef}
        type="button"
        className={buttonClasses('ghost', 'sm')}
        aria-label={`More actions for ${context}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <IconDotsHorizontal size={16} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label={`More actions for ${context}`}
            tabIndex={-1}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: OVERFLOW_PANEL_WIDTH }}
            className="z-[60] rounded-md border border-border bg-surface p-1 shadow-overlay"
          >
            <ActionList actions={actions} onAction={() => setOpen(false)} />
          </div>,
          document.body,
        )}
    </>
  );
}
