// Single-select filter-chip group used above tables (e.g. rent/status filters).
// Each chip is a toggle button; aria-pressed reflects whether its own value is
// the group's current selection, giving screen readers on/off semantics
// without a roving-tabindex pattern — chips stay in natural tab order.
import { cx } from '../../lib/cx';

export interface FilterChipOption<T extends string = string> {
  value: T;
  label: string;
  count: number;
}

export interface FilterChipsProps<T extends string = string> {
  /** Accessible name for the group, e.g. "Filter by status". */
  label: string;
  options: FilterChipOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

export function FilterChips<T extends string = string>({
  label,
  options,
  value,
  onChange,
}: FilterChipsProps<T>): JSX.Element {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cx(
              'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors duration-fast',
              selected
                ? 'border-border-strong bg-surface-sunken text-ink'
                : 'border-border text-ink-muted hover:text-ink',
            )}
          >
            {`${option.label} (${option.count})`}
          </button>
        );
      })}
    </div>
  );
}
