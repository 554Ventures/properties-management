// Generic, defensive renderer for Report.dataJson snapshots. The contract
// types `ReportDetailResponse.data` as `unknown` (shape varies by type), so
// this renders any JSON as accessible tables/sections: arrays of objects →
// <table> (with *Cents fields formatted via formatUsd and right-aligned),
// nested objects → labelled sections, primitives → definition rows.
import type { ReactNode } from 'react';
import { formatUsd } from '@hearth/shared';
import { formatDate, humanizeKey } from '../../lib/format';
import { Table, Td, Th, Tr } from '../ui/Table';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function isCentsKey(key: string): boolean {
  return /cents$/i.test(key);
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
}

function isPlainObject(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatValue(key: string, value: Json | undefined): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return isCentsKey(key) ? formatUsd(value) : String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return isIsoDate(value) ? formatDate(value) : value;
  return JSON.stringify(value);
}

function isPrimitive(value: Json | undefined): boolean {
  return value === null || value === undefined || typeof value !== 'object';
}

function ObjectTable({ rows, caption }: { rows: Record<string, Json>[]; caption: string }) {
  const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).filter(
    (key) => !/^(id|.*Id)$/.test(key),
  );
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          {keys.map((key) => (
            <Th key={key} align={rows.some((r) => typeof r[key] === 'number') ? 'right' : 'left'}>
              {humanizeKey(key)}
            </Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <Tr key={i}>
            {keys.map((key) => (
              <Td key={key} align={typeof row[key] === 'number' ? 'right' : 'left'}>
                {isPrimitive(row[key]) ? (
                  formatValue(key, row[key])
                ) : (
                  <ReportData data={row[key]} caption={humanizeKey(key)} level={4} />
                )}
              </Td>
            ))}
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

export interface ReportDataProps {
  data: unknown;
  caption?: string;
  level?: 2 | 3 | 4;
}

export function ReportData({ data, caption = 'Report data', level = 2 }: ReportDataProps): ReactNode {
  const value = data as Json | undefined;

  if (value === null || value === undefined) {
    return <p className="text-sm text-ink-muted">No data in this report.</p>;
  }

  if (isPrimitive(value)) {
    return <p className="text-sm leading-relaxed text-ink">{formatValue(caption, value)}</p>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <p className="text-sm text-ink-muted">No rows.</p>;
    if (value.every(isPlainObject)) {
      return <ObjectTable rows={value as Record<string, Json>[]} caption={caption} />;
    }
    return (
      <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
        {value.map((item, i) => (
          <li key={i}>{isPrimitive(item) ? formatValue('', item) : JSON.stringify(item)}</li>
        ))}
      </ul>
    );
  }

  // Plain object: primitive entries become a key/value table; nested
  // arrays/objects become labelled sections.
  const entries = Object.entries(value as Record<string, Json>).filter(
    ([key]) => !/^(id|.*Id)$/.test(key),
  );
  const primitives = entries.filter(([, v]) => isPrimitive(v));
  const complex = entries.filter(([, v]) => !isPrimitive(v));
  const Heading = level === 2 ? 'h2' : level === 3 ? 'h3' : 'h4';

  return (
    <div className="flex flex-col gap-6">
      {primitives.length > 0 && (
        <Table caption={`${caption} — summary`}>
          <tbody>
            {primitives.map(([key, v]) => (
              <Tr key={key}>
                <Th scope="row" className="w-1/2 normal-case tracking-normal">
                  {humanizeKey(key)}
                </Th>
                <Td align={typeof v === 'number' ? 'right' : 'left'}>{formatValue(key, v)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {complex.map(([key, v]) => (
        <section key={key}>
          <Heading className="mb-2 text-sm font-semibold text-ink">{humanizeKey(key)}</Heading>
          <ReportData data={v} caption={humanizeKey(key)} level={level < 4 ? ((level + 1) as 3 | 4) : 4} />
        </section>
      ))}
    </div>
  );
}
