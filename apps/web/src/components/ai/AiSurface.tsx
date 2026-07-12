// THE single wrapper marking AI-authored content (PRD §6, mandatory):
// --surface-ai background, --border-ai accent, "✦ AI" badge. InsightCard,
// AiChip, monthly-review content — and later, assistant chat bubbles — all
// render inside this component. Nothing AI-authored appears without it.
import type { ElementType, ReactNode } from 'react';
import { cx } from '../../lib/cx';

export function AiBadge({ className, label = 'AI' }: { className?: string; label?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-ink-ai',
        className,
      )}
    >
      <span aria-hidden="true">✦</span>
      {label}
    </span>
  );
}

export interface AiSurfaceProps {
  children: ReactNode;
  className?: string;
  /** Hide the standalone badge when the child renders its own AI labelling. */
  badge?: boolean;
  /** Badge text — 'AI' everywhere except chat, where the assistant is named. */
  badgeLabel?: string;
  /** Compact pill variant (AiChip). */
  inline?: boolean;
  as?: ElementType;
  [key: string]: unknown;
}

export function AiSurface({
  children,
  className,
  badge = true,
  badgeLabel,
  inline = false,
  as,
  ...rest
}: AiSurfaceProps) {
  const Tag: ElementType = as ?? (inline ? 'span' : 'div');
  if (inline) {
    return (
      <Tag
        className={cx(
          'ai-frame inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium text-ink-ai',
          className,
        )}
        {...rest}
      >
        {badge && <AiBadge label={badgeLabel} />}
        {children}
      </Tag>
    );
  }
  return (
    <Tag
      className={cx(
        // Thin gradient border all around (matching the inline AiChip pill and
        // the insight deck's stacked layers) + the thick gradient left accent.
        'ai-frame rounded-lg border border-l-4 p-4 shadow-card',
        className,
      )}
      {...rest}
    >
      {badge && <AiBadge className="mb-2" label={badgeLabel} />}
      {children}
    </Tag>
  );
}
