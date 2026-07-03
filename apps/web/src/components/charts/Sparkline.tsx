import { Line, LineChart, ResponsiveContainer } from 'recharts';
import { usePrefersReducedMotion } from '../../lib/useReducedMotion';
import { chartColor, type ChartRole } from './chartTheme';

export interface SparklineProps {
  points: number[];
  role?: ChartRole;
  height?: number;
}

/**
 * Tiny inline trend line. Decorative — the caller must provide the value as
 * accessible text next to it (e.g. KPI value + trend text).
 */
export function Sparkline({ points, role = 'neutral', height = 32 }: SparklineProps) {
  const reducedMotion = usePrefersReducedMotion();
  const data = points.map((y, i) => ({ i, y }));
  return (
    <div aria-hidden="true" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
          <Line
            type="monotone"
            dataKey="y"
            stroke={chartColor(role)}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={!reducedMotion}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
