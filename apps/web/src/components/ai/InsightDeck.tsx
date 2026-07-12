// Deck of AI insight cards (Dashboard): every active insight, highest
// severity first (then newest), presented as a stack. Insights sharing a
// type+severity (e.g. one late_rent per tenant) merge into a single grouped
// card (InsightGroupCard) with per-item rows, so the deck cycles genuinely
// distinct observations instead of near-identical repeats. The top card is
// fully live (executable actions, context link, dismiss); the cards beneath
// peek out as decorative edges. Previous/Next cycle with wrap-around and an
// "N of M" position readout; a single card renders with no deck chrome.
// Mount inside a <LiveRegion> so acting on or dismissing the top card
// announces the one that surfaces.
//
// Shuffle choreography: cycling keeps the outgoing card mounted for one
// animation beat — it lifts up and fades (card-shuffle-out) while the
// incoming card rises from the stacked-layer position (card-shuffle-in), so
// the deck visibly deals the next card. Both keyframes run on the motion
// tokens and are zeroed by the prefers-reduced-motion override.
import { useEffect, useRef, useState } from 'react';
import type { Insight } from '@hearth/shared';
import { Button } from '../ui/Button';
import { IconChevronLeft, IconChevronRight } from '../ui/icons';
import { InsightCard } from './InsightCard';
import { InsightGroupCard } from './InsightGroupCard';

const SEVERITY_RANK: Record<Insight['severity'], number> = { warning: 3, info: 2, positive: 1 };

export function sortInsightsForDeck(insights: Insight[]): Insight[] {
  return [...insights].sort(
    (a, b) =>
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
      b.createdAt.localeCompare(a.createdAt),
  );
}

/** Deck units: insights sharing type+severity collapse into one group, in the
 *  position of their highest-ranked member (Map preserves first-seen order
 *  over the severity-then-newest sort). */
export function groupInsightsForDeck(insights: Insight[]): Insight[][] {
  const groups = new Map<string, Insight[]>();
  for (const insight of sortInsightsForDeck(insights)) {
    const key = `${insight.type}:${insight.severity}`;
    const group = groups.get(key);
    if (group) group.push(insight);
    else groups.set(key, [insight]);
  }
  return [...groups.values()];
}

const groupKey = (group: Insight[]) => group.map((i) => i.id).join('|');

function DeckCard({ group }: { group: Insight[] }) {
  return group.length === 1 ? (
    <InsightCard insight={group[0]!} headingLevel={2} />
  ) : (
    <InsightGroupCard insights={group} headingLevel={2} />
  );
}

export function InsightDeck({ insights }: { insights: Insight[] }) {
  const [index, setIndex] = useState(0);
  // The card the user just cycled away from, kept mounted while its exit
  // animation plays. Only Previous/Next set this — a card leaving because it
  // was dismissed/actioned should simply reveal the next one, not replay.
  const [leaving, setLeaving] = useState<Insight[] | null>(null);
  const leaveTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  const groups = groupInsightsForDeck(insights);
  const count = groups.length;
  if (count === 0) return null;
  // Acting on / dismissing a card shrinks the list out from under the index.
  const safeIndex = Math.min(index, count - 1);
  const current = groups[safeIndex]!;
  const peek = Math.min(count - 1 - safeIndex, 2); // edges visible beneath the top card

  const clearLeaving = () => {
    window.clearTimeout(leaveTimer.current);
    setLeaving(null);
  };
  const cycleTo = (nextIndex: number) => {
    setLeaving(current);
    setIndex(nextIndex);
    // Fallback for environments where animationend never fires (jsdom, and
    // the reduced-motion zero-duration edge) — slightly past --motion-slow.
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setLeaving(null), 250);
  };

  return (
    <section aria-label={`AI insights, ${insights.length} active`} className="flex flex-col gap-2">
      <div className="relative" style={{ marginBottom: peek * 7 }}>
        {/* Cards still underneath: full-size layers scaled down and nudged
            lower, so the deck reads as a neat stack behind the top card. */}
        {peek >= 2 && (
          <div
            aria-hidden="true"
            className="ai-frame absolute inset-0 rounded-lg border shadow-card"
            style={{ transform: 'translateY(14px) scale(0.94)' }}
          />
        )}
        {peek >= 1 && (
          <div
            aria-hidden="true"
            className="ai-frame absolute inset-0 rounded-lg border shadow-card"
            style={{ transform: 'translateY(7px) scale(0.97)' }}
          />
        )}
        {/* Keyed on the group so a new top card (cycling, or surfacing after
            dismiss/action) replays the deal-from-the-stack entrance. */}
        <div key={groupKey(current)} className="relative z-10 animate-card-shuffle-in">
          <DeckCard group={current} />
        </div>
        {/* The outgoing card, lifting away above the incoming one. Decorative
            for the beat it exists: hidden from AT and untouchable. */}
        {leaving && groupKey(leaving) !== groupKey(current) && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-20 animate-card-shuffle-out"
            onAnimationEnd={clearLeaving}
          >
            <DeckCard group={leaving} />
          </div>
        )}
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
            onClick={() => cycleTo((safeIndex - 1 + count) % count)}
          >
            <IconChevronLeft size={14} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Next insight"
            onClick={() => cycleTo((safeIndex + 1) % count)}
          >
            <IconChevronRight size={14} />
          </Button>
        </div>
      )}
    </section>
  );
}
