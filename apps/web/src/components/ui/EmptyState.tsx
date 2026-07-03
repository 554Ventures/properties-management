import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
  className?: string;
}

/** Designed empty state — never a blank pane. */
export function EmptyState({ icon, title, body, action, className }: EmptyStateProps) {
  return (
    <div className={cx('flex flex-col items-center gap-2 px-6 py-12 text-center', className)}>
      {icon && (
        <span aria-hidden="true" className="mb-1 text-ink-faint">
          {icon}
        </span>
      )}
      <p className="text-sm font-semibold text-ink">{title}</p>
      {body && <p className="max-w-sm text-sm text-ink-muted">{body}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
