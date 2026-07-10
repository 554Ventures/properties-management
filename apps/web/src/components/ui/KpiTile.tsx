// Dashboard KPI tile — keyboard-focusable, full value exposed as accessible
// text (ARCHITECTURE §8), skeleton reserves exact final dimensions (no CLS).
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { trendText } from '../../lib/format';
import { IconArrowDownRight, IconArrowUpRight } from './icons';
import { Skeleton } from './Skeleton';

export interface KpiTrend {
  pct: number;
  /** Whether an increase is good news (false for expenses). */
  goodWhenUp?: boolean;
}

export interface KpiTileProps {
  label: string;
  value: string;
  /** Full value in accessible text, e.g. "Net cash flow, $8,450, up 4% vs last month". */
  ariaLabel: string;
  trend?: KpiTrend;
  /** Colors the value as reinforcement only — the value text itself (e.g. a
   * minus sign) must already carry the meaning. */
  tone?: 'positive' | 'danger';
  /** Extra content (progress bar, disclaimer) — replaces the trend row space. */
  children?: ReactNode;
}

const tileClasses =
  'flex min-h-[7.5rem] flex-col justify-between gap-2 rounded-lg border border-border bg-surface p-5 shadow-card transition-shadow duration-fast';

export function KpiTile({ label, value, ariaLabel, trend, tone, children }: KpiTileProps) {
  return (
    <div role="group" tabIndex={0} aria-label={ariaLabel} className={tileClasses}>
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</p>
      <p
        className={cx(
          'text-2xl font-semibold tabular-nums',
          tone === 'danger' ? 'text-danger' : tone === 'positive' ? 'text-positive' : 'text-ink',
        )}
      >
        {value}
      </p>
      {trend ? <TrendRow trend={trend} /> : <div className="min-h-[1rem]">{children}</div>}
    </div>
  );
}

function TrendRow({ trend }: { trend: KpiTrend }) {
  const up = trend.pct >= 0;
  const good = trend.goodWhenUp === false ? !up : up;
  const Arrow = up ? IconArrowUpRight : IconArrowDownRight;
  return (
    <p
      className={cx(
        'flex min-h-[1rem] items-center gap-1 text-xs font-medium',
        trend.pct === 0 ? 'text-ink-muted' : good ? 'text-positive' : 'text-danger',
      )}
    >
      <Arrow size={12} />
      {trendText(trend.pct)} vs last month
    </p>
  );
}

/** Same box dimensions as a loaded tile — zero layout shift. */
export function KpiTileSkeleton() {
  return (
    <div className={tileClasses} aria-hidden="true">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-28" />
      <Skeleton className="h-4 w-32" />
    </div>
  );
}
