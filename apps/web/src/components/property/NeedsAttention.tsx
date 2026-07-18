// "Needs attention" for a property or unit — one severity-sorted list that
// merges derived ledger arithmetic (rent trouble, leases ending soon,
// vacancies — computed by deriveTasks) with property-scoped AI insights,
// deduplicated in attention.ts: a matching late_rent insight enriches its rent
// row rather than duplicating it, and unmatched insights become their own
// rows. Plain Card chrome — but AI-sourced or AI-enriched rows are marked with
// the inline AiSurface ✦ pill and carry the insight's own action plus a
// Dismiss, so the old "exactly one affordance per row" rule is relaxed for
// those rows. Task rows still carry a single trailing affordance — a Link when
// it navigates, a Button when it acts in place.
import type { ReactNode } from 'react';
import { RENEW_SOON_DAYS } from '@hearth/shared';
import type { Insight, LeaseWithTenants, PropertyDetailUnit } from '@hearth/shared';
import { Link } from 'react-router-dom';
import { AiSurface } from '../ai/AiSurface';
import { useInsightActions } from '../ai/useInsightActions';
import { Button, buttonClasses } from '../ui/Button';
import { Card } from '../ui/Card';
import { LiveRegion } from '../ui/LiveRegion';
import { StatusBadge } from '../ui/StatusBadge';
import { deriveTasks, mergeAttention, type TaskAffordance } from './attention';

export interface NeedsAttentionProps {
  /** Property (or unit) display name, for the all-clear line. */
  title: string;
  units: PropertyDetailUnit[];
  /** Property-scoped AI insights to merge in (deduped against tasks in
   *  attention.ts). */
  insights?: Insight[];
  /** Archived subject: derive no tasks and never read as "all clear" — only
   *  pre-existing insight rows may render, and if there are none the card is
   *  hidden entirely. */
  archived?: boolean;
  /** Gates the in-place write affordances (Draft renewal / Create lease). */
  canTenants: boolean;
  draftBusy: boolean;
  onDraftRenewal: (lease: LeaseWithTenants) => void;
  onCreateLease: (unit: PropertyDetailUnit) => void;
}

// Dismissing the AI suggestion on a merged row clears only the suggestion; the
// derived status (a late-rent row is the only kind that merges) stays put.
const MERGED_DISMISS_MESSAGE = "AI suggestion dismissed — the rent status stays until it's resolved.";

interface AffordanceHandlers {
  canTenants: boolean;
  draftBusy: boolean;
  onDraftRenewal: (lease: LeaseWithTenants) => void;
  onCreateLease: (unit: PropertyDetailUnit) => void;
}

/** Renders a task's single trailing affordance from its data descriptor, gated
 *  exactly as the pre-merge component did: tracker links always show; write
 *  actions only when canTenants. */
function renderTaskAffordance(
  affordance: TaskAffordance | null,
  handlers: AffordanceHandlers,
): ReactNode {
  if (!affordance) return null;
  if (affordance.type === 'tracker-link') {
    return (
      <Link to={`/rent?period=${affordance.period}`} className={buttonClasses('ghost', 'sm')}>
        Open rent tracker →
      </Link>
    );
  }
  if (affordance.type === 'draft-renewal') {
    if (!handlers.canTenants) return null;
    return (
      <Button
        variant="secondary"
        size="sm"
        busy={handlers.draftBusy}
        onClick={() => handlers.onDraftRenewal(affordance.lease)}
      >
        Draft renewal
      </Button>
    );
  }
  // create-lease
  if (!handlers.canTenants) return null;
  return (
    <Button variant="secondary" size="sm" onClick={() => handlers.onCreateLease(affordance.unit)}>
      Create lease
    </Button>
  );
}

/** The AI action cluster for an insight-bearing row: the insight's own
 *  structured action (mirrored from InsightCard through the shared hook) plus a
 *  Dismiss. Its own component so the hook is called only for rows that actually
 *  carry an insight — hooks can't run conditionally inside the row loop. */
function InsightRowActions({ insight, merged }: { insight: Insight; merged: boolean }) {
  const {
    structured,
    structuredAllowed,
    showStructuredNavigate,
    showLegacyLink,
    executing,
    runApiCall,
    dismiss,
    dismissPending,
  } = useInsightActions(insight, merged ? { dismissToastMessage: MERGED_DISMISS_MESSAGE } : undefined);

  return (
    <>
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
        // Refused, not hidden — the user should still see what was proposed.
        <Button variant="secondary" size="sm" disabled>
          {structured.label}
        </Button>
      )}
      {/* On a merged row the task's own affordance (e.g. "Open rent tracker
          →") already covers navigation, so the insight's legacy link would
          just be a second link to the same place — suppress it there. */}
      {showLegacyLink && !merged && (
        <Link to={insight.actionTarget as string} className={buttonClasses('secondary', 'sm')}>
          {insight.actionLabel}
        </Link>
      )}
      <Button variant="ghost" size="sm" busy={dismissPending} onClick={dismiss}>
        Dismiss
      </Button>
      {structured && !structuredAllowed && (
        <p className="basis-full text-xs text-ink-muted">This action isn't available here.</p>
      )}
    </>
  );
}

export function NeedsAttention({
  title,
  units,
  insights = [],
  archived = false,
  canTenants,
  draftBusy,
  onDraftRenewal,
  onCreateLease,
}: NeedsAttentionProps) {
  // An archived subject derives no tasks (so it never reads as "all clear");
  // only insight rows survive the merge.
  const tasks = archived ? [] : deriveTasks(units);
  const rows = mergeAttention(tasks, insights);

  if (archived && rows.length === 0) return null;

  const handlers: AffordanceHandlers = { canTenants, draftBusy, onDraftRenewal, onCreateLease };

  return (
    <Card>
      <h2 className="text-base font-semibold text-ink">Needs attention</h2>
      {/* Live region so insight rows appearing/removing announce politely; the
          heading stays outside it as a direct child of the Card. */}
      <LiveRegion>
        {rows.length > 0 ? (
          <ul className="mt-3 flex flex-col divide-y divide-border">
            {rows.map((row) => (
              <li
                key={row.key}
                className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
                    <StatusBadge tone={row.tone}>{row.badge}</StatusBadge>
                    <span>{row.sentence}</span>
                    {row.insight && (
                      <AiSurface inline as="span">
                        suggestion
                      </AiSurface>
                    )}
                  </div>
                  {row.detail && <p className="text-sm text-ink-muted">{row.detail}</p>}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {renderTaskAffordance(row.task?.affordance ?? null, handlers)}
                  {row.insight && (
                    <InsightRowActions insight={row.insight} merged={Boolean(row.task)} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            <StatusBadge tone="positive">All clear</StatusBadge>
            <span>
              All clear at {title} — rent on track, no leases ending in the next {RENEW_SOON_DAYS}{' '}
              days.
            </span>
          </p>
        )}
      </LiveRegion>
    </Card>
  );
}
