// Semantic table primitives: <table>/<caption>/<th scope="col">, wrapped in an
// overflow-x container so wide financial tables scroll instead of breaking.
import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';

export interface TableProps {
  /** Required accessible caption (visually hidden by default). */
  caption: string;
  captionVisible?: boolean;
  children: ReactNode;
  className?: string;
}

export function Table({ caption, captionVisible = false, children, className }: TableProps) {
  return (
    <div className="overflow-x-auto">
      <table className={cx('w-full border-collapse text-sm', className)}>
        <caption
          className={captionVisible ? 'p-4 text-left text-sm font-semibold text-ink' : 'sr-only'}
        >
          {caption}
        </caption>
        {children}
      </table>
    </div>
  );
}

type Align = 'left' | 'right';

export interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  align?: Align;
  /** Pins the column to the right edge of the scroll area — for a trailing
   * actions column so it stays reachable without scrolling through every
   * other column on narrow viewports. */
  stickyRight?: boolean;
}

export function Th({
  align = 'left',
  stickyRight = false,
  className,
  children,
  scope = 'col',
  ...rest
}: ThProps) {
  return (
    <th
      scope={scope}
      className={cx(
        'border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-ink-muted',
        align === 'right' ? 'text-right' : 'text-left',
        stickyRight && 'sticky right-0 bg-surface shadow-[-8px_0_8px_-8px_rgb(27_23_20_/_0.08)]',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  align?: Align;
  /** See Th.stickyRight — keep the two in sync on the same column. */
  stickyRight?: boolean;
}

export function Td({ align = 'left', stickyRight = false, className, children, ...rest }: TdProps) {
  return (
    <td
      className={cx(
        'px-4 py-3 align-top text-ink',
        align === 'right' ? 'text-right tabular-nums' : 'text-left',
        stickyRight && 'sticky right-0 bg-surface shadow-[-8px_0_8px_-8px_rgb(27_23_20_/_0.08)]',
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

export interface TrProps extends HTMLAttributes<HTMLTableRowElement> {
  hover?: boolean;
}

export function Tr({ hover = false, className, children, ...rest }: TrProps) {
  return (
    <tr
      className={cx(
        'border-b border-border last:border-b-0',
        hover && 'transition-colors duration-fast hover:bg-surface-sunken',
        className,
      )}
      {...rest}
    >
      {children}
    </tr>
  );
}
