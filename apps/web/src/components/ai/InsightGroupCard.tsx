// Grouped insight card: several insights of the same type+severity (e.g. one
// late_rent per tenant) render as ONE card with a per-item row each, instead
// of burying near-identical cards in the deck. Rows keep the exact posture of
// InsightCard actions: an allowed api_call executes through the shared api
// client (normal auth/validation/audit path) and marks that insight actioned;
// a non-allowlisted action renders disabled with the visible note; navigate
// actions are plain in-app links, hidden on their own page.
//
// The batch button ("<label> for all N") is honest about how it works: it
// executes each member's own allowlisted api_call in sequence — one audited,
// individually-attributed action per insight — never a synthesized bulk call
// outside the allowlist.
import { useState } from 'react';
import type { Insight } from '@hearth/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../../api/client';
import { useDismissInsight, useMarkInsightActioned } from '../../api/queries';
import { Button, buttonClasses } from '../ui/Button';
import { StatusBadge } from '../ui/StatusBadge';
import { useToast } from '../ui/Toast';
import { isAllowedApiCall, isAllowedNavigate } from '../chat/actionAllowlist';
import { AiSurface } from './AiSurface';
import { severityBadge } from './InsightCard';

const SEVERITY_RANK: Record<Insight['severity'], number> = { warning: 3, info: 2, positive: 1 };

/** Rows shown before the card collapses behind "Show all N" — keeps a
 *  many-member group (14 late tenants) from dominating the dashboard. */
const ROWS_COLLAPSED = 6;

/** Human titles for known rule ids; unknown types get a neutral fallback. */
const GROUP_TITLES: Record<string, (n: number) => string> = {
  late_rent: (n) => `${n} tenants are late on rent`,
  expense_spike: (n) => `${n} expense categories spiked this month`,
  renewal_window: (n) => `${n} leases are in their renewal window`,
  underperforming_property: (n) => `${n} properties are underperforming`,
};

export function groupTitle(type: string, count: number): string {
  return GROUP_TITLES[type]?.(count) ?? `${count} related insights`;
}

type ExecutableMember = {
  insight: Insight;
  method: 'POST' | 'PATCH';
  path: string;
  body?: unknown;
  label: string;
};

function executableAction(insight: Insight): ExecutableMember | null {
  const structured = insight.action;
  if (!structured || structured.action.kind !== 'api_call') return null;
  const { method, path, body } = structured.action;
  if (!isAllowedApiCall(method, path)) return null;
  return { insight, method, path, body, label: structured.label };
}

