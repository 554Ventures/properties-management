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
  /**
   * Render the suggestion as information rather than an action. For a viewer
   * who can't write in this area the field the chip would fill isn't on screen,
   * so a button here would look clickable and do nothing.
   */
  readOnly?: boolean;
}

export function AiChip({
  name,
  confidence,
  onApply,
  applied = false,
  note,
  readOnly = false,
}: AiChipProps) {
  const descId = useId();
  const pct = Math.round(confidence * 100);
  const label = `suggests: ${name} (${pct}%)${note ? ` — ${note}` : ''}`;

  if (readOnly) {
    return (
      <>
        <AiSurface inline aria-describedby={descId}>
          {label}
        </AiSurface>
        <span id={descId} className="sr-only">
          AI-suggested, {pct}% confidence. Shown for information — applying it needs write access
          to this area.
        </span>
      </>
    );
  }

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
        {label}
        {applied ? ' — applied' : ''}
      </AiSurface>
      <span id={descId} className="sr-only">
        AI-suggested, {pct}% confidence — confirm or change before saving. Selecting this applies
        the suggestion to the field; it is never applied automatically.
      </span>
    </>
  );
}
