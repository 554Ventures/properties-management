// Period ("YYYY-MM") math + ISO helpers.
//
// Two families live here:
//   • The UTC helpers (periodOf/monthStart/…): the interchange + storage
//     default. "YYYY-MM" is UTC-derived; Transaction.date is an instant.
//   • The tz-aware variants (…InTz, WS4): bucket an instant by an IANA
//     timezone's wall clock so a late-evening transaction for a non-UTC
//     landlord lands in *their* local month/tax-year, not UTC's. Intl only
//     (Node ≥22 ships full ICU) — no date-fns. Both families produce the same
//     "YYYY-MM" interchange format; only the bucketing boundary differs.
// Keep the UTC helpers: other callers rely on them and process-tz-independent
// UTC math is still the right default for storage/interchange.

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

// ── Timezone-aware period math (WS4) ─────────────────────────────────────────

/** One Intl.DateTimeFormat per tz — constructing them is comparatively costly,
 *  and these run in every KPI/report/rent hot path. */
const tzFormatterCache = new Map<string, Intl.DateTimeFormat>();
function tzFormatter(tz: string): Intl.DateTimeFormat {
  let f = tzFormatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    tzFormatterCache.set(tz, f);
  }
  return f;
}

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

/** The local wall-clock fields of instant `at` in `tz`. */
export function wallClockParts(tz: string, at: Date): WallClock {
  const parts = tzFormatter(tz).formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // hour12:false renders midnight as "24" in some ICU builds — normalize to 0.
  // The date fields already name the correct calendar day, so no rollover.
  const hour = get('hour') % 24;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Milliseconds to add to a UTC instant to reach `tz`'s wall clock at that
 *  instant (negative west of UTC; e.g. −5h for New York in winter). Offsets
 *  are whole seconds, so the sub-second part of `at` is factored out. */
export function tzOffsetMs(tz: string, at: Date): number {
  const p = wallClockParts(tz, at);
  const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const atWholeSeconds = at.getTime() - at.getUTCMilliseconds();
  return localAsUtc - atWholeSeconds;
}

/** UTC instant of local midnight (00:00:00.000) of the given local calendar
 *  date in `tz`. Two-pass offset adjustment (the standard date-fns-tz
 *  technique): the naive "local-midnight-as-UTC minus offset" guess can land on
 *  the far side of a DST change from the true midnight, so the offset is
 *  re-evaluated at the candidate instant. Day/month may overflow — Date.UTC
 *  normalizes (day 0 → last day of the previous month; month 13 → next Jan). */
export function localMidnightUtc(year: number, month: number, day: number, tz: string): Date {
  const localAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  const firstPass = localAsUtc - tzOffsetMs(tz, new Date(localAsUtc));
  return new Date(localAsUtc - tzOffsetMs(tz, new Date(firstPass)));
}

/** "YYYY-MM" of instant `d` in `tz`. */
export function periodOfInTz(d: Date, tz: string): string {
  const p = wallClockParts(tz, d);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

export function currentPeriodInTz(tz: string, now: Date = new Date()): string {
  return periodOfInTz(now, tz);
}

/** First instant of the period's month at local midnight in `tz`. */
export function monthStartInTz(period: string, tz: string): Date {
  const { year, month } = parsePeriod(period);
  return localMidnightUtc(year, month, 1, tz);
}

/** First instant of the following month at local midnight in `tz` (use with `lt`). */
export function monthEndExclusiveInTz(period: string, tz: string): Date {
  const { year, month } = parsePeriod(period);
  return localMidnightUtc(year, month + 1, 1, tz);
}

/** UTC instant of local midnight of the day containing instant `d` in `tz`. */
export function startOfDayInTz(d: Date, tz: string): Date {
  const p = wallClockParts(tz, d);
  return localMidnightUtc(p.year, p.month, p.day, tz);
}

/** Whole calendar days between the local days of `from` and `to` in `tz`;
 *  positive when to > from. Compares local day ordinals, so it's exact across
 *  DST (no 23/25-hour-day drift that plain ms subtraction would suffer). */
export function calendarDaysBetweenInTz(from: Date, to: Date, tz: string): number {
  const f = wallClockParts(tz, from);
  const t = wallClockParts(tz, to);
  const fOrd = Date.UTC(f.year, f.month - 1, f.day);
  const tOrd = Date.UTC(t.year, t.month - 1, t.day);
  return Math.round((tOrd - fOrd) / DAY_MS);
}

/**
 * Whole business days (Mon–Fri) in the local-day interval (from, to] in
 * `tz` — i.e. business days strictly after `from`'s local day up to and
 * including `to`'s local day. That's the framing the grace check needs:
 * "how many business days have elapsed since the due date", so the due date
 * itself never counts but the day something is checked on does.
 *
 * Directionality mirrors calendarDaysBetweenInTz: positive when to > from.
 * When to < from the interval is computed on the swapped (to, from] range and
 * negated, so the result stays the negative mirror of the forward count —
 * callers comparing `businessDaysBetweenInTz(due, today, tz) > graceDays`
 * (graceDays ≥ 0) get `false` for any not-yet-due charge without a special
 * case, exactly like the calendar-day version.
 *
 * Holidays are explicitly out of scope for v1 — every Mon–Fri counts as a
 * business day, federal/state holidays included.
 */
export function businessDaysBetweenInTz(from: Date, to: Date, tz: string): number {
  const f = wallClockParts(tz, from);
  const t = wallClockParts(tz, to);
  // Local calendar-day ordinals (WS4): same Date.UTC(y, m-1, d) construction
  // calendarDaysBetweenInTz uses, so the weekday derived from them below can't
  // be skewed by DST — it comes from the local y/m/d, never from `at` itself.
  const fOrd = Date.UTC(f.year, f.month - 1, f.day);
  const tOrd = Date.UTC(t.year, t.month - 1, t.day);
  if (fOrd === tOrd) return 0;
  const negate = tOrd < fOrd;
  const startOrd = negate ? tOrd : fOrd;
  const endOrd = negate ? fOrd : tOrd;
  const startDay = startOrd / DAY_MS; // integer day number since the Unix epoch
  const endDay = endOrd / DAY_MS;
  let count = 0;
  // Epoch day 0 (1970-01-01) was a Thursday, so weekday(dayNumber) = (dayNumber
  // + 4) % 7 with 0=Sun..6=Sat — derived from the integer ordinal, not a fresh
  // Date object, so there's no re-interpretation through any timezone.
  for (let d = startDay + 1; d <= endDay; d++) {
    const weekday = (d + 4) % 7;
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return negate ? -count : count;
}

/** Day-of-month (1-31) of instant `d` in `tz`. */
export function dayOfMonthInTz(d: Date, tz: string): number {
  return wallClockParts(tz, d).day;
}

/** Calendar-year range [local Jan 1, local Jan 1 next year) in `tz`. */
export function yearRangeInTz(year: number, tz: string): { from: Date; to: Date } {
  return { from: localMidnightUtc(year, 1, 1, tz), to: localMidnightUtc(year + 1, 1, 1, tz) };
}
