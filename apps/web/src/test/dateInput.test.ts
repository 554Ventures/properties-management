// Regression guard for the date <input type="date"> helpers. Dates are stored
// and serialized by the API at UTC midnight (prisma `Date.UTC(...)`), so the
// input helpers must read/write the UTC calendar day — reading local components
// silently shifted the day back for users west of UTC (QA finding).
import { describe, expect, it } from 'vitest';
import { fromDateInputValue, toDateInputValue } from '../lib/format';

describe('date input helpers', () => {
  it('reads the UTC calendar day from a UTC-midnight ISO (no local shift)', () => {
    expect(toDateInputValue('2025-08-01T00:00:00.000Z')).toBe('2025-08-01');
  });

  it('writes UTC midnight from a date input value', () => {
    expect(fromDateInputValue('2025-08-01')).toBe('2025-08-01T00:00:00.000Z');
  });

  it('round-trips a date without drifting', () => {
    const iso = fromDateInputValue('2026-02-28');
    expect(toDateInputValue(iso)).toBe('2026-02-28');
  });

  it('returns empty string for null/undefined/invalid input', () => {
    expect(toDateInputValue(null)).toBe('');
    expect(toDateInputValue(undefined)).toBe('');
    expect(toDateInputValue('not-a-date')).toBe('');
  });
});
