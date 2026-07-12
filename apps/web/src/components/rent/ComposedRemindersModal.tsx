// Shared "Reminders composed" modal — used everywhere send_rent_reminders can
// be triggered from (Rent Collection, Tenants & Leases, chat action cards) so
// the mailto: hand-off looks and behaves the same everywhere.
import { Button, buttonClasses } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { IconBell } from '../ui/icons';

export interface ComposedReminder {
  tenantName: string;
  mailto: string;
  subject?: string;
}

export function ComposedRemindersModal({
  reminders,
  onClose,
}: {
  reminders: ComposedReminder[];
  onClose: () => void;
}) {
  const plural = reminders.length !== 1;
  return (
    <Modal
      open={reminders.length > 0}
      onClose={onClose}
      title={plural ? 'Reminders composed' : 'Reminder composed'}
      size="md"
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          {plural
            ? 'Open each one to review and send it from your own mail app.'
            : 'Open it to review and send from your own mail app.'}
        </p>
        <ul className="flex flex-col gap-2">
          {reminders.map((r, i) => (
            <li key={`${r.tenantName}-${i}`} className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium text-ink">{r.tenantName}</span>
                {r.subject && (
                  <span className="truncate text-xs text-ink-muted">{r.subject}</span>
                )}
              </span>
              <a
                href={r.mailto}
                className={buttonClasses('secondary', 'sm') + ' shrink-0 whitespace-nowrap'}
              >
                <IconBell size={12} />
                Open email
              </a>
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
