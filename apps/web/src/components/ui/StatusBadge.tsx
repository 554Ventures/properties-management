// Status is always icon + TEXT — color is reinforcement only (PRD §6/§7.1).
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconDot,
  IconSparkle,
} from './icons';

export type BadgeTone = 'positive' | 'warning' | 'danger' | 'neutral' | 'ai';

const toneClasses: Record<BadgeTone, string> = {
  positive: 'bg-positive-soft text-positive',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  neutral: 'bg-neutral-soft text-neutral',
  ai: 'bg-surface-ai text-ink-ai',
};

const toneIcons: Record<BadgeTone, (props: { size?: number }) => JSX.Element> = {
  positive: IconCheck,
  warning: IconAlertTriangle,
  danger: IconAlertCircle,
  neutral: IconDot,
  ai: IconSparkle,
};

export interface StatusBadgeProps {
  tone?: BadgeTone;
  /** Optional alternate icon (e.g. a clock for "processing"). */
  icon?: 'clock';
  children: ReactNode;
  className?: string;
}

export function StatusBadge({ tone = 'neutral', icon, children, className }: StatusBadgeProps) {
  const Icon = icon === 'clock' ? IconClock : toneIcons[tone];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium',
        toneClasses[tone],
        className,
      )}
    >
      <Icon size={12} />
      {children}
    </span>
  );
}
