// Deck of AI insight cards (Dashboard): every active insight, highest
// severity first (then newest) — the same ordering the old single-card
// endpoint used — presented as a stack. The top card is a full InsightCard
// (executable action, context link, dismiss all live); the cards beneath peek
// out as decorative edges. Previous/Next cycle with wrap-around and an
// "N of M" position readout; a single insight renders as a plain card with no
// deck chrome. Mount inside a <LiveRegion> so acting on or dismissing the top
// card announces the one that surfaces.
import { useState } from 'react';
import type { Insight } from '@hearth/shared';
import { Button } from '../ui/Button';
import { IconChevronLeft, IconChevronRight } from '../ui/icons';
import { InsightCard } from './InsightCard';

const SEVERITY_RANK: Record<Insight['severity'], number> = { warning: 3, info: 2, positive: 1 };

export function sortInsightsForDeck(insights: Insight[]): Insight[] {
  return [...insights].sort(
    (a, b) =>
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
      b.createdAt.localeCompare(a.createdAt),
  );
}

export function InsightDeck({ insights }: { insights: Insight[] }) {
  const [index, setIndex] = useState(0);
  const sorted = sortInsightsForDeck(insights);
  const count = sorted.length;
  if (count === 0) return null;
  // Acting on / dismissing a card shrinks the list out from under the index.
  const safeIndex = Math.min(index, count - 1);
  const current = sorted[safeIndex]!;
  const peek = Math.min(count - 1 - safeIndex, 2); // edges visible beneath the top card

  return (
    <section aria-label={`AI insights, ${count} active`} className="flex flex-col gap-2">
      <div className="relative" style={{ marginBottom: peek * 7 }}>
        {/* Cards still underneath: full-size layers scaled down and nudged
            lower, so the deck reads as a neat stack behind the top card. */}
        {peek >= 2 && (
          <div
            aria-hidden="true"
            className="absolute inset-0 rounded-lg border border-border-ai bg-surface-ai shadow-card"
            style={{ transform: 'translateY(14px) scale(0.94)' }}
          />
        )}
        {peek >= 1 && (
          <div
            aria-hidden="true"
            className="absolute inset-0 rounded-lg border border-border-ai bg-surface-ai shadow-card"
            style={{ transform: 'translateY(7px) scale(0.97)' }}
          />
        )}
        {/* Keyed on the insight so cycling (and a card surfacing after
            dismiss/action) replays the enter animation — zeroed under
            prefers-reduced-motion. */}
        <div key={current.id} className="relative animate-card-enter">
          <InsightCard insight={current} headingLevel={2} />
        </div>
      </div>

      {count > 1 && (
        <div className="flex items-center justify-end gap-2">
          <p className="text-xs text-ink-muted">
            {safeIndex + 1} of {count}
          </p>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Previous insight"
            onClick={() => setIndex((safeIndex - 1 + count) % count)}
          >
            <IconChevronLeft size={14} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Next insight"
            onClick={() => setIndex((safeIndex + 1) % count)}
          >
            <IconChevronRight size={14} />
          </Button>
        </div>
      )}
    </section>
  );
}
