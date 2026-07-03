// AI insight card — always rendered inside AiSurface. Pages mount it inside a
// <LiveRegion> so newly generated cards are announced politely (§8 a11y note).
import type { Insight } from '@hearth/shared';
import { Link } from 'react-router-dom';
import { useDismissInsight } from '../../api/queries';
import { Button, buttonClasses } from '../ui/Button';
import { StatusBadge, type BadgeTone } from '../ui/StatusBadge';
import { useToast } from '../ui/Toast';
import { AiSurface } from './AiSurface';

const severityBadge: Record<Insight['severity'], { tone: BadgeTone; label: string }> = {
  info: { tone: 'neutral', label: 'Heads up' },
  warning: { tone: 'warning', label: 'Needs attention' },
  positive: { tone: 'positive', label: 'Good news' },
};

export function InsightCard({ insight }: { insight: Insight }) {
  const dismiss = useDismissInsight();
  const { toast } = useToast();
  const severity = severityBadge[insight.severity];
  const hasRouteAction = insight.actionLabel && insight.actionTarget?.startsWith('/');

  return (
    <AiSurface>
      <div className="mb-1 flex items-center gap-2">
        <StatusBadge tone={severity.tone}>{severity.label}</StatusBadge>
      </div>
      <h3 className="text-sm font-semibold text-ink">{insight.title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-ink-muted">{insight.body}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {hasRouteAction && (
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
    </AiSurface>
  );
}
