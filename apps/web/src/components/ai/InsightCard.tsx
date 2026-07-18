// AI insight card — always rendered inside AiSurface. Pages mount it inside a
// <LiveRegion> so newly generated cards are announced politely (§8 a11y note).
//
// Actions: an insight may carry a structured `action` (same vocabulary as chat
// action cards). api_call actions execute the embedded REST route through the
// shared api client — normal auth/validation/audit path, never the assistant —
// and only if the route is on the chat action allowlist; anything else renders
// disabled with a visible note, never silently dropped. On success the insight
// is marked actioned (audited ai_suggested_user_confirmed server-side) and
// drops out of every active list. navigate actions are plain in-app links.
// The legacy actionLabel/actionTarget link keeps rendering for older rows, and
// as the secondary context link next to an api_call action.
//
// Contextual cards render ON the page their link points at (late_rent on
// /rent, underperforming on its property page) — a "go here" button for the
// page you're on is noise, so navigation actions whose target pathname is the
// current pathname are hidden. Executable actions and Dismiss always show.
import type { Insight } from '@hearth/shared';
import { Link } from 'react-router-dom';
import { Button, buttonClasses } from '../ui/Button';
import { StatusBadge, type BadgeTone } from '../ui/StatusBadge';
import { AiSurface } from './AiSurface';
import { useInsightActions } from './useInsightActions';

export const severityBadge: Record<Insight['severity'], { tone: BadgeTone; label: string }> = {
  info: { tone: 'neutral', label: 'Heads up' },
  warning: { tone: 'warning', label: 'Needs attention' },
  positive: { tone: 'positive', label: 'Good news' },
};

export function InsightCard({
  insight,
  headingLevel = 3,
  surface = true,
}: {
  insight: Insight;
  /** 2 when the card sits directly under the page h1 (RentTracker, Money,
   *  TenantsList banners); 3 inside an h2 section (Dashboard, PropertyDetail).
   *  Axe's heading-order rule is merge-blocking. */
  headingLevel?: 2 | 3;
  /** false when a parent AiSurface already frames this card (a page combining
   *  several AI blocks into one panel) — avoids nested borders/badges. */
  surface?: boolean;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const severity = severityBadge[insight.severity];
  const {
    structured,
    structuredAllowed,
    showStructuredNavigate,
    showLegacyLink,
    executing,
    runApiCall,
    dismiss,
    dismissPending,
  } = useInsightActions(insight);

  const content = (
    <>
      <div className="mb-1 flex items-center gap-2">
        <StatusBadge tone={severity.tone}>{severity.label}</StatusBadge>
      </div>
      <Heading className="text-sm font-semibold text-ink">{insight.title}</Heading>
      <p className="mt-1 text-sm leading-relaxed text-ink-muted">{insight.body}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {structured && structuredAllowed && structured.action.kind === 'api_call' && (
          <Button variant="primary" size="sm" busy={executing} onClick={() => void runApiCall()}>
            {structured.label}
          </Button>
        )}
        {showStructuredNavigate && structured?.action.kind === 'navigate' && (
          <Link to={structured.action.to} className={buttonClasses('secondary', 'sm')}>
            {structured.label}
          </Link>
        )}
        {structured && !structuredAllowed && (
          // Refused, not hidden — the user should see what was proposed.
          <Button variant="secondary" size="sm" disabled>
            {structured.label}
          </Button>
        )}
        {showLegacyLink && (
          <Link to={insight.actionTarget as string} className={buttonClasses('secondary', 'sm')}>
            {insight.actionLabel}
          </Link>
        )}
        <Button variant="ghost" size="sm" busy={dismissPending} onClick={dismiss}>
          Dismiss
        </Button>
      </div>
      {structured && !structuredAllowed && (
        <p className="mt-2 text-xs text-ink-muted">This action isn't available here.</p>
      )}
    </>
  );

  return surface ? <AiSurface>{content}</AiSurface> : content;
}
