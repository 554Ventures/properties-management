// Compact per-row actions for tables. At md+ it renders the familiar inline
// text buttons; below md — where a sticky actions column can eat a third of
// the viewport — it collapses to a single icon-only button (one action) or a
// "⋯" button opening the focus-trapped BottomSheet (several actions).
import { useState, type ReactNode } from 'react';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { BottomSheet } from './BottomSheet';
import { Button, type ButtonVariant } from './Button';
import { IconDotsHorizontal } from './icons';

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
}

export function RowActions({ context, actions }: RowActionsProps) {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [open, setOpen] = useState(false);

  if (actions.length === 0) return null;

  if (isDesktop) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-1">
        {actions.map((action) => (
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
        <ul className="flex flex-col">
          {actions.map((action) => (
            <li key={action.label}>
              <button
                type="button"
                disabled={action.busy}
                className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm font-medium text-ink transition-colors duration-fast hover:bg-surface-sunken disabled:pointer-events-none disabled:opacity-50"
                onClick={() => {
                  setOpen(false);
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
      </BottomSheet>
    </>
  );
}
