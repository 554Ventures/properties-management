// Single-series horizontal bar chart for magnitude-by-category comparison
// (e.g. NOI by property). Bars are colored by sign — positive vs. negative —
// with a zero reference line; colors come only from the chart tokens and
// animation is disabled under prefers-reduced-motion. A custom bar shape rounds
// the *tip* corner on whichever side the bar extends, so a negative (loss) bar
// rounds on its left tip rather than at the zero baseline.
import { formatUsd, formatUsdWhole } from '@hearth/shared';
import {
  Bar,
  BarChart as RBarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { usePrefersReducedMotion } from '../../lib/useReducedMotion';
import {
  chartColor,
  chartGridColor,
  chartTextColor,
  tooltipItemStyle,
  tooltipLabelStyle,
  tooltipStyle,
} from './chartTheme';

export interface HorizontalBarDatum {
  label: string;
  value: number;
}

export interface HorizontalBarChartProps {
  data: HorizontalBarDatum[];
  /** "usd" — values are cents, formatted with the shared money helpers. */
  format?: 'usd' | 'number';
  /** Accessible name for the value series (tooltip label). */
  valueLabel?: string;
}

const RADIUS = 3;

/** Rounded-rectangle path rounding only the two corners on `tip` ('left'|'right'). */
function roundedTipPath(
  x: number,
  y: number,
  width: number,
  height: number,
  tip: 'left' | 'right',
): string {
  const r = Math.max(0, Math.min(RADIUS, width, height / 2));
  if (r === 0) return `M${x},${y} h${width} v${height} h${-width} z`;
  if (tip === 'right') {
    return [
      `M${x},${y}`,
      `h${width - r}`,
      `a${r},${r} 0 0 1 ${r},${r}`,
      `v${height - 2 * r}`,
      `a${r},${r} 0 0 1 ${-r},${r}`,
      `h${-(width - r)}`,
      'z',
    ].join(' ');
  }
  return [
    `M${x + r},${y}`,
    `h${width - r}`,
    `v${height}`,
    `h${-(width - r)}`,
    `a${r},${r} 0 0 1 ${-r},${-r}`,
    `v${-(height - 2 * r)}`,
    `a${r},${r} 0 0 1 ${r},${-r}`,
    'z',
  ].join(' ');
}

// Recharts injects x/y/width/height/payload when it clones the shape element.
interface BarShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: HorizontalBarDatum;
}

function BarShape({ x = 0, y = 0, width = 0, height = 0, payload }: BarShapeProps) {
  // Normalize geometry (some Recharts versions hand back a negative width for
  // negative bars); sign of the datum — not the pixels — picks the tip side.
  let bx = x;
  let bw = width;
  if (bw < 0) {
    bx = x + bw;
    bw = -bw;
  }
  const value = payload?.value ?? 0;
  const fill = chartColor(value >= 0 ? 'positive' : 'warning');
  const tip = value >= 0 ? 'right' : 'left';
  return <path d={roundedTipPath(bx, y, bw, height, tip)} fill={fill} />;
}

export function HorizontalBarChart({
  data,
  format = 'usd',
  valueLabel = 'Value',
}: HorizontalBarChartProps) {
  const reducedMotion = usePrefersReducedMotion();
  const tickFormatter =
    format === 'usd' ? (v: number) => formatUsdWhole(v) : (v: number) => String(v);
  const tooltipFormatter =
    format === 'usd'
      ? (v: number | string) => [formatUsd(Number(v)), valueLabel] as [string, string]
      : (v: number | string) => [String(v), valueLabel] as [string, string];

  return (
    <ResponsiveContainer width="100%" height="100%">
      <RBarChart
        layout="vertical"
        data={data}
        margin={{ top: 8, right: 16, bottom: 0, left: 8 }}
      >
        <CartesianGrid horizontal={false} stroke={chartGridColor()} />
        <XAxis
          type="number"
          tick={{ fill: chartTextColor(), fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={tickFormatter}
        />
        <YAxis
          type="category"
          dataKey="label"
          width={104}
          tick={{ fill: chartTextColor(), fontSize: 12 }}
          tickLine={false}
          axisLine={{ stroke: chartGridColor() }}
        />
        <ReferenceLine x={0} stroke={chartGridColor()} />
        <Tooltip
          cursor={{ fill: 'var(--color-surface-sunken)' }}
          contentStyle={tooltipStyle}
          itemStyle={tooltipItemStyle}
          labelStyle={tooltipLabelStyle}
          formatter={tooltipFormatter}
        />
        <Bar
          dataKey="value"
          maxBarSize={28}
          isAnimationActive={!reducedMotion}
          shape={<BarShape />}
        />
      </RBarChart>
    </ResponsiveContainer>
  );
}
