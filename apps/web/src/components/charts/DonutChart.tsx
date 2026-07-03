import { formatUsd } from '@hearth/shared';
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { usePrefersReducedMotion } from '../../lib/useReducedMotion';
import { chartColor, tooltipStyle, type ChartRole } from './chartTheme';

export interface DonutSlice {
  name: string;
  value: number;
  role: ChartRole;
}

export interface DonutChartProps {
  data: DonutSlice[];
  /** "usd" — values are cents. */
  format?: 'usd' | 'number';
}

export function DonutChart({ data, format = 'usd' }: DonutChartProps) {
  const reducedMotion = usePrefersReducedMotion();
  const tooltipFormatter =
    format === 'usd' ? (v: number | string) => formatUsd(Number(v)) : undefined;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius="58%"
          outerRadius="85%"
          paddingAngle={2}
          isAnimationActive={!reducedMotion}
        >
          {data.map((slice) => (
            <Cell key={slice.name} fill={chartColor(slice.role)} stroke="var(--color-surface)" />
          ))}
        </Pie>
        <Tooltip contentStyle={tooltipStyle} formatter={tooltipFormatter} />
        <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" iconSize={8} />
      </PieChart>
    </ResponsiveContainer>
  );
}
