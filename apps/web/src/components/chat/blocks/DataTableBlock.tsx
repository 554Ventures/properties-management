// data_table block → the real, semantic Table primitives (§9.3: never an
// ASCII-art approximation). usd/date formatting via the shared helpers.
import type {
  DataTableBlock as DataTableBlockData,
  DataTableColumn,
} from '@hearth/shared';
import { formatUsd } from '@hearth/shared';
import { formatDate } from '../../../lib/format';
import { Table, Td, Th, Tr } from '../../ui/Table';

function formatCell(column: DataTableColumn, value: string | number | undefined): string {
  if (value === undefined || value === null) return '—';
  if (column.format === 'usd' && typeof value === 'number') return formatUsd(value);
  if (column.format === 'date' && typeof value === 'string') return formatDate(value);
  return String(value);
}

export function DataTableBlock({ block }: { block: DataTableBlockData }) {
  return (
    <div className="rounded-md border border-border bg-surface">
      <Table
        caption={block.title ?? 'Data from the Hearth assistant'}
        captionVisible={Boolean(block.title)}
        className={block.title ? '[&>caption]:px-4' : undefined}
      >
        <thead>
          <tr>
            {block.columns.map((column) => (
              <Th key={column.key} align={column.align}>
                {column.label}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, i) => (
            <Tr key={i}>
              {block.columns.map((column) => (
                <Td key={column.key} align={column.align}>
                  {formatCell(column, row[column.key])}
                </Td>
              ))}
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
