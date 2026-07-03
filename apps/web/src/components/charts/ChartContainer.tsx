// Accessible chart wrapper (ARCHITECTURE §8): required title + description
// (visually hidden), role="img" + aria-label on the chart region, and a
// "View as table" toggle rendering the same data as a real <table>.
import { useId, useState, type ReactNode } from 'react';
import { formatUsd } from '@hearth/shared';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Table, Td, Th, Tr } from '../ui/Table';

export interface ChartTableColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
  /** "usd" formats numeric cents via formatUsd. */
  format?: 'usd' | 'text';
}

export interface ChartTableData {
  columns: ChartTableColumn[];
  rows: Record<string, string | number>[];
}

export interface ChartContainerProps {
  title: string;
  /** Required text alternative describing what the chart shows. */
  description: string;
  /** The same data the chart renders, as an accessible table. */
  table: ChartTableData;
  height?: number;
  headingLevel?: 2 | 3;
  children: ReactNode;
}

function formatCell(column: ChartTableColumn, value: string | number | undefined): string {
  if (value === undefined || value === null) return '—';
  if (column.format === 'usd' && typeof value === 'number') return formatUsd(value);
  return String(value);
}

export function ChartContainer({
  title,
  description,
  table,
  height = 260,
  headingLevel = 2,
  children,
}: ChartContainerProps) {
  const [showTable, setShowTable] = useState(false);
  const descId = useId();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';

  return (
    <Card>
      <div className="mb-4 flex items-start justify-between gap-3">
        <Heading className="text-sm font-semibold text-ink">{title}</Heading>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={showTable}
          onClick={() => setShowTable((v) => !v)}
        >
          {showTable ? 'View as chart' : 'View as table'}
        </Button>
      </div>
      <p id={descId} className="sr-only">
        {description}
      </p>
      {showTable ? (
        <div style={{ minHeight: height }} className="overflow-y-auto">
          <Table caption={`${title} — data table`}>
            <thead>
              <tr>
                {table.columns.map((col) => (
                  <Th key={col.key} align={col.align}>
                    {col.label}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <Tr key={i}>
                  {table.columns.map((col) => (
                    <Td key={col.key} align={col.align}>
                      {formatCell(col, row[col.key])}
                    </Td>
                  ))}
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : (
        <div
          role="img"
          aria-label={`${title}. ${description}`}
          aria-describedby={descId}
          style={{ height }}
        >
          {children}
        </div>
      )}
    </Card>
  );
}
