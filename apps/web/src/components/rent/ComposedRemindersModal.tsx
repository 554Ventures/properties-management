// Shared reminders result modal — used everywhere send_rent_reminders can be
// triggered from (Rent Collection, chat action cards) so the outcome looks
// and behaves the same everywhere. Two shapes per row (F1):
// - deliveredVia 'email': the server really sent the email — show "Sent to X"
//   (icon + text, never color alone) with the mailto demoted to a copy link.
// - deliveredVia 'mailto' (or absent, for older responses): nothing was sent
//   server-side — the mailto: hand-off stays the primary action.
import type { SendRemindersResponse } from '@hearth/shared';
import { Button, buttonClasses } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { StatusBadge } from '../ui/StatusBadge';
import { IconBell } from '../ui/icons';

export interface ComposedReminder {
  tenantName: string;
  mailto: string;
  subject?: string;
  deliveredVia?: 'email' | 'mailto';
  to?: string;
}

// "Send reminder to Jeremy Hopkins" -> "Jeremy Hopkins"; only meaningful for
// the single-tenant action (mock-scripts.ts and the real prompt both use this
// phrasing) — bulk actions fall back to the composed subject line per row.
function extractTenantName(label: string): string | null {
  const match = /^Send reminder to (.+)$/.exec(label);
  return match?.[1] ?? null;
}

/** Map a POST /rent/reminders response to modal rows — shared by every
 *  AI-action surface (chat action cards, weekly brief card) so delivery is
 *  reported identically everywhere (F1: never claim a send that didn't
 *  happen). */
export function composeRemindersFromResponse(
  response: SendRemindersResponse,
  actionLabel: string,
): ComposedReminder[] {
  const sent = response.results.filter(
    (r): r is typeof r & { mailto: string } => r.status === 'sent' && !!r.mailto,
  );
  const singleName = sent.length === 1 ? extractTenantName(actionLabel) : null;
  return sent.map((r) => ({
    tenantName: singleName ?? r.subject ?? actionLabel,
    mailto: r.mailto,
    subject: singleName ? r.subject : undefined,
    deliveredVia: r.deliveredVia,
    to: r.to,
  }));
}

export function ComposedRemindersModal({
  reminders,
  onClose,
}: {
  reminders: ComposedReminder[];
  onClose: () => void;
}) {
  const plural = reminders.length !== 1;
  const emailedCount = reminders.filter((r) => r.deliveredVia === 'email').length;
  const allEmailed = emailedCount === reminders.length && reminders.length > 0;
  const title =
    emailedCount > 0
      ? plural
        ? 'Reminders sent'
        : 'Reminder sent'
      : plural
        ? 'Reminders composed'
        : 'Reminder composed';
  const intro = allEmailed
    ? plural
      ? 'Each reminder was emailed to the tenant. Open a copy if you want one in your own mail app.'
      : 'The reminder was emailed to the tenant. Open a copy if you want one in your own mail app.'
    : emailedCount > 0
      ? 'Some reminders were emailed directly; open the rest to review and send them from your own mail app.'
      : plural
        ? 'Open each one to review and send it from your own mail app.'
        : 'Open it to review and send from your own mail app.';
  return (
    <Modal open={reminders.length > 0} onClose={onClose} title={title} size="md">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">{intro}</p>
        <ul className="flex flex-col gap-2">
          {reminders.map((r, i) => (
            <li key={`${r.tenantName}-${i}`} className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium text-ink">{r.tenantName}</span>
                {r.subject && (
                  <span className="truncate text-xs text-ink-muted">{r.subject}</span>
                )}
              </span>
              {r.deliveredVia === 'email' ? (
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <StatusBadge tone="positive">Sent to {r.to ?? r.tenantName}</StatusBadge>
                  <a href={r.mailto} className="text-xs font-medium text-brand underline">
                    Open a copy
                  </a>
                </span>
              ) : (
                <a
                  href={r.mailto}
                  className={buttonClasses('secondary', 'sm') + ' shrink-0 whitespace-nowrap'}
                >
                  <IconBell size={12} />
                  Open email
                </a>
              )}
            </li>
          ))}
        </ul>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}