export function InsightGroupCard({
  insights,
  headingLevel = 3,
}: {
  /** ≥2 insights sharing a type — the deck routes singletons to InsightCard. */
  insights: Insight[];
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const dismiss = useDismissInsight();
  const markActioned = useMarkInsightActioned();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { pathname } = useLocation();
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [dismissBusy, setDismissBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const busy = batchBusy || dismissBusy || executingId !== null;

  const top = insights.reduce((a, b) =>
    (SEVERITY_RANK[b.severity] ?? 0) > (SEVERITY_RANK[a.severity] ?? 0) ? b : a,
  );
  const severity = severityBadge[top.severity];
  const title = groupTitle(top.type, insights.length);

  const executables = insights
    .map(executableAction)
    .filter((m): m is ExecutableMember => m !== null);
  const anyRefused = insights.some(
    (i) => i.action?.action.kind === 'api_call' && executableAction(i) === null,
  );

  const isSamePage = (to: string) => (to.split('?')[0] ?? to) === pathname;
  // One shared context link when every member points at the same route.
  const sharedTarget =
    insights[0]?.actionTarget &&
    insights[0].actionLabel &&
    insights.every((i) => i.actionTarget === insights[0]!.actionTarget) &&
    isAllowedNavigate(insights[0].actionTarget) &&
    !isSamePage(insights[0].actionTarget)
      ? { to: insights[0].actionTarget, label: insights[0].actionLabel }
      : null;

  const runOne = async (member: ExecutableMember): Promise<boolean> => {
    try {
      if (member.method === 'PATCH') await api.patch(member.path, member.body ?? {});
      else await api.post(member.path, member.body);
      markActioned.mutate(member.insight.id);
      return true;
    } catch {
      return false;
    }
  };

  const runSingle = async (member: ExecutableMember) => {
    setExecutingId(member.insight.id);
    const ok = await runOne(member);
    setExecutingId(null);
    toast(
      ok ? `Done — ${member.label}.` : `Could not complete “${member.label}”. Try again.`,
      ok ? 'positive' : 'danger',
    );
    if (ok) await queryClient.invalidateQueries();
  };

  const runAll = async () => {
    setBatchBusy(true);
    let done = 0;
    for (const member of executables) {
      if (await runOne(member)) done += 1;
    }
    setBatchBusy(false);
    toast(
      done === executables.length
        ? `Done — ${executables[0]!.label.toLowerCase()} for all ${done}.`
        : `${done} of ${executables.length} completed — try the rest again.`,
      done === executables.length ? 'positive' : 'danger',
    );
    await queryClient.invalidateQueries();
  };

  const dismissAll = async () => {
    setDismissBusy(true);
    let failed = 0;
    for (const insight of insights) {
      try {
        await dismiss.mutateAsync(insight.id);
      } catch {
        failed += 1;
      }
    }
    setDismissBusy(false);
    toast(
      failed === 0
        ? 'Insights dismissed. They will stay hidden until something new comes up.'
        : 'Could not dismiss some insights. Try again.',
      failed === 0 ? 'neutral' : 'danger',
    );
  };

  return (
    <AiSurface>
      <div className="mb-1 flex items-center gap-2">
        <StatusBadge tone={severity.tone}>{severity.label}</StatusBadge>
      </div>
      <Heading className="text-sm font-semibold text-ink">{title}</Heading>
      <ul className="mt-2 divide-y divide-border">
        {(expanded ? insights : insights.slice(0, ROWS_COLLAPSED)).map((insight) => {
          const member = executableAction(insight);
          const structured = insight.action;
          const navTo =
            structured?.action.kind === 'navigate' &&
            isAllowedNavigate(structured.action.to) &&
            !isSamePage(structured.action.to)
              ? structured.action.to
              : null;
          return (
            <li
              key={insight.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 text-ink-muted">{insight.title}</span>
              {member && (
                <Button
                  variant="secondary"
                  size="sm"
                  busy={executingId === insight.id}
                  disabled={busy && executingId !== insight.id}
                  aria-label={`${member.label} — ${insight.title}`}
                  onClick={() => void runSingle(member)}
                >
                  {member.label}
                </Button>
              )}
              {structured && structured.action.kind === 'api_call' && !member && (
                <Button variant="secondary" size="sm" disabled>
                  {structured.label}
                </Button>
              )}
              {navTo && structured && (
                <Link to={navTo} className={buttonClasses('secondary', 'sm')}>
                  {structured.label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {insights.length > ROWS_COLLAPSED && (
        <button
          type="button"
          className="mt-1 text-xs font-medium text-ink-ai hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show fewer' : `Show all ${insights.length}`}
        </button>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {executables.length >= 2 && (
          <Button variant="primary" size="sm" busy={batchBusy} disabled={busy && !batchBusy} onClick={() => void runAll()}>
            {executables[0]!.label} for all {executables.length}
          </Button>
        )}
        {sharedTarget && (
          <Link to={sharedTarget.to} className={buttonClasses('secondary', 'sm')}>
            {sharedTarget.label}
          </Link>
        )}
        <Button
          variant="ghost"
          size="sm"
          busy={dismissBusy}
          disabled={busy && !dismissBusy}
          onClick={() => void dismissAll()}
        >
          Dismiss all
        </Button>
      </div>
      {anyRefused && (
        <p className="mt-2 text-xs text-ink-muted">Some actions aren't available here.</p>
      )}
    </AiSurface>
  );
}
