import { describe, expect, it } from 'vitest';
import { matchTenantName, nameTokens } from '../services/name-match';

describe('nameTokens', () => {
  it('lowercases, splits punctuation, folds diacritics', () => {
    expect(nameTokens('T. Okafor')).toEqual(['t', 'okafor']);
    expect(nameTokens('Ana García-López')).toEqual(['ana', 'garcia', 'lopez']);
    expect(nameTokens("O'Brien — RENT")).toEqual(['o', 'brien', 'rent']);
    expect(nameTokens('')).toEqual([]);
  });
});

describe('matchTenantName', () => {
  const match = (name: string, descriptor: string) => matchTenantName([name], descriptor);

  it('matches surname + initial in either order', () => {
    expect(match('T. Okafor', 'ACH CREDIT — RENT T OKAFOR')).toBe('T. Okafor');
    expect(match('Juan Rivera', 'ZELLE FROM RIVERA J')).toBe('Juan Rivera');
    expect(match('Juan Rivera', 'JUAN RIVERA RENT JUL')).toBe('Juan Rivera');
  });

  it('accepts a surname-only descriptor when the stored name has no other significant tokens', () => {
    // "T." is an ignored initial, so the surname alone carries the name.
    expect(match('T. Okafor', 'ACH CREDIT OKAFOR')).toBe('T. Okafor');
  });

  it('requires corroboration of significant first names (bare surname is an accepted miss)', () => {
    expect(match('Juan Rivera', 'ACH CREDIT RIVERA')).toBeNull();
    // Defuses the seeded contractor collision: no "juan"/"j" token present.
    expect(match('Juan Rivera', 'RIVERA PLUMBING LLC')).toBeNull();
  });

  it('never matches on substrings', () => {
    expect(match('D. Park', 'PARKING GARAGE REFUND')).toBeNull();
    expect(match('D. Park', 'RENT D PARK')).toBe('D. Park');
  });

  it('folds diacritics and handles hyphenated surnames', () => {
    expect(match('Ana García-López', 'GARCIA LOPEZ A')).toBe('Ana García-López');
    expect(match('Ana García-López', 'ZELLE ANA GARCIA LOPEZ')).toBe('Ana García-López');
    // Surname anchor is the LAST significant token — "GARCIA" alone is not enough.
    expect(match('Ana García-López', 'ANA GARCIA')).toBeNull();
  });

  it('ignores 1–2 letter tokens entirely (lone-initial and particle guards)', () => {
    // Zero significant tokens → never matches, even a literal echo.
    expect(match('J. R.', 'J R')).toBeNull();
    // A descriptor's stray letters can't stand in for the surname.
    expect(match('Juan Rivera', 'PAYMENT J R')).toBeNull();
  });

  it('returns the first (primary-first) matching tenant, else null', () => {
    const tenants = ['A. Osei', 'R. Osei'];
    // Shared surname: primary listed first wins — callers relying on
    // disambiguation must check for uniqueness across candidates, not here.
    expect(matchTenantName(tenants, 'ACH OSEI RENT')).toBe('A. Osei');
    expect(matchTenantName(tenants, 'UNRELATED DEPOSIT')).toBeNull();
    expect(matchTenantName([], 'ACH OSEI RENT')).toBeNull();
  });
});
