// Occurrence math (PLAN-REAL-EQUITY §2, Phase 2b). Pure, no DB.
//
// This decides what the scheduler drafts, so an off-by-one here bills a
// landlord's ledger on the wrong day, or twice. The cases that matter are the
// boundaries: month-end clamping, the occurrence landing exactly on today, a
// template anchored in the future, and the account timezone deciding which
// local day "now" is.
import { describe, expect, it } from 'vitest';
import {
  occurrenceInstant,
  occurrenceOnOrAfter,
  occurrenceOnOrBefore,
} from '../lib/recurrence';

const NY = 'America/New_York';
const d = (iso: string) => new Date(iso);

describe('occurrenceOnOrBefore — what is currently due', () => {
  it('returns the occurrence in the current month once its day has arrived', () => {
    const anchor = d('2026-01-05T05:00:00Z'); // Jan 5 local
    expect(occurrenceOnOrBefore(anchor, 'monthly', d('2026-08-10T12:00:00Z'), NY)).toBe('2026-08-05');
  });

  it('falls back to last month when this month’s day has not arrived', () => {
    const anchor = d('2026-01-25T05:00:00Z');
    expect(occurrenceOnOrBefore(anchor, 'monthly', d('2026-08-10T12:00:00Z'), NY)).toBe('2026-07-25');
  });

  it('counts an occurrence falling exactly on today as due', () => {
    const anchor = d('2026-01-05T05:00:00Z');
    expect(occurrenceOnOrBefore(anchor, 'monthly', d('2026-08-05T12:00:00Z'), NY)).toBe('2026-08-05');
  });

  it('is null while the anchor is still in the future — scheduled, not started', () => {
    const anchor = d('2026-12-01T05:00:00Z');
    expect(occurrenceOnOrBefore(anchor, 'monthly', d('2026-08-10T12:00:00Z'), NY)).toBeNull();
  });

  it('clamps a 31st anchor to the end of a short month instead of rolling over', () => {
    // Rolling over would make February's payment land on March 3 and quietly
    // move it into the wrong month.
    const anchor = d('2026-01-31T05:00:00Z');
    expect(occurrenceOnOrBefore(anchor, 'monthly', d('2026-02-28T12:00:00Z'), NY)).toBe('2026-02-28');
    // …and the anchor is not consumed by the clamp: March is the 31st again.
    expect(occurrenceOnOrBefore(anchor, 'monthly', d('2026-03-31T12:00:00Z'), NY)).toBe('2026-03-31');
  });

  it('clamps to Feb 29 in a leap year', () => {
    const anchor = d('2024-01-31T05:00:00Z');
    expect(occurrenceOnOrBefore(anchor, 'monthly', d('2024-02-29T12:00:00Z'), NY)).toBe('2024-02-29');
  });

  it('steps quarterly and annual cadences by their own period', () => {
    const anchor = d('2026-02-15T05:00:00Z');
    expect(occurrenceOnOrBefore(anchor, 'quarterly', d('2026-09-30T12:00:00Z'), NY)).toBe('2026-08-15');
    expect(occurrenceOnOrBefore(anchor, 'annual', d('2026-09-30T12:00:00Z'), NY)).toBe('2026-02-15');
    // An annual template whose month hasn't come round yet is due last year.
    expect(occurrenceOnOrBefore(anchor, 'annual', d('2027-01-10T12:00:00Z'), NY)).toBe('2026-02-15');
  });

  it('reads "today" on the account’s calendar, not UTC', () => {
    // 01:00 UTC on the 6th is still the 5th in New York, so an occurrence on
    // the 6th is not yet due there — but it is in Berlin.
    const anchor = d('2026-01-06T05:00:00Z');
    const at = d('2026-08-06T01:00:00Z');
    expect(occurrenceOnOrBefore(anchor, 'monthly', at, NY)).toBe('2026-07-06');
    expect(occurrenceOnOrBefore(anchor, 'monthly', at, 'Europe/Berlin')).toBe('2026-08-06');
  });
});

describe('occurrenceOnOrAfter — what the UI shows as next', () => {
  it('returns today when an occurrence lands on it', () => {
    const anchor = d('2026-01-05T05:00:00Z');
    expect(occurrenceOnOrAfter(anchor, 'monthly', d('2026-08-05T12:00:00Z'), NY)).toBe('2026-08-05');
  });

  it('rolls to next month once this month’s has passed', () => {
    const anchor = d('2026-01-05T05:00:00Z');
    expect(occurrenceOnOrAfter(anchor, 'monthly', d('2026-08-10T12:00:00Z'), NY)).toBe('2026-09-05');
  });

  it('returns the anchor itself for a template scheduled in the future', () => {
    const anchor = d('2026-12-01T05:00:00Z');
    expect(occurrenceOnOrAfter(anchor, 'monthly', d('2026-08-10T12:00:00Z'), NY)).toBe('2026-12-01');
  });

  it('clamps forward into a short month too', () => {
    const anchor = d('2026-01-31T05:00:00Z');
    expect(occurrenceOnOrAfter(anchor, 'monthly', d('2026-02-01T12:00:00Z'), NY)).toBe('2026-02-28');
  });
});

describe('occurrenceInstant', () => {
  it('dates a drafted row at local midnight of the occurrence', () => {
    // Aug 5 in New York (EDT, −4) is 04:00 UTC.
    expect(occurrenceInstant('2026-08-05', NY).toISOString()).toBe('2026-08-05T04:00:00.000Z');
    // January is EST (−5).
    expect(occurrenceInstant('2026-01-05', NY).toISOString()).toBe('2026-01-05T05:00:00.000Z');
  });
});
