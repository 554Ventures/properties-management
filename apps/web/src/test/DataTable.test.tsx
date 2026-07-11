// DataTable — searching, per-header sort, per-header filters, pagination, and a
// zero-axe-violations check with a filter popover open.
import { fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  DataTable,
  emptyDataTableState,
  type DataTableColumn,
  type DataTableState,
} from '../components/ui/DataTable';

interface Row {
  id: string;
  name: string;
  city: string;
  units: number;
  rentCents: number;
  status: string;
}

const rows: Row[] = [
  { id: '1', name: 'Cedar Court', city: 'Portland', units: 3, rentCents: 150000, status: 'Full' },
  { id: '2', name: 'Aspen Flats', city: 'Denver', units: 1, rentCents: 90000, status: 'Vacant' },
  { id: '3', name: 'Birch Lane', city: 'Austin', units: 6, rentCents: 320000, status: 'Full' },
  { id: '4', name: 'Dogwood Row', city: 'Reno', units: 2, rentCents: 110000, status: 'Vacant' },
];

const columns: DataTableColumn<Row>[] = [
  {
    id: 'name',
    header: 'Name',
    sortAccessor: (r) => r.name,
    filter: { kind: 'text', accessor: (r) => r.name },
    searchAccessor: (r) => `${r.name} ${r.city}`,
    cell: (r) => r.name,
  },
  {
    id: 'units',
    header: 'Units',
    sortAccessor: (r) => r.units,
    filter: { kind: 'number', accessor: (r) => r.units },
    cell: (r) => r.units,
  },
  {
    id: 'rent',
    header: 'Rent',
    align: 'right',
    sortAccessor: (r) => r.rentCents,
    cell: (r) => `$${r.rentCents / 100}`,
  },
  {
    id: 'status',
    header: 'Status',
    sortAccessor: (r) => r.status,
    filter: { kind: 'select', accessor: (r) => r.status },
    cell: (r) => r.status,
  },
];

function renderTable(pageSize = 0) {
  return render(
    <DataTable
      caption="Test properties"
      columns={columns}
      data={rows}
      rowKey={(r) => r.id}
      pageSize={pageSize}
    />,
  );
}

// The names in the order the body currently renders them.
function bodyNames(): string[] {
  const bodyRows = screen.getAllByRole('row').slice(1); // drop the header row
  return bodyRows.map((r) => within(r).getAllByRole('cell')[0]?.textContent ?? '');
}

