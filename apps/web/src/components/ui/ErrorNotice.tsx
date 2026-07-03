import { ApiClientError } from '../../api/client';
import { Button } from './Button';
import { IconAlertCircle } from './icons';

export interface ErrorNoticeProps {
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}

/** Inline data-load error with a retry affordance. */
export function ErrorNotice({ error, onRetry, className }: ErrorNoticeProps) {
  const message =
    error instanceof ApiClientError
      ? error.message
      : 'Something went wrong loading this data.';
  return (
    <div
      role="alert"
      className={
        className ??
        'flex items-center gap-3 rounded-md border border-border bg-danger-soft px-4 py-3 text-sm text-danger'
      }
    >
      <IconAlertCircle />
      <span className="flex-1">{message}</span>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
