// Weekly AI brief (W1) — the latest weekly_brief report's headline + action
// items, rendered at the top of the Dashboard's insights column. AI-authored,
// so everything sits inside AiSurface (binding convention).
//
// Item actions use the same vocabulary as insight cards and gate through the
// one chat action allowlist: api_call items execute the embedded REST route
// through the shared api client (normal auth/validation/audit path — never
// the assistant); anything not allowlisted renders disabled with a visible
// note, never silently dropped. The server only emits actions built from its
// own candidate list, so blocked items are a defense-in-depth signal, not an
// expected state. navigate items are plain in-app links.
import { useState } from 'react';
import type { SendRemindersResponse, WeeklyBriefItem } from '@hearth/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiClientError } from '../../api/client';
import { useLatestWeeklyBrief } from '../../api/queries';
import {
  ComposedRemindersModal,
  composeRemindersFromResponse,
  type ComposedReminder,
} from '../rent/ComposedRemindersModal';
import { Button, buttonClasses } from '../ui/Button';
import { useToast } from '../ui/Toast';
import { isAllowedApiCall, isAllowedNavigate } from '../chat/actionAllowlist';
import { AiSurface } from './AiSurface';

function isItemActionAllowed(action: NonNullable<WeeklyBriefItem['action']>): boolean {
  return action.action.kind === 'navigate'
    ? isAllowedNavigate(action.action.to)
    : isAllowedApiCall(action.action.method, action.action.path);
}

export function WeeklyBriefCard() {
  const latest = useLatestWeeklyBrief();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [executingIndex, setExecutingIndex] = useState<number | null>(null);
  const [composedReminders, setComposedReminders] = useState<ComposedReminder[]>([]);

  // Pending, fetch error, or no brief generated yet — render nothing rather
  // than empty-state noise (the dashboard has plenty without it).
  if (!latest.data) return null;
  const { report, brief } = latest.data;

  const runApiCall = async (action: NonNullable<WeeklyBriefItem['action']>, index: number) => {
    if (action.action.kind !== 'api_call' || !isItemActionAllowed(action)) return;
    // One brief action at a time — a second click while another call is in
    // flight would overwrite the shared busy index and could double-send.
    if (executingIndex !== null) return;
    const { method, path, body } = action.action;
    setExecutingIndex(index);
    try {
      if (method === 'POST' && path === '/rent/reminders') {
        // Human-initiated, so the server really emails when configured (F1) —
        // report the outcome through the same shared modal the Rent page and
        // chat action cards use ("Sent to X" vs. the composed mailto:
        // hand-off) instead of claiming a send that may not have happened.
        const response = await api.post<SendRemindersResponse>(path, body);
        const composed = composeRemindersFromResponse(response, action.label);
        setComposedReminders(composed);
        // Only toast plain success when nothing needs the mailto hand-off.
        if (composed.every((r) => r.deliveredVia === 'email')) {
          toast(`Done — ${action.label}.`, 'positive');
        }
      } else {
        if (method === 'PATCH') await api.patch(path, body ?? {});
        else await api.post(path, body);
        toast(`Done — ${action.label}.`, 'positive');
      }
      // The action can touch rent/ledger data — refresh everything (same
      // posture as insight cards and chat action cards).
      await queryClient.invalidateQueries();
    } catch (error) {
      toast(
        error instanceof ApiClientError
          ? error.message
          : `Could not complete “${action.label}”. Try again.`,
        'danger',
      );
    } finally {
      // Owner-checked clear: never strip another call's busy state.
      setExecutingIndex((cur) => (cur === index ? null : cur));
    }
  };

  return (
    <AiSurface as="section" aria-label="Weekly brief">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h2 className="text-sm font-semibold text-ink">Weekly brief</h2>
        <p className="text-xs text-ink-muted">{brief.weekLabel}</p>
      </div>
      <p className="mt-1 text-sm font-medium leading-relaxed text-ink">{brief.headline}</p>
      <ul className="mt-3 flex flex-col gap-2.5">
        {brief.items.map((item, index) => {
          const action = item.action;
          const allowed = action !== null && isItemActionAllowed(action);
          return (
            <li key={index} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className="min-w-0 flex-1 basis-56 text-sm leading-relaxed text-ink-muted">
                {item.text}
              </span>
              {action !== null &&
                (allowed && action.action.kind === 'api_call' ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    busy={executingIndex === index}
                    disabled={executingIndex !== null && executingIndex !== index}
                    onClick={() => void runApiCall(action, index)}
                  >
                    {action.label}
                  </Button>
                ) : allowed && action.action.kind === 'navigate' ? (
                  <Link to={action.action.to} className={buttonClasses('secondary', 'sm')}>
                    {action.label}
                  </Link>
                ) : (
                  // Refused, not hidden — the user should see what was proposed.
                  <span className="flex flex-col items-end gap-0.5">
                    <Button variant="secondary" size="sm" disabled>
                      {action.label}
                    </Button>
                    <span className="text-xs text-ink-muted">
                      This action isn't available here.
                    </span>
                  </span>
                ))}
            </li>
          );
        })}
      </ul>
      <div className="mt-3">
        <Link to={`/reports/${report.id}`} className="text-sm font-medium text-brand underline">
          Read full brief
        </Link>
      </div>
      <ComposedRemindersModal
        reminders={composedReminders}
        onClose={() => setComposedReminders([])}
      />
    </AiSurface>
  );
}
