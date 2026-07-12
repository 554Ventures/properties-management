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
import { useState } from 'react';
import type { Insight } from '@hearth/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { api, ApiClientError } from '../../api/client';
import { useDismissInsight, useMarkInsightActioned } from '../../api/queries';
import { Button, buttonClasses } from '../ui/Button';
import { StatusBadge, type BadgeTone } from '../ui/StatusBadge';
import { useToast } from '../ui/Toast';
import { isAllowedApiCall, isAllowedNavigate } from '../chat/actionAllowlist';
import { AiSurface } from './AiSurface';

export const severityBadge: Record<Insight['severity'], { tone: BadgeTone; label: string }> = {
  info: { tone: 'neutral', label: 'Heads up' },
  warning: { tone: 'warning', label: 'Needs attention' },
  positive: { tone: 'positive', label: 'Good news' },
};

function isActionAllowed(action: NonNullable<Insight['action']>): boolean {
  return action.action.kind === 'navigate'
    ? isAllowedNavigate(action.action.to)
    : isAllowedApiCall(action.action.method, action.action.path);
}

export function InsightCard({
  insight,
  headingLevel = 3,
}: {
  insight: Insight;
  /** 2 when the card sits directly under the page h1 (RentTracker, Money,
   *  TenantsList banners); 3 inside an h2 section (Dashboard, PropertyDetail).
   *  Axe's heading-order rule is merge-blocking. */
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const dismiss = useDismissInsight();
  const markActioned = useMarkInsightActioned();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [executing, setExecuting] = useState(false);
  const severity = severityBadge[insight.severity];

  const { pathname } = useLocation();
  /** True when a link would land on the page the card is already on. */
  const isSamePage = (to: string) => (to.split('?')[0] ?? to) === pathname;

  const structured = insight.action ?? null;
  const structuredAllowed = structured !== null && isActionAllowed(structured);
  const showStructuredNavigate =
    structuredAllowed &&
    structured?.action.kind === 'navigate' &&
    !isSamePage(structured.action.to);
  const hasRouteAction = Boolean(
    insight.actionLabel &&
      insight.actionTarget?.startsWith('/') &&
      !isSamePage(insight.actionTarget),
  );
  // The legacy link is the primary affordance when there's no structured
  // action, and the secondary context link next to an api_call button. When
  // the structured action is a navigate it mirrors the legacy link — render
  // only one.
  const showLegacyLink =
    hasRouteAction && (!structuredAllowed || structured?.action.kind === 'api_call');

  const runApiCall = async () => {
    if (!structured || structured.action.kind !== 'api_call' || !structuredAllowed) return;
    const { method, path, body } = structured.action;
    setExecuting(true);
    try {
      if (method === 'PATCH') await api.patch(path, body ?? {});
      else await api.post(path, body);
      toast(`Done — ${structured.label}.`, 'positive');
      // Record the confirmed suggestion; its onSuccess drops the card from
      // every active list. The action itself can touch rent/ledger data, so
      // refresh everything (same posture as chat action cards).
      markActioned.mutate(insight.id);
      await queryClient.invalidateQueries();
    } catch (error) {
      toast(
        error instanceof ApiClientError
          ? error.message
          : `Could not complete “${structured.label}”. Try again.`,
        'danger',
      );
    } finally {
      setExecuting(false);
    }
  };

  return (
    <AiSurface>
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
        <Button
          variant="ghost"
          size="sm"
          busy={dismiss.isPending}
          onClick={() =>
            dismiss.mutate(insight.id, {
              onSuccess: () => toast('Insight dismissed. It will stay hidden until something new comes up.'),
              onError: () => toast('Could not dismiss the insight. Try again.', 'danger'),
            })
          }
        >
          Dismiss
        </Button>
      </div>
      {structured && !structuredAllowed && (
        <p className="mt-2 text-xs text-ink-muted">This action isn't available here.</p>
      )}
    </AiSurface>
  );
}
