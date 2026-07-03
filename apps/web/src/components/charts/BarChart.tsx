// Grouped bar chart (income vs. expense). Colors come only from the chart
// tokens; animation is disabled under prefers-reduced-motion.
import { formatUsd, formatUsdWhole } from '@hearth/shared';
import {
  Bar,
  BarChart as RBarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { usePrefersReducedMotion } from '../../lib/useReducedMotion';
import { chartColor, chartGridColor, chartTextColor, tooltipStyle, type ChartRole } from './chartTheme';

export interface BarSeries {
  key: string;
  label: string;
  role: ChartRole;
}

export interface BarChartProps {
  data: Record<string, string | number>[];
  xKey: string;
  series: BarSeries[];
  /** "usd" — values are cents, formatted with the shared money helpers. */
  yFormat?: 'usd' | 'number';
}

export function BarChart({ data, xKey, series, yFormat = 'usd' }: BarChartProps) {
  const reducedMotion = usePrefersReducedMotion();
  const tickFormatter =
    yFormat === 'usd' ? (v: number) => formatUsdWhole(v) : (v: number) => String(v);
  const tooltipFormatter =
    yFormat === 'usd' ? (v: number | string) => formatUsd(Number(v)) : undefined;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <RBarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} barGap={2}>
        <CartesianGrid vertical={false} stroke={chartGridColor()} />
        <XAxis
          dataKey={xKey}
          tick={{ fill: chartTextColor(), fontSize: 12 }}
          tickLine={false}
          axisLine={{ stroke: chartGridColor() }}
        />
        <YAxis
          width={72}
          tick={{ fill: chartTextColor(), fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={tickFormatter}
        />
        <Tooltip
          cursor={{ fill: 'var(--color-surface-sunken)' }}
          contentStyle={tooltipStyle}
          formatter={tooltipFormatter}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" iconSize={8} />
        {series.map((s) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={chartColor(s.role)}
            radius={[3, 3, 0, 0]}
            maxBarSize={28}
            isAnimationActive={!reducedMotion}
          />
        ))}
      </RBarChart>
    </ResponsiveContainer>
  );
}
