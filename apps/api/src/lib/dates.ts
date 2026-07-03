// Period ("YYYY-MM") math + ISO helpers. All calendar math is UTC so the seed
// script, services and tests agree regardless of server timezone.

const DAY_MS = 86_400_000;

/** Date → strict ISO string (what the shared zod .datetime() schemas expect). */
export function iso(d: Date): string {
  return d.toISOString();
}

export function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** "YYYY-MM" for a date (UTC). */
export function periodOf(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function currentPeriod(now: Date = new Date()): string {
  return periodOf(now);
}

function parsePeriod(period: string): { year: number; month: number } {
  const [y, m] = period.split('-');
  return { year: Number(y), month: Number(m) };
}

/** First instant of the period's month (UTC). */
export function monthStart(period: string): Date {
  const { year, month } = parsePeriod(period);
  return new Date(Date.UTC(year, month - 1, 1));
}

/** First instant of the following month (use with `lt`). */
export function monthEndExclusive(period: string): Date {
  const { year, month } = parsePeriod(period);
  return new Date(Date.UTC(year, month, 1));
}

/** period + n months → "YYYY-MM" (n may be negative). */
export function addMonthsToPeriod(period: string, n: number): string {
  const { year, month } = parsePeriod(period);
  const d = new Date(Date.UTC(year, month - 1 + n, 1));
  return periodOf(d);
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Whole calendar days (UTC) from `from` to `to`; positive when to > from. */
export function calendarDaysBetween(from: Date, to: Date): number {
  return Math.round((startOfUtcDay(to).getTime() - startOfUtcDay(from).getTime()) / DAY_MS);
}

/** "2026-07" → "July 2026". */
export function periodLabel(period: string): string {
  const d = monthStart(period);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Calendar-year range [Jan 1, Jan 1 next year). */
export function yearRange(year: number): { from: Date; to: Date } {
  return { from: new Date(Date.UTC(year, 0, 1)), to: new Date(Date.UTC(year + 1, 0, 1)) };
}

/** List of periods, oldest first, ending at `endPeriod` inclusive. */
export function trailingPeriods(endPeriod: string, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(addMonthsToPeriod(endPeriod, -i));
  return out;
}
