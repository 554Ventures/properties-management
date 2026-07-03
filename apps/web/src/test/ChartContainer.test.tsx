// ChartContainer: "View as table" renders the same series data as a real,
// accessible <table> (ARCHITECTURE §8 chart a11y requirement).
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChartContainer } from '../components/charts/ChartContainer';

const table = {
  columns: [
    { key: 'month', label: 'Month' },
    { key: 'income', label: 'Income', align: 'right' as const, format: 'usd' as const },
    { key: 'expense', label: 'Expenses', align: 'right' as const, format: 'usd' as const },
  ],
  rows: [
    { month: 'Jun 2026', income: 1369500, expense: 916000 },
    { month: 'Jul 2026', income: 1156000, expense: 311000 },
  ],
};

function renderContainer() {
  return render(
    <ChartContainer
      title="Income vs. expenses"
      description="Monthly income and expenses for the last 2 months."
      table={table}
    >
      <div data-testid="the-chart" />
    </ChartContainer>,
  );
}

describe('ChartContainer', () => {
  it('exposes the chart as role="img" with a text alternative', () => {
    renderContainer();
    const img = screen.getByRole('img', { name: /income vs\. expenses\. monthly income/i });
    expect(img).toBeInTheDocument();
    expect(screen.getByTestId('the-chart')).toBeInTheDocument();
  });

  it('toggles to an accessible table with the same data', () => {
    renderContainer();
    fireEvent.click(screen.getByRole('button', { name: 'View as table' }));

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Income' })).toBeInTheDocument();
    expect(screen.getByText('Jun 2026')).toBeInTheDocument();
    // usd formatting via the shared money helper
    expect(screen.getByText('$13,695.00')).toBeInTheDocument();
    expect(screen.getByText('$3,110.00')).toBeInTheDocument();
    // chart is gone while the table is shown
    expect(screen.queryByTestId('the-chart')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'View as chart' }));
    expect(screen.getByTestId('the-chart')).toBeInTheDocument();
  });
});
