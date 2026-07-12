// action_card block — buttons are dumb (§9.3): api_call actions execute the
// embedded §3 REST route through the shared api client (normal auth /
// validation / audit path), never through the assistant itself, and only if
// the route is on the explicit allowlist (actionAllowlist.ts) — anything else
// renders disabled with a visible note. navigate actions use react-router
// (in-app paths only) and close the drawer on mobile.
import { useState } from 'react';
import type {
  ActionCardAction,
  ActionCardBlock as ActionCardBlockData,
  SendRemindersResponse,
} from '@hearth/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiClientError } from '../../../api/client';
import { useChat } from '../../../state/chat';
import {
  ComposedRemindersModal,
  type ComposedReminder,
} from '../../rent/ComposedRemindersModal';
import { Button } from '../../ui/Button';
import { IconCheck } from '../../ui/icons';
import { useToast } from '../../ui/Toast';
import { isAllowedApiCall, isAllowedNavigate } from '../actionAllowlist';

function isActionAllowed(item: ActionCardAction): boolean {
  return item.action.kind === 'navigate'
    ? isAllowedNavigate(item.action.to)
    : isAllowedApiCall(item.action.method, item.action.path);
}

// "Send reminder to Jeremy Hopkins" -> "Jeremy Hopkins"; only meaningful for
// the single-tenant action (mock-scripts.ts and the real prompt both use this
// phrasing) — bulk actions fall back to the composed subject line per row.
function extractTenantName(label: string): string | null {
  const match = /^Send reminder to (.+)$/.exec(label);
  return match?.[1] ?? null;
}

export function ActionCardBlock({ block }: { block: ActionCardBlockData }) {
  const { toast } = useToast();
  const { close } = useChat();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [doneIds, setDoneIds] = useState<Record<string, true>>({});
  const [composedReminders, setComposedReminders] = useState<ComposedReminder[]>([]);

  const run = async (item: ActionCardAction) => {
    if (!isActionAllowed(item)) return; // defense in depth — button is disabled
    if (item.action.kind === 'navigate') {
      navigate(item.action.to);
      // Full-screen drawer below md would hide the destination page.
      if (window.matchMedia('(max-width: 767px)').matches) close();
      return;
    }
    const { method, path, body } = item.action;
    setPendingId(item.id);
    try {
      if (method === 'PATCH') {
        await api.patch(path, body ?? {});
      } else if (method === 'POST' && path === '/rent/reminders') {
        // No email is sent server-side (docs/WHATS_NEXT + rent.service.ts) —
        // surface the composed mailto: links the same way the Rent
        // Collection and Tenants pages do, instead of just a "Done" toast.
        const response = await api.post<SendRemindersResponse>(path, body);
        const sent = response.results.filter(
          (r): r is typeof r & { mailto: string } => r.status === 'sent' && !!r.mailto,
        );
        const singleName = sent.length === 1 ? extractTenantName(item.label) : null;
        setComposedReminders(
          sent.map((r) => ({
            tenantName: singleName ?? r.subject ?? item.label,
            mailto: r.mailto,
            subject: singleName ? r.subject : undefined,
          })),
        );
      } else {
        await api.post(path, body);
      }
      setDoneIds((prev) => ({ ...prev, [item.id]: true }));
      toast(`Done — ${item.label}.`, 'positive');
      // The action can touch any part of the ledger — refresh everything.
      await queryClient.invalidateQueries();
    } catch (error) {
      toast(
        error instanceof ApiClientError
          ? error.message
          : `Could not complete “${item.label}”. Try again.`,
        'danger',
      );
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="rounded-md border border-border bg-surface p-3.5">
      <h3 className="text-sm font-semibold text-ink">{block.title}</h3>
      {block.body && <p className="mt-1 text-sm leading-relaxed text-ink-muted">{block.body}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {block.actions.map((item) =>
          !isActionAllowed(item) ? (
            // Refused, not hidden — the user should see what the AI proposed.
            <Button key={item.id} variant="secondary" size="sm" disabled>
              {item.label}
            </Button>
          ) : doneIds[item.id] ? (
            <Button key={item.id} variant="secondary" size="sm" disabled>
              <span className="text-positive">
                <IconCheck size={14} />
              </span>
              Done — {item.label}
            </Button>
          ) : (
            <Button
              key={item.id}
              variant={item.style === 'primary' ? 'primary' : 'secondary'}
              size="sm"
              busy={pendingId === item.id}
              disabled={pendingId !== null && pendingId !== item.id}
              onClick={() => void run(item)}
            >
              {item.label}
            </Button>
          ),
        )}
      </div>
      {block.actions.some((item) => !isActionAllowed(item)) && (
        <p className="mt-2 text-xs text-ink-muted">This action isn't available from chat.</p>
      )}
      <ComposedRemindersModal
        reminders={composedReminders}
        onClose={() => setComposedReminders([])}
      />
    </div>
  );
}
