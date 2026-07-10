// Type-aware report body (PRD §5.6): leads with what matters — headline KPI
// tiles from the snapshot's totals, the monthly-review bottom line and watch
// items, and a chart where the data is a trend or a comparison — then demotes
// the full detail to one clean table (the same canonical `table` snapshot the
// CSV export uses). Unknown/legacy snapshot shapes fall back to the generic
// ReportData renderer so nothing is ever unrenderable.
import type { ReactNode } from 'react';
import { formatUsd, formatUsdWhole, type ReportType } from '@hearth/shared';
import { BarChart } from '../charts/BarChart';
import { ChartContainer } from '../charts/ChartContainer';
import { HorizontalBarChart } from '../charts/HorizontalBarChart';
import { Card } from '../ui/Card';
import { IconCheck, IconAlertTriangle } from '../ui/icons';
import { KpiTile } from '../ui/KpiTile';
import { StatusBadge, type BadgeTone } from '../ui/StatusBadge';
import { Table, Td, Th, Tr } from '../ui/Table';
import { formatDate, formatMonth, humanizeKey } from '../../lib/format';
import { ReportData } from './ReportData';

// ── defensive access into the untyped snapshot ───────────────────────────────

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objAt(source: Obj, key: string): Obj {
  const value = source[key];
  return isObj(value) ? value : {};
}

