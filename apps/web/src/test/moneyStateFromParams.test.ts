// Money deep links: ?type/?categoryId/?propertyId → pre-applied DataTable
// filters (insight cards and push notifications land pre-filtered);
// ?unassigned=true → the unassigned_transactions insight's deep link.
import { describe, expect, it } from 'vitest';
import { emptyDataTableState } from '../components/ui/DataTable';
import { moneyStateFromParams, unassignedFromParams } from '../pages/Money';

describe('moneyStateFromParams', () => {
  it('returns the empty state with no params', () => {
    expect(moneyStateFromParams(new URLSearchParams())).toEqual(emptyDataTableState);
  });

  it('maps type/categoryId/propertyId to the matching column filters', () => {
    const state = moneyStateFromParams(
      new URLSearchParams('type=expense&categoryId=cat1&propertyId=p1'),
    );
    expect(state.filters).toEqual({
      amount: { kind: 'select', values: ['expense'] },
      category: { kind: 'select', values: ['cat1'] },
      property: { kind: 'select', values: ['p1'] },
    });
    expect(state.search).toBe('');
    expect(state.page).toBe(0);
  });

  it('ignores an invalid type value', () => {
    const state = moneyStateFromParams(new URLSearchParams('type=refund&categoryId=cat1'));
    expect(state.filters).toEqual({ category: { kind: 'select', values: ['cat1'] } });
  });

  it('leaves unassigned out of the table filters — it is parsed separately', () => {
    const state = moneyStateFromParams(new URLSearchParams('unassigned=true&type=income'));
    expect(state.filters).toEqual({ amount: { kind: 'select', values: ['income'] } });
  });
});

describe('unassignedFromParams', () => {
  it('is true only for the literal string "true"', () => {
    expect(unassignedFromParams(new URLSearchParams('unassigned=true'))).toBe(true);
  });

  it('is false when absent', () => {
    expect(unassignedFromParams(new URLSearchParams())).toBe(false);
  });

  it('is false for any other value', () => {
    expect(unassignedFromParams(new URLSearchParams('unassigned=false'))).toBe(false);
    expect(unassignedFromParams(new URLSearchParams('unassigned=1'))).toBe(false);
  });
});
