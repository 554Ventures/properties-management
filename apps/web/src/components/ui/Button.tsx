import type { ButtonHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-brand text-ink-on-brand hover:bg-brand-strong border border-transparent shadow-card',
  secondary:
    'bg-surface text-ink border border-border-strong hover:bg-surface-sunken',
  ghost: 'bg-transparent text-ink-muted border border-transparent hover:bg-surface-sunken hover:text-ink',
  danger: 'bg-danger text-white border border-transparent hover:opacity-90',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1.5 text-xs gap-1',
  md: 'px-4 py-2 text-sm gap-2',
};

/** Shared classes — use for Links styled as buttons. */
export function buttonClasses(variant: ButtonVariant = 'primary', size: ButtonSize = 'md'): string {
  return cx(
    'inline-flex items-center justify-center rounded-md font-medium transition-colors duration-fast',
    'disabled:opacity-50 disabled:pointer-events-none',
    variantClasses[variant],
    sizeClasses[size],
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Disables the button and shows a busy label; pending mutations. */
  busy?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  busy = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(buttonClasses(variant, size), className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? 'Working…' : children}
    </button>
  );
}