function numAt(source: Obj, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rowsAt(source: Obj, key: string): Obj[] {
  const value = source[key];
  return Array.isArray(value) ? value.filter(isObj) : [];
}

// ── headline tiles ───────────────────────────────────────────────────────────

interface Tile {
  label: string;
  value: string;
  ariaLabel: string;
  tone?: 'positive' | 'danger';
  sub?: string;
}

/** Money tile; a negative value gets the danger tone (the minus sign carries
 * the meaning — color is reinforcement only). Null cents → no tile. */
function moneyTile(label: string, cents: number | null, sub?: string): Tile | null {
  if (cents === null) return null;
  return {
    label,
    value: formatUsdWhole(cents),
    ariaLabel: `${label}, ${formatUsd(cents)}`,
    tone: cents < 0 ? 'danger' : undefined,
    sub,
  };
}

function countTile(label: string, count: number | null): Tile | null {
  if (count === null) return null;
  return { label, value: String(count), ariaLabel: `${label}, ${count}` };
}

function netTiles(totals: Obj, netLabel: string, incomeLabel = 'Income'): Array<Tile | null> {
  return [
    moneyTile(netLabel, numAt(totals, 'netCents')),
    moneyTile(incomeLabel, numAt(totals, 'incomeCents')),
    moneyTile('Expenses', numAt(totals, 'expenseCents')),
  ];
}

function buildTiles(type: ReportType, data: Obj): Tile[] {
  const totals = objAt(data, 'totals');
  const candidates: Array<Tile | null> = (() => {
    switch (type) {
      case 'pnl':
      case 'income_statement':
        return netTiles(totals, 'Net');
      case 'net_cashflow':
        return netTiles(totals, 'Net cash flow');
      case 'general_ledger':
        return [...netTiles(totals, 'Net'), countTile('Transactions', numAt(totals, 'count'))];
      case 'monthly_review':
        return netTiles(totals, 'Net this month', 'Collected');
      case 'schedule_e': {
        return [
          moneyTile('Net', numAt(totals, 'netCents')),
          moneyTile('Rents received', numAt(totals, 'rentsReceivedCents')),
          moneyTile('Total expenses', numAt(totals, 'totalExpensesCents')),
        ];
      }
      case 'tax_package': {
        const scheduleETotals = objAt(data, 'scheduleETotals');
        return [
          moneyTile('Net', numAt(scheduleETotals, 'netCents')),
          moneyTile('Rents received', numAt(scheduleETotals, 'rentsReceivedCents')),
          moneyTile('Total expenses', numAt(scheduleETotals, 'totalExpensesCents')),
          countTile('Properties', numAt(data, 'propertyCount')),
        ];
      }
      case 'rent_roll': {
        const rentCents = numAt(totals, 'monthlyRentCents');
        const leases = numAt(totals, 'leaseCount');
        return [
          moneyTile('Monthly rent', rentCents),
          countTile('Active leases', leases),
          moneyTile(
            'Average rent',
            rentCents !== null && leases !== null && leases > 0
              ? Math.round(rentCents / leases)
              : null,
          ),
        ];
      }
      case 'tenant_ledger': {
        const charged = numAt(totals, 'chargedCents');
        const collected = numAt(totals, 'collectedCents');
        const rate =
          charged !== null && collected !== null && charged > 0
            ? Math.round((collected / charged) * 100)
            : null;
        return [
          moneyTile('Collected', collected),
          moneyTile('Charged', charged),
          rate === null
            ? null
            : {
                label: 'Collection rate',
                value: `${rate}%`,
                ariaLabel: `Collection rate, ${rate} percent of charged rent collected`,
              },
        ];
      }
      case 'balance_sheet':
        return [
          moneyTile('Total assets', numAt(totals, 'totalAssetsCents')),
          moneyTile('Liabilities', numAt(totals, 'totalLiabilitiesCents')),
          moneyTile('Equity', numAt(totals, 'equityCents')),
        ];
      case 'reo_schedule':
        return [
          moneyTile('Total cost basis', numAt(totals, 'acquisitionCostCents')),
          moneyTile('Monthly rent', numAt(totals, 'monthlyRentCents')),
        ];
      case 'capital_expenses':
        return [moneyTile('Capital spend', numAt(totals, 'totalCents'))];
      case 'escrow_ledger':
        return [moneyTile('Escrow balance', numAt(totals, 'balanceCents'))];
      case 'stress_test': {
        const baseNet = numAt(objAt(data, 'base'), 'netCents');
        return rowsAt(data, 'scenarios').map((s) => {
          const net = numAt(s, 'netCents');
          const label = typeof s.scenario === 'string' ? s.scenario : 'Scenario';
          const isBase = net !== null && baseNet !== null && net === baseNet;
          return moneyTile(
            label,
            net,
            !isBase && net !== null && baseNet !== null
              ? `${formatUsdWhole(net - baseNet)} vs. base`
              : undefined,
          );
        });
      }
      default:
        // Unknown type: derive tiles generically from whatever totals exist.
        return Object.entries(totals).map(([key, value]) =>
          typeof value !== 'number'
            ? null
            : /cents$/i.test(key)
              ? moneyTile(humanizeKey(key), value)
              : countTile(humanizeKey(key), value),
        );
    }
  })();
  return candidates.filter((t): t is Tile => t !== null);
}

// ── narrative blocks ─────────────────────────────────────────────────────────

function WatchItems({ items }: { items: string[] }) {
  if (items.length === 0) {
    return (
      <Card>
        <p className="flex items-center gap-2 text-sm text-ink">
          <span className="text-positive">
            <IconCheck size={16} />
          </span>
          Nothing needs your attention this period.
        </p>
      </Card>
    );
  }
  return (
    <Card className="bg-warning-soft">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-warning">
          <IconAlertTriangle size={16} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-ink">Worth your attention</h2>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-sm leading-relaxed text-ink">
            {items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

// ── charts (net cash flow trend, monthly-review property comparison) ─────────

function CashflowChart({ months }: { months: Obj[] }) {
  const rows = months.map((m) => ({
    month: typeof m.month === 'string' ? formatMonth(m.month) : '',
    income: numAt(m, 'incomeCents') ?? 0,
    expense: numAt(m, 'expenseCents') ?? 0,
    net: numAt(m, 'netCents') ?? 0,
  }));
  return (
    <ChartContainer
      title="Cash flow by month"
      description={`Monthly income, expenses and net for the report period. ${rows
        .map((r) => `${r.month}: income ${formatUsdWhole(r.income)}, expenses ${formatUsdWhole(r.expense)}, net ${formatUsdWhole(r.net)}`)
        .join('; ')}.`}
      headingLevel={2}
      table={{
        columns: [
          { key: 'month', label: 'Month' },
          { key: 'income', label: 'Income', align: 'right', format: 'usd' },
          { key: 'expense', label: 'Expenses', align: 'right', format: 'usd' },
          { key: 'net', label: 'Net', align: 'right', format: 'usd' },
        ],
        rows,
      }}
    >
      <BarChart
        data={rows}
        xKey="month"
        series={[
          { key: 'income', label: 'Income', role: 'positive' },
          { key: 'expense', label: 'Expenses', role: 'warning' },
        ]}
      />
    </ChartContainer>
  );
}

function PropertyNetChart({ nets }: { nets: Obj[] }) {
  const rows = nets.map((n) => ({
    label: typeof n.propertyLabel === 'string' ? n.propertyLabel : '—',
    value: numAt(n, 'netCents') ?? 0,
  }));
  return (
    <ChartContainer
      title="Net by property"
      description={`Net cash flow per property this month. ${rows
        .map((r) => `${r.label}: ${formatUsdWhole(r.value)}`)
        .join('; ')}.`}
      headingLevel={2}
      table={{
        columns: [
          { key: 'label', label: 'Property' },
          { key: 'value', label: 'Net', align: 'right', format: 'usd' },
        ],
        rows,
      }}
    >
      <HorizontalBarChart data={rows} valueLabel="Net" />
    </ChartContainer>
  );
}

// ── detail table (the canonical `table` snapshot — same data the CSV exports) ─

interface SnapshotColumn {
  key: string;
  label: string;
}

interface SnapshotTable {
  columns: SnapshotColumn[];
  rows: Obj[];
}

export function extractSnapshotTable(data: unknown): SnapshotTable | null {
  if (!isObj(data) || !isObj(data.table)) return null;
  const { columns, rows } = data.table;
  if (!Array.isArray(columns) || !Array.isArray(rows)) return null;
  const cleanColumns = columns.filter(
    (c): c is SnapshotColumn => isObj(c) && typeof c.key === 'string' && typeof c.label === 'string',
  );
  if (cleanColumns.length === 0) return null;
  return { columns: cleanColumns, rows: rows.filter(isObj) };
}

const RENT_STATUS_BADGE: Record<string, { tone: BadgeTone; label: string; icon?: 'clock' }> = {
  paid: { tone: 'positive', label: 'Paid' },
  due: { tone: 'neutral', label: 'Due' },
  processing: { tone: 'neutral', label: 'Processing', icon: 'clock' },
  failed: { tone: 'danger', label: 'Failed' },
  late: { tone: 'danger', label: 'Late' },
};

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
}

function detailCell(column: SnapshotColumn, value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return '—';
  if (column.key === 'status' && typeof value === 'string') {
    const badge = RENT_STATUS_BADGE[value];
    return (
      <StatusBadge tone={badge?.tone ?? 'neutral'} icon={badge?.icon}>
        {badge?.label ?? humanizeKey(value)}
      </StatusBadge>
    );
  }
  if (typeof value === 'number') return /cents$/i.test(column.key) ? formatUsd(value) : String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') {
    if (isIsoDate(value)) return formatDate(value);
    if (column.key === 'type') return humanizeKey(value);
    return value;
  }
  return String(value);
}

function DetailTable({ table, caption }: { table: SnapshotTable; caption: string }) {
  if (table.rows.length === 0) {
    return (
      <Card>
        <h2 className="text-sm font-semibold text-ink">Detail</h2>
        <p className="mt-1 text-sm text-ink-muted">No rows in this period.</p>
      </Card>
    );
  }
  const rightAligned = new Set(
    table.columns
      .filter(
        (c) =>
          /cents$/i.test(c.key) || table.rows.every((r) => r[c.key] == null || typeof r[c.key] === 'number'),
      )
      .map((c) => c.key),
  );
  return (
    <Card flush>
      <Table caption={caption} captionVisible>
        <thead>
          <tr>
            {table.columns.map((c) => (
              <Th key={c.key} align={rightAligned.has(c.key) ? 'right' : 'left'}>
                {c.label.replace(/\s*\(cents\)$/i, '')}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <Tr key={i}>
              {table.columns.map((c) => (
                <Td key={c.key} align={rightAligned.has(c.key) ? 'right' : 'left'}>
                  {detailCell(c, row[c.key])}
                </Td>
              ))}
            </Tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

/** Schedule E only: the per-property IRS expense-line breakdown that the
 * summary table (per-property totals) flattens away. */
function ScheduleELines({ data }: { data: Obj }) {
  const lineNumber = (line: string) => Number(/line (\d+)/i.exec(line)?.[1] ?? 99);
  const rows = rowsAt(data, 'propertyRows').flatMap((property) => {
    const label = typeof property.propertyLabel === 'string' ? property.propertyLabel : '—';
    return Object.entries(isObj(property.expenseLines) ? property.expenseLines : {})
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      .sort((a, b) => lineNumber(a[0]) - lineNumber(b[0]))
      .map(([line, cents]) => ({ label, line, cents }));
  });
  if (rows.length === 0) return null;
  return (
    <Card flush>
      <Table caption="IRS expense line detail" captionVisible>
        <thead>
          <tr>
            <Th>Property</Th>
            <Th>IRS line</Th>
            <Th align="right">Amount</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <Tr key={i}>
              <Td>{row.label}</Td>
              <Td>{row.line}</Td>
              <Td align="right">{formatUsd(row.cents)}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

// ── the body ─────────────────────────────────────────────────────────────────

export interface ReportBodyProps {
  type: ReportType;
  data: unknown;
  title: string;
}

export function ReportBody({ type, data, title }: ReportBodyProps) {
  const snapshot = isObj(data) ? data : {};
  const tiles = buildTiles(type, snapshot);
  const table = extractSnapshotTable(snapshot);
  const bottomLine = typeof snapshot.bottomLine === 'string' ? snapshot.bottomLine : null;
  const watchItems = Array.isArray(snapshot.watchItems)
    ? snapshot.watchItems.filter((item): item is string => typeof item === 'string')
    : null;
  const note = typeof snapshot.note === 'string' ? snapshot.note : null;

  const months = type === 'net_cashflow' ? rowsAt(snapshot, 'months') : [];
  const propertyNets = type === 'monthly_review' ? rowsAt(snapshot, 'propertyNets') : [];
  const showCashflowChart = months.length >= 2;
  const showPropertyNetChart = propertyNets.length >= 2;
  // The chart's built-in "view as table" already shows the snapshot table's
  // exact rows for these two types — don't render the same table twice.
  const chartCoversTable = showCashflowChart || showPropertyNetChart;

  // Nothing recognizable (e.g. a legacy snapshot) — generic renderer.
  if (tiles.length === 0 && !table && !bottomLine) {
    return (
      <Card>
        <ReportData data={data} caption={title} />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {bottomLine && (
        <Card>
          <p className="text-base leading-relaxed text-ink sm:text-lg">{bottomLine}</p>
        </Card>
      )}

      {tiles.length > 0 && (
        <section
          aria-label="Report highlights"
          className="grid grid-cols-1 gap-4 sm:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]"
        >
          {tiles.map((tile) => (
            <KpiTile
              key={tile.label}
              label={tile.label}
              value={tile.value}
              ariaLabel={tile.ariaLabel}
              tone={tile.tone}
            >
              {tile.sub && <p className="text-xs text-ink-muted">{tile.sub}</p>}
            </KpiTile>
          ))}
        </section>
      )}

      {watchItems !== null && <WatchItems items={watchItems} />}

      {note && (
        <Card className="bg-surface-sunken">
          <p className="text-sm leading-relaxed text-ink-muted">{note}</p>
        </Card>
      )}

      {showCashflowChart && <CashflowChart months={months} />}
      {showPropertyNetChart && <PropertyNetChart nets={propertyNets} />}

      {table && !chartCoversTable && <DetailTable table={table} caption={`Detail — ${title}`} />}
      {type === 'schedule_e' && <ScheduleELines data={snapshot} />}
    </div>
  );
}
