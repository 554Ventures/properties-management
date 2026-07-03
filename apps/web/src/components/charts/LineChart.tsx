import { formatUsd, formatUsdWhole } from '@hearth/shared';
import {
  CartesianGrid,
  Line,
  LineChart as RLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { usePrefersReducedMotion } from '../../lib/useReducedMotion';
import { chartColor, chartGridColor, chartTextColor, tooltipStyle, type ChartRole } from './chartTheme';

export interface LineSeries {
  key: string;
  label: string;
  role: ChartRole;
}

export interface LineChartProps {
  data: Record<string, string | number>[];
  xKey: string;
  series: LineSeries[];
  yFormat?: 'usd' | 'number';
}

export function LineChart({ data, xKey, series, yFormat = 'usd' }: LineChartProps) {
  const reducedMotion = usePrefersReducedMotion();
  const tickFormatter =
    yFormat === 'usd' ? (v: number) => formatUsdWhole(v) : (v: number) => String(v);
  const tooltipFormatter =
    yFormat === 'usd' ? (v: number | string) => formatUsd(Number(v)) : undefined;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <RLineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
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
        <Tooltip contentStyle={tooltipStyle} formatter={tooltipFormatter} />
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={chartColor(s.role)}
            strokeWidth={2}
            dot={{ r: 3, fill: chartColor(s.role), strokeWidth: 0 }}
            activeDot={{ r: 4 }}
            isAnimationActive={!reducedMotion}
          />
        ))}
      </RLineChart>
    </ResponsiveContainer>
  );
}
