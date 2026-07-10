// ReportBody leads with headline tiles/callouts instead of a raw table dump;
// fixtures mirror the exact snapshot shapes report.service.ts produces.
import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { ReportBody } from '../components/reports/ReportBody';
import { formatDate } from '../lib/format';

const pnlData = {
  lines: [
    { categoryName: 'Rent', type: 'income', totalCents: 1369500 },
    { categoryName: 'Repairs', type: 'expense', totalCents: 48000 },
  ],
  totals: { incomeCents: 1369500, expenseCents: 48000, netCents: 1321500 },
  table: {
    columns: [
      { key: 'type', label: 'Type' },
      { key: 'categoryName', label: 'Category' },
      { key: 'totalCents', label: 'Total (cents)' },
    ],
    rows: [
      { categoryName: 'Rent', type: 'income', totalCents: 1369500 },
      { categoryName: 'Repairs', type: 'expense', totalCents: 48000 },
    ],
  },
};

describe('ReportBody', () => {
  it('renders P&L totals as headline tiles ahead of the detail table', () => {
    render(<ReportBody type="pnl" data={pnlData} title="Profit & Loss — 2026" />);
    expect(screen.getByRole('group', { name: 'Net, $13,215.00' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Income, $13,695.00' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Expenses, $480.00' })).toBeInTheDocument();
    // Detail table: header label loses the "(cents)" suffix, values formatted.
    expect(screen.getByRole('columnheader', { name: 'Total' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '$480.00' })).toBeInTheDocument();
  });

  it('tones a negative net as danger (minus sign carries the meaning)', () => {
    render(
      <ReportBody
        type="pnl"
        data={{ ...pnlData, totals: { incomeCents: 100, expenseCents: 200, netCents: -100 } }}
        title="Profit & Loss"
      />,
    );
    const tile = screen.getByRole('group', { name: 'Net, -$1.00' });
    expect(tile).toHaveTextContent('-$1');
  });

  it('renders the monthly review bottom line and watch items callout', () => {
    render(
      <ReportBody
        type="monthly_review"
        data={{
          period: '2026-06',
          bottomLine: 'You netted $4,530 in June 2026 — $13,695 collected against $9,165 in expenses.',
          totals: { incomeCents: 1369500, expenseCents: 916500, netCents: 453000 },
          propertyNets: [{ propertyLabel: '88 Oak Ave', units: 2, netCents: 453000 }],
          watchItems: ['Repairs ran $1,200 in June 2026 vs a $400 three-month average.'],
          table: {
            columns: [
              { key: 'propertyLabel', label: 'Property' },
              { key: 'units', label: 'Units' },
              { key: 'netCents', label: 'Net (cents)' },
            ],
            rows: [{ propertyLabel: '88 Oak Ave', units: 2, netCents: 453000 }],
          },
        }}
        title="Monthly review — June 2026"
      />,
    );
    expect(screen.getByText(/You netted \$4,530 in June 2026/)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Worth your attention' })).toBeInTheDocument();
    expect(screen.getByText(/Repairs ran \$1,200/)).toBeVisible();
  });

  it('shows the all-clear line when a review has no watch items', () => {
    render(
      <ReportBody
        type="monthly_review"
        data={{
          bottomLine: 'You netted $4,530 in June 2026.',
          totals: { incomeCents: 1369500, expenseCents: 916500, netCents: 453000 },
          propertyNets: [],
          watchItems: [],
        }}
        title="Monthly review"
      />,
    );
    expect(screen.getByText('Nothing needs your attention this period.')).toBeVisible();
  });

  it('replaces the duplicate detail table with the chart for net cash flow', () => {
    render(
      <ReportBody
        type="net_cashflow"
        data={{
          months: [
            { month: '2026-05', incomeCents: 1369500, expenseCents: 924000, netCents: 445500 },
            { month: '2026-06', incomeCents: 1369500, expenseCents: 916500, netCents: 453000 },
          ],
          totals: { incomeCents: 2739000, expenseCents: 1840500, netCents: 898500 },
          table: {
            columns: [{ key: 'month', label: 'Month' }],
            rows: [{ month: '2026-05' }, { month: '2026-06' }],
          },
        }}
        title="Net Cash Flow — 2026"
      />,
    );
    expect(screen.getByRole('img', { name: /Cash flow by month/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View as table' })).toBeInTheDocument();
    // The chart's table toggle covers the rows — no second "Detail" table.
    expect(screen.queryByText('Detail — Net Cash Flow — 2026')).not.toBeInTheDocument();
  });

  it('renders tenant ledger statuses as icon+text badges with a collection-rate tile', () => {
    render(
      <ReportBody
        type="tenant_ledger"
        data={{
          rows: [],
          totals: { chargedCents: 200000, collectedCents: 150000 },
          table: {
            columns: [
              { key: 'tenantName', label: 'Tenant' },
              { key: 'dueDate', label: 'Due date' },
              { key: 'amountCents', label: 'Amount (cents)' },
              { key: 'status', label: 'Status' },
            ],
            rows: [
              {
                tenantName: 'Maya Chen',
                dueDate: '2026-06-01T00:00:00.000Z',
                amountCents: 100000,
                status: 'paid',
              },
              {
                tenantName: 'Ray Alvarez',
                dueDate: '2026-06-01T00:00:00.000Z',
                amountCents: 100000,
                status: 'late',
              },
            ],
          },
        }}
        title="Tenant Ledger"
      />,
    );
    expect(
      screen.getByRole('group', { name: 'Collection rate, 75 percent of charged rent collected' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeVisible();
    expect(screen.getByText('Late')).toBeVisible();
    // Dates render through formatDate (local-timezone display, same as the app).
    expect(
      screen.getAllByRole('cell', { name: formatDate('2026-06-01T00:00:00.000Z') }).length,
    ).toBeGreaterThan(0);
  });

  it('renders the Schedule E IRS line breakdown alongside the per-property table', () => {
    render(
      <ReportBody
        type="schedule_e"
        data={{
          propertyRows: [
            {
              propertyId: 'p1',
              propertyLabel: '88 Oak Ave',
              rentsReceivedCents: 1369500,
              expenseLines: { 'Line 14 – Repairs': 48000, 'Line 9 – Insurance': 78000 },
              totalExpensesCents: 126000,
              netCents: 1243500,
            },
          ],
          totals: { rentsReceivedCents: 1369500, totalExpensesCents: 126000, netCents: 1243500 },
          disclaimer: 'Estimate for tax preparation only.',
          table: {
            columns: [
              { key: 'propertyLabel', label: 'Property' },
              { key: 'netCents', label: 'Net (cents)' },
            ],
            rows: [{ propertyLabel: '88 Oak Ave', netCents: 1243500 }],
          },
        }}
        title="Schedule E — 2026"
      />,
    );
    expect(screen.getByText('IRS expense line detail')).toBeInTheDocument();
    // Sorted by line number: 9 before 14.
    const lines = screen.getAllByRole('cell', { name: /Line \d+/ }).map((c) => c.textContent);
    expect(lines).toEqual(['Line 9 – Insurance', 'Line 14 – Repairs']);
  });

  it('falls back to the generic renderer for unrecognized snapshots', () => {
    render(<ReportBody type="pnl" data={{ someField: 'value' }} title="Custom" />);
    expect(screen.getByText('Some field')).toBeInTheDocument();
  });

  it('says so when a report has no rows', () => {
    render(
      <ReportBody
        type="escrow_ledger"
        data={{
          note: 'No escrow accounts are configured in v1.',
          totals: { balanceCents: 0 },
          table: { columns: [{ key: 'date', label: 'Date' }], rows: [] },
        }}
        title="Escrow Ledger"
      />,
    );
    expect(screen.getByText('No escrow accounts are configured in v1.')).toBeVisible();
    expect(screen.getByText('No rows in this period.')).toBeVisible();
  });

  it('has no axe violations on a representative report body', async () => {
    const { container } = render(
      <main>
        <h1>Profit &amp; Loss — 2026</h1>
        <ReportBody type="pnl" data={pnlData} title="Profit & Loss — 2026" />
      </main>,
    );
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});
