// Suggested-category chip: "✦ AI suggests: Repairs (84%)". Clicking applies
// the suggestion to the form field — it is NEVER auto-applied (PRD §5.4).
import { useId } from 'react';
import { AiSurface } from './AiSurface';

export interface AiChipProps {
  /** Suggested value display name, e.g. the category name. */
  name: string;
  /** Model confidence, 0–1. */
  confidence: number;
  onApply: () => void;
  applied?: boolean;
  /** Provenance note rendered inside the chip, e.g. "from your past choice". */
  note?: string;
}

export function AiChip({ name, confidence, onApply, applied = false, note }: AiChipProps) {
  const descId = useId();
  const pct = Math.round(confidence * 100);
  return (
    <>
      <AiSurface
        inline
        as="button"
        type="button"
        onClick={onApply}
        disabled={applied}
        aria-describedby={descId}
        className="transition-shadow duration-fast enabled:hover:shadow-card enabled:hover:brightness-[0.97] disabled:opacity-70"
      >
        suggests: {name} ({pct}%){note ? ` — ${note}` : ''}{applied ? ' — applied' : ''}
      </AiSurface>
      <span id={descId} className="sr-only">
        AI-suggested, {pct}% confidence — confirm or change before saving. Selecting this applies
        the suggestion to the field; it is never applied automatically.
      </span>
    </>
  );
}