describe('DataTable', () => {
  it('renders every row by default', () => {
    renderTable();
    expect(bodyNames()).toEqual(['Cedar Court', 'Aspen Flats', 'Birch Lane', 'Dogwood Row']);
  });

  it('global search filters across the opted-in columns', () => {
    renderTable();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'denver' } });
    // Aspen Flats is in Denver (matched via its searchAccessor city).
    expect(bodyNames()).toEqual(['Aspen Flats']);
  });

  it('sorts a column ascending, then descending, then off', () => {
    renderTable();
    const nameHeader = screen.getByRole('button', { name: 'Name' });

    fireEvent.click(nameHeader); // asc
    expect(bodyNames()).toEqual(['Aspen Flats', 'Birch Lane', 'Cedar Court', 'Dogwood Row']);
    expect(screen.getByRole('columnheader', { name: /name/i })).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.click(nameHeader); // desc
    expect(bodyNames()).toEqual(['Dogwood Row', 'Cedar Court', 'Birch Lane', 'Aspen Flats']);
    expect(screen.getByRole('columnheader', { name: /name/i })).toHaveAttribute('aria-sort', 'descending');

    fireEvent.click(nameHeader); // off — back to source order
    expect(bodyNames()).toEqual(['Cedar Court', 'Aspen Flats', 'Birch Lane', 'Dogwood Row']);
    expect(screen.getByRole('columnheader', { name: /name/i })).toHaveAttribute('aria-sort', 'none');
  });

  it('sorts numbers numerically, not lexically', () => {
    renderTable();
    fireEvent.click(screen.getByRole('button', { name: 'Units' }));
    expect(bodyNames()).toEqual(['Aspen Flats', 'Dogwood Row', 'Cedar Court', 'Birch Lane']);
  });

  it('filters via a per-header multi-select filter', () => {
    renderTable();
    fireEvent.click(screen.getByRole('button', { name: /filter by status/i }));
    const panel = screen.getByRole('dialog', { name: /filter by status/i });
    fireEvent.click(within(panel).getByLabelText('Vacant'));
    expect(bodyNames()).toEqual(['Aspen Flats', 'Dogwood Row']);
    // The trigger now advertises the active state to assistive tech.
    expect(screen.getByRole('button', { name: /filter by status \(filtered\)/i })).toBeInTheDocument();
  });

  it('initialState pre-applies a filter on first render (deep links)', () => {
    render(
      <DataTable
        caption="Test properties"
        columns={columns}
        data={rows}
        rowKey={(r) => r.id}
        initialState={{ filters: { status: { kind: 'select', values: ['Vacant'] } } }}
      />,
    );
    expect(bodyNames()).toEqual(['Aspen Flats', 'Dogwood Row']);
    // The filter is live state, not a lock — the trigger advertises it and it
    // can be cleared like any user-applied filter.
    expect(screen.getByRole('button', { name: /filter by status \(filtered\)/i })).toBeInTheDocument();
  });

  it('filters via a per-header numeric range', () => {
    renderTable();
    fireEvent.click(screen.getByRole('button', { name: /filter by units/i }));
    const panel = screen.getByRole('dialog', { name: /filter by units/i });
    fireEvent.change(within(panel).getByLabelText(/min/i), { target: { value: '3' } });
    expect(bodyNames().sort()).toEqual(['Birch Lane', 'Cedar Court']);
  });

  it('paginates and clamps the page as results shrink', () => {
    renderTable(2);
    // First page shows two rows.
    expect(bodyNames()).toEqual(['Cedar Court', 'Aspen Flats']);
    expect(screen.getByText('1–2 of 4')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(bodyNames()).toEqual(['Birch Lane', 'Dogwood Row']);
    expect(screen.getByText('3–4 of 4')).toBeInTheDocument();

    // Narrowing the set while on page 2 clamps back into range.
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'cedar' } });
    expect(bodyNames()).toEqual(['Cedar Court']);
  });

  it('shows an empty state when nothing matches', () => {
    renderTable();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
    expect(screen.getByText(/no results match/i)).toBeInTheDocument();
  });

  // --- server-driven (manual) mode -----------------------------------------

  it('in manual mode renders the given page and reports state changes instead of processing', () => {
    const onStateChange = vi.fn();
    // Only two rows (a server "page"), but a total of 40 across all pages.
    const page = rows.slice(0, 2);

    function Harness() {
      const [state, setState] = useState<DataTableState>(emptyDataTableState);
      return (
        <DataTable
          caption="Server table"
          columns={columns}
          data={page}
          rowKey={(r) => r.id}
          pageSize={2}
          manual={{
            total: 40,
            state,
            onStateChange: (next) => {
              onStateChange(next);
              setState(next);
            },
          }}
        />
      );
    }
    render(<Harness />);

    // The table shows exactly the server page; the footer trusts `total`.
    expect(bodyNames()).toEqual(['Cedar Court', 'Aspen Flats']);
    expect(screen.getByText('1–2 of 40')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 20')).toBeInTheDocument();

    // Sorting doesn't reorder client-side — it just reports the new state.
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: { columnId: 'name', dir: 'asc' }, page: 0 }),
    );
    expect(bodyNames()).toEqual(['Cedar Court', 'Aspen Flats']); // unchanged

    // Paging reports the next page without slicing the given data.
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
  });

  it('renders a single-choice (radio) filter in manual mode', () => {
    const onStateChange = vi.fn();
    const singleColumns: DataTableColumn<Row>[] = [
      { id: 'name', header: 'Name', cell: (r) => r.name },
      {
        id: 'status',
        header: 'Status',
        filter: { kind: 'select', single: true, accessor: (r) => r.status },
        cell: (r) => r.status,
      },
    ];
    render(
      <DataTable
        caption="Server table"
        columns={singleColumns}
        data={rows.slice(0, 2)}
        rowKey={(r) => r.id}
        manual={{ total: 2, state: emptyDataTableState, onStateChange }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /filter by status/i }));
    const panel = screen.getByRole('dialog', { name: /filter by status/i });
    // Single mode uses radios (incl. an "Any" reset), not checkboxes.
    expect(within(panel).getAllByRole('radio').length).toBeGreaterThan(0);
    expect(within(panel).queryByRole('checkbox')).toBeNull();

    fireEvent.click(within(panel).getByLabelText('Full'));
    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: { status: { kind: 'select', values: ['Full'] } } }),
    );
  });

  it('has no axe violations with a filter popover open', async () => {
    renderTable(2);
    fireEvent.click(screen.getByRole('button', { name: /filter by status/i }));
    await screen.findByRole('dialog', { name: /filter by status/i });
    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
