// DataTable — a column-config-driven wrapper over the semantic Table primitives
// (Table/Th/Td/Tr). It adds, client-side and in-memory:
//   • a global search box over the columns that opt in,
//   • per-header sorting (toggling ascending → descending → off; the <th>
//     carries aria-sort so screen readers announce the state),
//   • per-header filtering with the control auto-picked from the column's
//     filter kind (text-contains, multi-select of distinct values, numeric
//     min/max), rendered in a portaled popover so it is never clipped by the
//     table's horizontal scroll container,
//   • pagination (prev/next with a visible range).
//
// A11y: sorting is a real <button> inside the header with aria-sort on the cell;
// the filter popover traps nothing but returns focus to its trigger and closes
// on Escape / outside click; active filters are conveyed with text ("Filtered"),
// never color alone; a single role="status" region announces the result count.
//
// Data is processed in memory, so this fits the app's small already-fetched
// lists (properties, tenants, units, the capped ledger). Server-driven, cursor-
// paged tables (the review queue) keep their bespoke query wiring.
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/cx';
import { Button } from './Button';
import { Input } from './FormField';
import { Table, Td, Th, Tr } from './Table';
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUpDown,
  IconFilter,
  IconSearch,
  IconX,
} from './icons';

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  columnId: string;
  dir: SortDirection;
}

/** A per-column filter value; the shape is discriminated by `kind`. */
export type FilterValue =
  | { kind: 'text'; text: string }
  | { kind: 'select'; values: string[] }
  | { kind: 'number'; min: string; max: string };

/** The full interaction state — lifted out in `manual` (server-driven) mode. */
export interface DataTableState {
  search: string;
  sort: SortState | null;
  filters: Record<string, FilterValue>;
  page: number;
}

export const emptyDataTableState: DataTableState = {
  search: '',
  sort: null,
  filters: {},
  page: 0,
};

/**
 * Server-driven mode. When provided, DataTable does NOT process `data` itself —
 * `data` is the current page exactly as returned by the server, `total` is the
 * count across all pages, and every user interaction is reported through
 * `onStateChange` for the caller to translate into a query. Select-filter
 * columns must supply explicit `options` in this mode (distinct values can't be
 * derived from a single page).
 */
export interface DataTableManual {
  total: number;
  loading?: boolean;
  state: DataTableState;
  onStateChange: (next: DataTableState) => void;
}

export interface FilterOption {
  value: string;
  label: string;
}

/** How a column is filtered — the kind picks the header control. */
export type ColumnFilter<Row> =
  | { kind: 'text'; accessor: (row: Row) => string; placeholder?: string }
  | {
      kind: 'select';
      accessor: (row: Row) => string;
      /** Explicit options; when omitted, distinct values are derived from data. */
      options?: FilterOption[];
      /** Render as a single-choice (radio) filter — the value holds ≤1 entry,
       * which maps cleanly to a single-value server param. Default: multi-select. */
      single?: boolean;
    }
  | {
      kind: 'number';
      accessor: (row: Row) => number | null | undefined;
      /** Formats the min/max input labels/units (e.g. "$"). */
      unit?: string;
    };

export interface DataTableColumn<Row> {
  /** Stable id — used as the sort/filter state key and React key. */
  id: string;
  header: ReactNode;
  align?: 'left' | 'right';
  /** Pins the column to the right edge (trailing actions). Not sortable/filterable. */
  stickyRight?: boolean;
  headerClassName?: string;
  cellClassName?: string;
  /** Overrides the filter popover's label (defaults to the header text). Useful
   * when the control filters by a facet the header doesn't name (e.g. an
   * "Amount" column filtered by income/expense "Type"). */
  filterLabel?: string;
  /** Cell renderer. */
  cell: (row: Row) => ReactNode;
  /** Enables sorting; returns the comparable value (numbers sort numerically).
   * In server (`manual`) mode this is ignored for processing — set `sortable`. */
  sortAccessor?: (row: Row) => string | number | boolean | null | undefined;
  /** Force the sort control on/off, independent of `sortAccessor`. Use in
   * server mode, where sorting is applied by the query, not the accessor. */
  sortable?: boolean;
  /** Enables the per-header filter control and defines its kind. */
  filter?: ColumnFilter<Row>;
  /** Text contributed to the global search; defaults to a text/select filter's
   * accessor when present. Return '' to exclude the column from search. */
  searchAccessor?: (row: Row) => string;
}

