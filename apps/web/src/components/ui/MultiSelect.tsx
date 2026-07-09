// Reusable typeahead multi-select combobox (WAI-ARIA 1.2 combobox + listbox
// pattern). Selected items render as removable chips inside the control; typing
// filters the option list; the popup is portaled to <body> and positioned
// against the control so it is never clipped by a modal's scroll container.
//
// A11y: the text input is role="combobox" with aria-expanded / aria-controls /
// aria-activedescendant; options are role="option" with aria-selected; the label
// is a real <label htmlFor> tied to the input; hint/error wire via
// aria-describedby. Status is never conveyed by color alone — the selected state
// shows a check icon plus aria-selected.
//
// Keyboard: ↓/↑ open + move the active option, Enter toggles it, Backspace on an
// empty query removes the last chip. (Escape is handled by the surrounding
// modal's focus trap, which closes the dialog — matching the app's other
// in-modal inputs.)
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/cx';
import { IconCheck, IconChevronDown, IconX } from './icons';

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Optional secondary line shown under the label in the dropdown. */
  description?: string;
}

export interface MultiSelectProps {
  label: string;
  options: MultiSelectOption[];
  /** Selected option values. */
  value: string[];
  onChange: (value: string[]) => void;
  /** Base id; the input becomes `${id}-input`. Auto-generated when omitted. */
  id?: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  loading?: boolean;
  /** Shown in the dropdown when the (filtered) option list is empty. */
  emptyMessage?: string;
}

export function MultiSelect({
  label,
  options,
  value,
  onChange,
  id,
  placeholder,
  hint,
  error,
  required,
  disabled,
  loading,
  emptyMessage = 'No matches.',
}: MultiSelectProps) {
  const reactId = useId();
  const baseId = id ?? reactId;
  const inputId = `${baseId}-input`;
  const listboxId = `${baseId}-listbox`;
  const hintId = hint ? `${baseId}-hint` : undefined;
  const errorId = error ? `${baseId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const controlRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const selected = value.map((v) => byValue.get(v) ?? { value: v, label: v });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  // Reset the active option whenever the visible list changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  // Position the portaled popup under the control, tracking scroll/resize.
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const r = controlRef.current?.getBoundingClientRect();
      if (r) setPos({ left: r.left, top: r.bottom + 4, width: r.width });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  // Close on any pointer press outside the control and the (portaled) popup.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (controlRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, open]);

  const toggle = (optionValue: string) => {
    onChange(
      value.includes(optionValue)
        ? value.filter((v) => v !== optionValue)
        : [...value, optionValue],
    );
    setQuery('');
    inputRef.current?.focus();
  };

  const removeLast = () => {
    if (value.length > 0) onChange(value.slice(0, -1));
  };

  const optionId = (index: number) => `${listboxId}-opt-${index}`;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!open) setOpen(true);
        else setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (!open) setOpen(true);
        else setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter': {
        const active = open ? filtered[activeIndex] : undefined;
        if (active) {
          // Toggle the option — and never let Enter submit the surrounding form.
          event.preventDefault();
          toggle(active.value);
        }
        break;
      }
      case 'Backspace':
        if (query === '') removeLast();
        break;
      default:
        break;
    }
  };

  const activeDescendant = open && filtered[activeIndex] ? optionId(activeIndex) : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-ink">
        {label}
        {required && (
          <span aria-hidden="true" className="text-danger">
            {' '}
            *
          </span>
        )}
      </label>

      <div
        ref={controlRef}
        onClick={() => {
          if (disabled) return;
          setOpen(true);
          inputRef.current?.focus();
        }}
        className={cx(
          'flex flex-wrap items-center gap-1.5 rounded-md border bg-surface px-2 py-1.5 text-sm transition-colors duration-fast',
          error ? 'border-danger' : 'border-border-strong hover:border-ink-muted',
          disabled && 'opacity-50',
        )}
      >
        {selected.map((option) => (
          <span
            key={option.value}
            className="inline-flex items-center gap-1 rounded bg-surface-sunken px-2 py-0.5 text-xs text-ink"
          >
            {option.label}
            {!disabled && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((v) => v !== option.value));
                  inputRef.current?.focus();
                }}
                aria-label={`Remove ${option.label}`}
                className="rounded-sm text-ink-muted transition-colors duration-fast hover:text-ink"
              >
                <IconX size={12} />
              </button>
            )}
          </span>
        ))}

        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeDescendant}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          disabled={disabled}
          value={query}
          placeholder={selected.length === 0 ? placeholder : undefined}
          onInput={(e) => {
            setQuery((e.target as HTMLInputElement).value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="min-w-[6rem] flex-1 bg-transparent py-0.5 text-ink outline-none placeholder:text-ink-faint"
        />

        <span aria-hidden="true" className="text-ink-muted">
          <IconChevronDown size={16} />
        </span>
      </div>

      {hint && (
        <p id={hintId} className="text-xs text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs font-medium text-danger" role="alert">
          {error}
        </p>
      )}

      {open &&
        pos &&
        createPortal(
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-multiselectable="true"
            aria-label={label}
            style={{ position: 'fixed', left: pos.left, top: pos.top, width: pos.width }}
            className="z-[60] max-h-56 overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-overlay"
          >
            {loading ? (
              <li className="px-3 py-2 text-sm text-ink-muted" role="presentation">
                Loading…
              </li>
            ) : filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-ink-muted" role="presentation">
                {emptyMessage}
              </li>
            ) : (
              filtered.map((option, index) => {
                const isSelected = value.includes(option.value);
                const isActive = index === activeIndex;
                return (
                  <li
                    key={option.value}
                    id={optionId(index)}
                    role="option"
                    aria-selected={isSelected}
                    data-index={index}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => toggle(option.value)}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={cx(
                      'flex cursor-pointer items-start gap-2 px-3 py-2 text-sm text-ink',
                      isActive && 'bg-surface-sunken',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cx(
                        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border',
                        isSelected
                          ? 'border-brand bg-brand text-ink-on-brand'
                          : 'border-border-strong',
                      )}
                    >
                      {isSelected && <IconCheck size={12} />}
                    </span>
                    <span className="flex flex-col">
                      <span>{option.label}</span>
                      {option.description && (
                        <span className="text-xs text-ink-muted">{option.description}</span>
                      )}
                    </span>
                  </li>
                );
              })
            )}
          </ul>,
          document.body,
        )}
    </div>
  );
}
