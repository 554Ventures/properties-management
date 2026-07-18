import { useState } from 'react';
import type { Insight } from '@hearth/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { api, ApiClientError } from '../../api/client';
import { useDismissInsight, useMarkInsightActioned } from '../../api/queries';
import { useToast } from '../ui/Toast';
import { isAllowedApiCall, isAllowedNavigate } from '../chat/actionAllowlist';

function isActionAllowed(action: NonNullable<Insight['action']>): boolean {
  return action.action.kind === 'navigate'
    ? isAllowedNavigate(action.action.to)
    : isAllowedApiCall(action.action.method, action.action.path);
}

export interface UseInsightActionsOptions {
  /** Overrides the dismiss success toast — e.g. a merged "Needs attention" row
   *  where dismissing clears only the AI suggestion, not the derived status. */
  dismissToastMessage?: string;
}

export function useInsightActions(insight: Insight, options: UseInsightActionsOptions = {}) {
  const dismiss = useDismissInsight();
  const markActioned = useMarkInsightActioned();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [executing, setExecuting] = useState(false);

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

  const runDismiss = () =>
    dismiss.mutate(insight.id, {
      onSuccess: () =>
        toast(
          options.dismissToastMessage ??
            'Insight dismissed. It will stay hidden until something new comes up.',
        ),
      onError: () => toast('Could not dismiss the insight. Try again.', 'danger'),
    });

  return {
    structured,
    structuredAllowed,
    showStructuredNavigate,
    showLegacyLink,
    executing,
    runApiCall,
    dismiss: runDismiss,
    dismissPending: dismiss.isPending,
  };
}
