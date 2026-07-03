import type { HTMLAttributes } from 'react';
import { cx } from '../../lib/cx';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Remove default padding (e.g. when a table fills the card). */
  flush?: boolean;
}

export function Card({ flush = false, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cx(
        'rounded-lg border border-border bg-surface shadow-card',
        !flush && 'p-5',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
