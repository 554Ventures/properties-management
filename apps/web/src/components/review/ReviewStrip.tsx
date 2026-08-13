// Full-bleed warning/state strip across the top of a review-queue card. The
// review card is a triage row (~72px); anything the user has to *read* before
// deciding — low confidence, a possible duplicate, a detected mortgage
// payment, a rent match — gets the whole card width here rather than a chip
// wedged beside the description, where the copy was unreadable.
//
// Tone is reinforcement only: every strip leads with an icon and its copy
// names the condition in words (PRD §6/§7.1 — never color alone). The `ai`
// tone carries no icon of its own on purpose: its content is an AiChip, which
// brings the mandatory AiSurface ✦ framing with it.
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { IconAlertCircle, IconAlertTriangle, IconCheck } from '../ui/icons';

export type ReviewStripTone = 'warning' | 'danger' | 'positive' | 'ai';

const toneClasses: Record<ReviewStripTone, string> = {
  warning: 'bg-warning-soft',
  danger: 'bg-danger-soft',
  positive: 'bg-positive-soft',
  ai: 'bg-surface-ai',
};

const toneIcons: Record<ReviewStripTone, ((props: { size?: number }) => JSX.Element) | null> = {
  warning: IconAlertTriangle,
  danger: IconAlertCircle,
  positive: IconCheck,
  ai: null,
};

// Read out before the copy so the condition is never conveyed by the tint.
const toneLabels: Record<ReviewStripTone, string | null> = {
  warning: 'Warning:',
  danger: 'Warning:',
  positive: null,
  ai: null,
};

export interface ReviewStripProps {
  tone: ReviewStripTone;
  /** Wired to a disabled control's aria-describedby when this strip is the
   *  reason it can't be used yet. */
  id?: string;
  children: ReactNode;
}

export function ReviewStrip({ tone, id, children }: ReviewStripProps) {
  const Icon = toneIcons[tone];
  const label = toneLabels[tone];
  return (
    <div
      className={cx(
        'flex items-start gap-2 border-b border-border px-4 py-2.5 text-sm text-ink',
        toneClasses[tone],
      )}
    >
      {Icon && (
        <span className="mt-0.5 shrink-0">
          <Icon size={14} />
        </span>
      )}
      <div id={id} className="min-w-0 flex-1">
        {label && <span className="sr-only">{label} </span>}
        {children}
      </div>
    </div>
  );
}
