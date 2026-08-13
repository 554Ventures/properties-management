// Occurrence math for RecurringTemplate (PLAN-REAL-EQUITY §2, Phase 2b). Pure
// and calendar-only, so the service (which reports `nextOccurrence`) and the
// daily jobs loop (which decides what to draft) can never disagree about when a
// template comes due.
//
// Two rules carry the whole file:
//
//  1. **Occurrences are local calendar dates, not instants.** A payment due the
//     1st is due on the 1st wherever the landlord is; computing it in UTC would
//     draft a day early or late for most of the world. Everything here runs
//     through the account's timezone, like all other period math.
//
//  2. **The day-of-month is clamped, never rolled over.** A template anchored
//     Jan 31 is due Feb 28 (29 in a leap year), not Mar 3. Rolling over would
//     walk the due date forward through the year and silently change which
//     month an occurrence belongs to. Clamping is also non-destructive: the
//     anchor keeps saying 31, so March is due the 31st again.
import { localMidnightUtc, wallClockParts } from './dates';

export type RecurrenceCadence = 'monthly' | 'quarterly' | 'annual';

const MONTHS_PER_CADENCE: Record<RecurrenceCadence, number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

/** `YYYY-MM-DD` for a local calendar date. */
function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Days in a local calendar month (month is 1-12). */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The occurrence `steps` cadence-periods after the anchor, as a local calendar
 * date. `steps` may be negative. The anchor's day-of-month is preserved and
 * clamped to the target month's length.
 */
function occurrenceAt(
  anchorYear: number,
  anchorMonth: number,
  anchorDay: number,
  cadence: RecurrenceCadence,
  steps: number,
): { year: number; month: number; day: number } {
  const monthsFromAnchor = anchorMonth - 1 + steps * MONTHS_PER_CADENCE[cadence];
  const year = anchorYear + Math.floor(monthsFromAnchor / 12);
  // JS modulo keeps the sign of the dividend, so normalize for negative steps.
  const month = ((monthsFromAnchor % 12) + 12) % 12 + 1;
  return { year, month, day: Math.min(anchorDay, daysInMonth(year, month)) };
}

/** Whole cadence-steps from the anchor month to the `asOf` month. */
function stepsToMonthOf(
  anchorYear: number,
  anchorMonth: number,
  year: number,
  month: number,
  cadence: RecurrenceCadence,
): number {
  const months = (year - anchorYear) * 12 + (month - anchorMonth);
  return Math.floor(months / MONTHS_PER_CADENCE[cadence]);
}

/**
 * The most recent occurrence falling on or before `asOf`, as `YYYY-MM-DD` in
 * `tz` — i.e. what is currently due. Null when the anchor is still in the
 * future, which is the "scheduled but not started yet" case and must not draft.
 */
export function occurrenceOnOrBefore(
  anchorDate: Date,
  cadence: RecurrenceCadence,
  asOf: Date,
  tz: string,
): string | null {
  const a = wallClockParts(tz, anchorDate);
  const n = wallClockParts(tz, asOf);

  // Start from the arithmetic guess, then step back while it overshoots. The
  // loop runs at most twice: once for a same-month day that hasn't arrived, and
  // once more if clamping moved the candidate past `asOf`.
  let steps = stepsToMonthOf(a.year, a.month, n.year, n.month, cadence);
  for (let guard = 0; guard < 3; guard += 1) {
    if (steps < 0) return null;
    const c = occurrenceAt(a.year, a.month, a.day, cadence, steps);
    if (c.year < n.year || (c.year === n.year && (c.month < n.month || (c.month === n.month && c.day <= n.day)))) {
      return isoDate(c.year, c.month, c.day);
    }
    steps -= 1;
  }
  return null;
}

/**
 * The first occurrence falling on or after `asOf` — what the UI shows as "next".
 * Always defined for a live template: the schedule has no end.
 */
export function occurrenceOnOrAfter(
  anchorDate: Date,
  cadence: RecurrenceCadence,
  asOf: Date,
  tz: string,
): string {
  const a = wallClockParts(tz, anchorDate);
  const n = wallClockParts(tz, asOf);

  let steps = Math.max(0, stepsToMonthOf(a.year, a.month, n.year, n.month, cadence));
  for (let guard = 0; guard < 3; guard += 1) {
    const c = occurrenceAt(a.year, a.month, a.day, cadence, steps);
    if (c.year > n.year || (c.year === n.year && (c.month > n.month || (c.month === n.month && c.day >= n.day)))) {
      return isoDate(c.year, c.month, c.day);
    }
    steps += 1;
  }
  // Unreachable for sane inputs; stepping forward always passes `asOf`.
  const c = occurrenceAt(a.year, a.month, a.day, cadence, steps);
  return isoDate(c.year, c.month, c.day);
}

/**
 * The UTC instant to date a drafted row at: local midnight of the occurrence in
 * the account's timezone, matching how every other period boundary is derived.
 */
export function occurrenceInstant(occurrence: string, tz: string): Date {
  const [year, month, day] = occurrence.split('-').map(Number) as [number, number, number];
  return localMidnightUtc(year, month, day, tz);
}
