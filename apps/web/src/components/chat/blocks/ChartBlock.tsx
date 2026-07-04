// Chart block → the app's real chart components inside ChartContainer, so
// assistant charts get the identical a11y treatment (required description,
// role="img", "View as table" toggle) and the token-only colorRole mapping.
import type { ChartBlock as ChartBlockData } from '@hearth/shared';
import { BarChart } from '../../charts/BarChart';
import { ChartContainer, type ChartTableData } from '../../charts/ChartContainer';
import { DonutChart, type DonutSlice } from '../../charts/DonutChart';
import { LineChart } from '../../charts/LineChart';
import { Sparkline } from '../../charts/Sparkline';

const CHART_HEIGHT = 200; // compact inside the drawer transcript

interface Prepared {
  chart: JSX.Element;
  table: ChartTableData;
}

function prepare(block: ChartBlockData): Prepared {
  const isUsd = block.yUnit === 'usd';
  const yFormat = isUsd ? ('usd' as const) : ('number' as const);
  const cellFormat = isUsd ? ('usd' as const) : ('text' as const);

  if (block.kind === 'donut') {
    // One slice per series (summed); a single series donuts by point instead.
    const first = block.series[0];
    const slices: DonutSlice[] =
      block.series.length > 1
        ? block.series.map((s) => ({
            name: s.label,
            value: s.points.reduce((sum, p) => sum + p.y, 0),
            role: s.colorRole,
          }))
        : (first?.points ?? []).map((p) => ({
            name: p.x,
            value: p.y,
            role: first?.colorRole ?? 'neutral',
          }));
    return {
      chart: <DonutChart data={slices} format={yFormat} />,
      table: {
        columns: [
          { key: 'name', label: 'Label' },
          { key: 'value', label: 'Value', align: 'right', format: cellFormat },
        ],
        rows: slices.map((s) => ({ name: s.name, value: s.value })),
      },
    };
  }

  if (block.kind === 'sparkline') {
    const first = block.series[0];
    return {
      chart: (
        <Sparkline
          points={(first?.points ?? []).map((p) => p.y)}
          role={first?.colorRole ?? 'neutral'}
          height={CHART_HEIGHT}
        />
      ),
      table: {
        columns: [
          { key: 'x', label: 'Label' },
          { key: 'y', label: first?.label ?? 'Value', align: 'right', format: cellFormat },
        ],
        rows: (first?.points ?? []).map((p) => ({ x: p.x, y: p.y })),
      },
    };
  }

  // line / bar — merge series points by x value.
  const xValues: string[] = [];
  for (const series of block.series) {
    for (const point of series.points) {
      if (!xValues.includes(point.x)) xValues.push(point.x);
    }
  }
  const data = xValues.map((x) => {
    const row: Record<string, string | number> = { x };
    block.series.forEach((series, i) => {
      const point = series.points.find((p) => p.x === x);
      if (point) row[`s${i}`] = point.y;
    });
    return row;
  });
  const seriesConfig = block.series.map((series, i) => ({
    key: `s${i}`,
    label: series.label,
    role: series.colorRole,
  }));
  const table: ChartTableData = {
    columns: [
      { key: 'x', label: 'Label' },
      ...seriesConfig.map((s) => ({
        key: s.key,
        label: s.label,
        align: 'right' as const,
        format: cellFormat,
      })),
    ],
    rows: data,
  };
  return {
    chart:
      block.kind === 'bar' ? (
        <BarChart data={data} xKey="x" series={seriesConfig} yFormat={yFormat} />
      ) : (
        <LineChart data={data} xKey="x" series={seriesConfig} yFormat={yFormat} />
      ),
    table,
  };
}

export function ChartBlock({ block }: { block: ChartBlockData }) {
  const { chart, table } = prepare(block);
  return (
    <ChartContainer
      title={block.title}
      description={block.description}
      table={table}
      height={CHART_HEIGHT}
      headingLevel={3}
    >
      {chart}
    </ChartContainer>
  );
}
