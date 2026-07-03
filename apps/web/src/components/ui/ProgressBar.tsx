import { cx } from '../../lib/cx';

export interface ProgressBarProps {
  /** Current value (e.g. paid units). */
  value: number;
  max: number;
  /** Accessible name, e.g. "Rent collected". */
  label: string;
  /** Visible text rendered beside the bar, e.g. "12 of 14 units". */
  text: string;
  className?: string;
}

export function ProgressBar({ value, max, label, text, className }: ProgressBarProps) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className={cx('flex items-center gap-2', className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuetext={text}
        className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken"
      >
        <div
          className="h-full rounded-full bg-positive transition-[width] duration-slow ease-ease"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="whitespace-nowrap text-xs text-ink-muted">{text}</span>
    </div>
  );
}
