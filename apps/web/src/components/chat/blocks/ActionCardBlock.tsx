// action_card block — buttons are dumb (§9.3): api_call actions execute the
// embedded §3 REST route through the shared api client (normal auth /
// validation / audit path), never through the assistant itself. navigate
// actions use react-router and close the drawer on mobile.
import { useState } from 'react';
import type { ActionCardAction, ActionCardBlock as ActionCardBlockData } from '@hearth/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiClientError } from '../../../api/client';
import { useChat } from '../../../state/chat';
import { Button } from '../../ui/Button';
import { IconCheck } from '../../ui/icons';
import { useToast } from '../../ui/Toast';

export function ActionCardBlock({ block }: { block: ActionCardBlockData }) {
  const { toast } = useToast();
  const { close } = useChat();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [doneIds, setDoneIds] = useState<Record<string, true>>({});

  const run = async (item: ActionCardAction) => {
    if (item.action.kind === 'navigate') {
      navigate(item.action.to);
      // Full-screen drawer below md would hide the destination page.
      if (window.matchMedia('(max-width: 767px)').matches) close();
      return;
    }
    const { method, path, body } = item.action;
    setPendingId(item.id);
    try {
      if (method === 'PATCH') await api.patch(path, body ?? {});
      else await api.post(path, body);
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
          doneIds[item.id] ? (
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
    </div>
  );
}
