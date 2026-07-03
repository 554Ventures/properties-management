import type { SelectHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        'w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-ink transition-colors duration-fast hover:border-ink-muted disabled:opacity-50',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}
