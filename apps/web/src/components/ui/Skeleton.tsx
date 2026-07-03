import { cx } from '../../lib/cx';

/**
 * Exact-dimension loading placeholder. Callers must size it (w-N / h-N) to
 * the final content's dimensions so data arrival causes no layout shift
 * (PRD §5.1).
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx('block animate-pulse rounded bg-surface-sunken', className)}
    />
  );
}