export interface DataTableProps<Row> {
  /** Accessible caption (visually hidden unless captionVisible). */
  caption: string;
  captionVisible?: boolean;
  columns: DataTableColumn<Row>[];
  data: Row[];
  /** Stable row key. */
  rowKey: (row: Row) => string;
  /** Hover affordance on rows (default true). */
  hoverRows?: boolean;
  /** Show the global search box (default true). */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Rows per page; omit or 0 to disable pagination. */
  pageSize?: number;
  /** Rendered in the body when no rows remain after filtering. */
  emptyState?: ReactNode;
  /** The noun used in the count status ("3 of 10 properties"). */
  itemNoun?: { one: string; other: string };
  /** Opt into server-driven processing (see DataTableManual). */
  manual?: DataTableManual;
  className?: string;
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

// Compare two non-empty sort values; strings compare case-insensitively with
// natural numeric ordering ("Unit 2" before "Unit 10").
function compareNonEmpty(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function filterActive(fv: FilterValue | undefined): boolean {
  if (!fv) return false;
  if (fv.kind === 'text') return fv.text.trim() !== '';
  if (fv.kind === 'select') return fv.values.length > 0;
  return fv.min.trim() !== '' || fv.max.trim() !== '';
}

function matchesFilter<Row>(filter: ColumnFilter<Row>, fv: FilterValue, row: Row): boolean {
  if (filter.kind === 'text' && fv.kind === 'text') {
    return filter.accessor(row).toLowerCase().includes(fv.text.trim().toLowerCase());
  }
  if (filter.kind === 'select' && fv.kind === 'select') {
    return fv.values.length === 0 || fv.values.includes(filter.accessor(row));
  }
  if (filter.kind === 'number' && fv.kind === 'number') {
    const value = filter.accessor(row);
    if (value === null || value === undefined) return false;
    const min = fv.min.trim() === '' ? null : Number(fv.min);
    const max = fv.max.trim() === '' ? null : Number(fv.max);
    if (min !== null && !Number.isNaN(min) && value < min) return false;
    if (max !== null && !Number.isNaN(max) && value > max) return false;
    return true;
  }
  return true;
}

function searchText<Row>(column: DataTableColumn<Row>, row: Row): string {
  if (column.searchAccessor) return column.searchAccessor(row);
  if (column.filter && (column.filter.kind === 'text' || column.filter.kind === 'select')) {
    return column.filter.accessor(row);
  }
  return '';
}

export function DataTable<Row>({
  caption,
  captionVisible = false,
  columns,
  data,
  rowKey,
  hoverRows = true,
  searchable = true,
  searchPlaceholder = 'Search…',
  pageSize = 0,
  emptyState,
  itemNoun = { one: 'result', other: 'results' },
  manual,
  className,
}: DataTableProps<Row>) {
  const controlled = manual != null;
  const [internal, setInternal] = useState<DataTableState>(emptyDataTableState);
  const state = controlled ? manual.state : internal;
  const update = (next: DataTableState) => {
    if (controlled) manual.onStateChange(next);
    else setInternal(next);
  };
  const { search, sort, filters, page } = state;

  const anySearchable = useMemo(
    () => columns.some((c) => searchText(c, data[0] ?? ({} as Row)) !== '' || c.searchAccessor),
    [columns, data],
  );
  const showSearch = searchable && (controlled || anySearchable);

  // Distinct select-filter options derived from the data when not given.
  const derivedOptions = useMemo(() => {
    const map: Record<string, FilterOption[]> = {};
    for (const col of columns) {
      if (col.filter?.kind === 'select' && !col.filter.options) {
        const seen = new Set<string>();
        const opts: FilterOption[] = [];
        for (const row of data) {
          const v = col.filter.accessor(row);
          if (v && !seen.has(v)) {
            seen.add(v);
            opts.push({ value: v, label: v });
          }
        }
        opts.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
        map[col.id] = opts;
      }
    }
    return map;
  }, [columns, data]);

  const processed = useMemo(() => {
    if (controlled) return data; // the server already searched/filtered/sorted this page
    let rows = data;
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter((row) => columns.some((c) => searchText(c, row).toLowerCase().includes(q)));
    }
    for (const col of columns) {
      const fv = filters[col.id];
      if (col.filter && fv && filterActive(fv)) {
        rows = rows.filter((row) => matchesFilter(col.filter as ColumnFilter<Row>, fv, row));
      }
    }
    if (sort) {
      const col = columns.find((c) => c.id === sort.columnId);
      const accessor = col?.sortAccessor;
      if (accessor) {
        rows = [...rows].sort((a, b) => {
          const av = accessor(a);
          const bv = accessor(b);
          const ae = isEmpty(av);
          const be = isEmpty(bv);
          if (ae || be) return ae === be ? 0 : ae ? 1 : -1; // empties last, both directions
          const base = compareNonEmpty(av, bv);
          return sort.dir === 'asc' ? base : -base;
        });
      }
    }
    return rows;
  }, [controlled, data, columns, search, filters, sort]);

  const paginated = pageSize > 0;
  const totalCount = controlled ? manual.total : processed.length;
  const pageCount = paginated ? Math.max(1, Math.ceil(totalCount / pageSize)) : 1;

  const setPage = (p: number) => update({ ...state, page: p });

  // Keep the current page in range as a client-side result set shrinks. In
  // server mode the caller owns the page, so we never fight it here.
  useEffect(() => {
    if (!controlled && page > pageCount - 1) setPage(pageCount - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlled, page, pageCount]);

  // In server mode `data` is already the current page; otherwise slice locally.
  const pageRows =
    paginated && !controlled
      ? processed.slice(page * pageSize, page * pageSize + pageSize)
      : processed;

  const activeFilterCount = columns.filter((c) => filterActive(filters[c.id])).length;
  const hasQuery = search.trim() !== '' || activeFilterCount > 0;

  const changeSearch = (v: string) => update({ ...state, search: v, page: 0 });
  const toggleSort = (columnId: string) => {
    let next: SortState | null;
    if (!sort || sort.columnId !== columnId) next = { columnId, dir: 'asc' };
    else if (sort.dir === 'asc') next = { columnId, dir: 'desc' };
    else next = null; // desc → off
    update({ ...state, sort: next, page: 0 });
  };
  const setColumnFilter = (columnId: string, fv: FilterValue) => {
    update({ ...state, filters: { ...filters, [columnId]: fv }, page: 0 });
  };
  const clearAll = () => update({ ...state, search: '', filters: {}, page: 0 });

  const rangeStart = totalCount === 0 ? 0 : (paginated ? page * pageSize : 0) + 1;
  const rangeEnd = paginated ? Math.min(totalCount, (page + 1) * pageSize) : totalCount;

  const showToolbar = showSearch || activeFilterCount > 0 || hasQuery;

  return (
    <div className={cx('flex flex-col', className)} aria-busy={manual?.loading || undefined}>
      {/* A single polite live region announces the result count as it changes. */}
      <p className="sr-only" role="status">
        {manual?.loading
          ? 'Loading…'
          : `Showing ${totalCount} ${totalCount === 1 ? itemNoun.one : itemNoun.other}${
              hasQuery ? ' matching your search and filters' : ''
            }.`}
      </p>

      {showToolbar && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          {showSearch ? (
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
              >
                <IconSearch size={16} />
              </span>
              <Input
                type="search"
                aria-label={searchPlaceholder}
                placeholder={searchPlaceholder}
                value={search}
                onChange={(e) => changeSearch(e.target.value)}
                className="pl-9"
              />
            </div>
          ) : (
            <span />
          )}
          {hasQuery && (
            <Button variant="ghost" size="sm" onClick={clearAll}>
              <IconX size={14} />
              Clear{activeFilterCount > 0 ? ` (${activeFilterCount + (search.trim() ? 1 : 0)})` : ''}
            </Button>
          )}
        </div>
      )}

      <Table caption={caption} captionVisible={captionVisible}>
        <thead>
          <tr>
            {columns.map((col) => (
              <HeaderCell
                key={col.id}
                column={col}
                sort={sort}
                filterValue={filters[col.id]}
                options={col.filter?.kind === 'select' ? (col.filter.options ?? derivedOptions[col.id] ?? []) : []}
                onToggleSort={() => toggleSort(col.id)}
                onFilterChange={(fv) => setColumnFilter(col.id, fv)}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {pageRows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-10 text-center text-sm text-ink-muted">
                {manual?.loading
                  ? 'Loading…'
                  : (emptyState ??
                    (hasQuery ? 'No results match your search and filters.' : 'Nothing here yet.'))}
              </td>
            </tr>
          ) : (
            pageRows.map((row) => (
              <Tr key={rowKey(row)} hover={hoverRows}>
                {columns.map((col) => (
                  <Td
                    key={col.id}
                    align={col.align}
                    stickyRight={col.stickyRight}
                    className={col.cellClassName}
                  >
                    {col.cell(row)}
                  </Td>
                ))}
              </Tr>
            ))
          )}
        </tbody>
      </Table>

      {paginated && totalCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 text-sm text-ink-muted">
          <span>
            {rangeStart}–{rangeEnd} of {totalCount}
          </span>
          <div className="flex items-center gap-2">
            <span aria-hidden="true">
              Page {page + 1} of {pageCount}
            </span>
            <div className="flex gap-1">
              <Button
                variant="secondary"
                size="sm"
                disabled={page === 0 || manual?.loading}
                onClick={() => setPage(Math.max(0, page - 1))}
              >
                <IconChevronLeft size={16} />
                <span className="sr-only">Previous page</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= pageCount - 1 || manual?.loading}
                onClick={() => setPage(Math.min(pageCount - 1, page + 1))}
              >
                <IconChevronRight size={16} />
                <span className="sr-only">Next page</span>
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Header cell (sort control + filter popover) ---------------------------

interface HeaderCellProps<Row> {
  column: DataTableColumn<Row>;
  sort: SortState | null;
  filterValue: FilterValue | undefined;
  options: FilterOption[];
  onToggleSort: () => void;
  onFilterChange: (fv: FilterValue) => void;
}

function HeaderCell<Row>({
  column,
  sort,
  filterValue,
  options,
  onToggleSort,
  onFilterChange,
}: HeaderCellProps<Row>) {
  const sortable = (column.sortable ?? Boolean(column.sortAccessor)) && !column.stickyRight;
  const filterable = Boolean(column.filter) && !column.stickyRight;
  const active = sort?.columnId === column.id ? sort.dir : null;
  const ariaSort = active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : sortable ? 'none' : undefined;

  return (
    <Th align={column.align} stickyRight={column.stickyRight} className={column.headerClassName} aria-sort={ariaSort}>
      <div
        className={cx(
          'flex items-center gap-1',
          column.align === 'right' ? 'justify-end' : 'justify-start',
        )}
      >
        {sortable ? (
          <button
            type="button"
            onClick={onToggleSort}
            // `uppercase` is repeated here because <button> doesn't inherit
            // text-transform from the <th> (Preflight resets form controls).
            className="group inline-flex items-center gap-1 rounded-sm uppercase text-inherit transition-colors duration-fast hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            <span>{column.header}</span>
            <span aria-hidden="true" className={cx(active ? 'text-ink' : 'text-ink-faint')}>
              {active === 'asc' ? (
                <IconArrowUp size={13} />
              ) : active === 'desc' ? (
                <IconArrowDown size={13} />
              ) : (
                <IconChevronUpDown size={13} />
              )}
            </span>
          </button>
        ) : (
          <span>{column.header}</span>
        )}
        {filterable && column.filter && (
          <FilterPopover
            label={
              column.filterLabel ?? (typeof column.header === 'string' ? column.header : column.id)
            }
            filter={column.filter}
            value={filterValue}
            options={options}
            onChange={onFilterChange}
          />
        )}
      </div>
    </Th>
  );
}

// --- Filter popover (portaled, so the scroll container never clips it) ------

interface FilterPopoverProps<Row> {
  label: string;
  filter: ColumnFilter<Row>;
  value: FilterValue | undefined;
  options: FilterOption[];
  onChange: (fv: FilterValue) => void;
}

function FilterPopover<Row>({ label, filter, value, options, onChange }: FilterPopoverProps<Row>) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const active = filterActive(value);

  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setPos({ left: r.right, top: r.bottom + 4 });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  // Close on outside press or Escape; return focus to the trigger on Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  // Focus the first control when the panel opens.
  useEffect(() => {
    if (open && pos) panelRef.current?.querySelector<HTMLElement>('input')?.focus();
  }, [open, pos]);

  const clear = () => {
    if (filter.kind === 'text') onChange({ kind: 'text', text: '' });
    else if (filter.kind === 'select') onChange({ kind: 'select', values: [] });
    else onChange({ kind: 'number', min: '', max: '' });
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Filter by ${label}${active ? ' (filtered)' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          'inline-flex h-6 w-6 items-center justify-center rounded-sm transition-colors duration-fast hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand',
          active ? 'text-brand' : 'text-ink-faint hover:text-ink-muted',
        )}
      >
        <IconFilter size={13} />
        {active && <span className="sr-only">Filtered</span>}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label={`Filter by ${label}`}
            style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'translateX(-100%)' }}
            className="z-[60] w-60 rounded-md border border-border bg-surface p-3 text-left normal-case tracking-normal shadow-overlay"
          >
            {filter.kind === 'text' && (
              <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted">
                Contains
                <Input
                  type="text"
                  placeholder={filter.placeholder ?? `Filter ${label.toLowerCase()}`}
                  value={value?.kind === 'text' ? value.text : ''}
                  onChange={(e) => onChange({ kind: 'text', text: e.target.value })}
                />
              </label>
            )}

            {filter.kind === 'select' && (
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-xs font-medium text-ink-muted">Show</legend>
                {options.length === 0 ? (
                  <p className="text-xs text-ink-muted">No values.</p>
                ) : (
                  <div className="max-h-56 overflow-y-auto">
                    {filter.single && (
                      <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-sm font-normal normal-case text-ink hover:bg-surface-sunken">
                        <input
                          type="radio"
                          name={panelId}
                          checked={(value?.kind === 'select' ? value.values : []).length === 0}
                          onChange={() => onChange({ kind: 'select', values: [] })}
                          className="h-4 w-4 border-border-strong text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
                        />
                        Any
                      </label>
                    )}
                    {options.map((opt) => {
                      const values = value?.kind === 'select' ? value.values : [];
                      const checked = values.includes(opt.value);
                      return (
                        <label
                          key={opt.value}
                          className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-sm font-normal normal-case text-ink hover:bg-surface-sunken"
                        >
                          <input
                            type={filter.single ? 'radio' : 'checkbox'}
                            name={filter.single ? panelId : undefined}
                            checked={checked}
                            onChange={() =>
                              onChange({
                                kind: 'select',
                                values: filter.single
                                  ? [opt.value]
                                  : checked
                                    ? values.filter((v) => v !== opt.value)
                                    : [...values, opt.value],
                              })
                            }
                            className={cx(
                              'h-4 w-4 border-border-strong text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand',
                              filter.single ? '' : 'rounded',
                            )}
                          />
                          {opt.label}
                        </label>
                      );
                    })}
                  </div>
                )}
              </fieldset>
            )}

            {filter.kind === 'number' && (
              <div className="flex items-end gap-2">
                <label className="flex flex-1 flex-col gap-1.5 text-xs font-medium text-ink-muted">
                  Min{filter.unit ? ` (${filter.unit})` : ''}
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={value?.kind === 'number' ? value.min : ''}
                    onChange={(e) =>
                      onChange({
                        kind: 'number',
                        min: e.target.value,
                        max: value?.kind === 'number' ? value.max : '',
                      })
                    }
                  />
                </label>
                <label className="flex flex-1 flex-col gap-1.5 text-xs font-medium text-ink-muted">
                  Max{filter.unit ? ` (${filter.unit})` : ''}
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={value?.kind === 'number' ? value.max : ''}
                    onChange={(e) =>
                      onChange({
                        kind: 'number',
                        min: value?.kind === 'number' ? value.min : '',
                        max: e.target.value,
                      })
                    }
                  />
                </label>
              </div>
            )}

            <div className="mt-3 flex justify-between">
              <Button variant="ghost" size="sm" disabled={!active} onClick={clear}>
                Clear
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                Done
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
