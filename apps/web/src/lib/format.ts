// Date/period display helpers. Currency formatting always comes from
// @hearth/shared (formatUsd / formatUsdWhole) — never reimplemented here.
import type { RecurrenceCadence } from '@hearth/shared';

/** ISO datetime → "Jul 3, 2026". */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * "YYYY-MM-DD" → "Sep 1, 2026". For a CALENDAR date, which is a different kind
 * of value from the instants `formatDate` takes: `new Date('2026-09-01')` is
 * parsed as UTC midnight, so formatting it in local time renders Aug 31 for
 * everyone west of UTC. A recurring template due on the 1st would then read
 * "Monthly, on the 1st · next due Aug 31" — self-contradictory in one row.
 */
export function formatCalendarDate(ymd: string): string {
  const [year, month, day] = ymd.split('-').map(Number) as [number, number, number];
  // Local-time constructor with explicit parts: no timezone shift to apply.
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** ISO datetime → "Jul 3" (no year — for compact before/after pairs like a
 *  bank-correction diff, where a year would be redundant clutter). */
export function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** ISO datetime → "Jul 3, 2:14 PM" (year included when not the current one). */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' as const }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "YYYY-MM" period → "Jul 2026". */
export function formatMonth(period: string): string {
  const [y, m] = period.split('-');
  if (!y || !m) return period;
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });
}

/** "YYYY-MM" period → "July 2026". */
export function formatMonthLong(period: string): string {
  const [y, m] = period.split('-');
  if (!y || !m) return period;
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

/**
 * ISO datetime → "YYYY-MM-DD" for <input type="date"> (empty string if null).
 * Reads the UTC calendar day so it round-trips with `fromDateInputValue` and
 * matches how the API stores dates (UTC midnight). Using local components here
 * would shift the day for any user west of UTC on a UTC-midnight timestamp.
 */
export function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
    date.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** "YYYY-MM-DD" from a date input → ISO datetime at UTC midnight (no TZ drift). */
export function fromDateInputValue(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

/** Whole days from now until an ISO date (ceil; negative once past). Pairs
 *  with RENEW_SOON_DAYS from @hearth/shared for renewal-window badge math. */
export function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

/** Current period as "YYYY-MM". */
export function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Recent periods as "YYYY-MM", newest first: the current month and the
 * preceding `count - 1` months. Used to populate the rent-period picker with a
 * cross-browser <select> (native <input type="month"> is unsupported in Safari,
 * where it silently degrades to a plain text field).
 */
export function recentPeriods(count = 12): string[] {
  const now = new Date();
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
}

/** Byte count → human size: 812 → "812 B", 34_567 → "33.8 KB", 2_400_000 → "2.3 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb >= 10 ? Math.round(kb).toString() : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb >= 10 ? Math.round(mb).toString() : mb.toFixed(1)} MB`;
}

/** Signed percent for trend text: 4.2 → "up 4.2%", -1.5 → "down 1.5%". */
export function trendText(pct: number): string {
  const abs = Math.abs(pct);
  const rounded = abs >= 10 ? Math.round(abs).toString() : abs.toFixed(1).replace(/\.0$/, '');
  if (pct === 0) return 'flat';
  return `${pct > 0 ? 'up' : 'down'} ${rounded}%`;
}

/**
 * `interestRateMilliPct` (thousandths of a percent, e.g. 6375 = 6.375%) →
 * display string with trailing zeros trimmed: 6375 → "6.375%", 5000 → "5%".
 */
export function formatInterestRate(milliPct: number): string {
  const pct = (milliPct / 1000).toFixed(3).replace(/\.?0+$/, '');
  return `${pct}%`;
}

/** 1 → "1st", 12 → "12th", 22 → "22nd", 23 → "23rd" (the 11th–13th exceptions). */
function ordinalSuffix(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * `RecurringTemplate.cadence` + `anchorDate` → plain English, never
 * "monthly"/an ISO date on their own: "Monthly, on the 1st" / "Quarterly, on
 * the 15th" / "Annually, on Jan 15". `anchorDate` is a plain `YYYY-MM-DD`
 * calendar date (no time, no zone) — read the day/month straight from the
 * string, same as `formatCalendarDate` above. Parsing it with `new
 * Date(anchorDate)` would reintroduce the exact bug this schema change fixed:
 * the day silently drifting a day off depending on the reader's timezone.
 */
export function describeCadence(cadence: RecurrenceCadence, anchorDate: string): string {
  const [year, month, day] = anchorDate.split('-').map(Number) as [number, number, number];
  if (cadence === 'annual') {
    // Local-time constructor with explicit parts (same as `formatCalendarDate`):
    // no string-to-Date parsing, so no timezone shift to apply.
    const monthLabel = new Date(year, month - 1, day).toLocaleDateString('en-US', {
      month: 'short',
    });
    return `Annually, on ${monthLabel} ${day}`;
  }
  const label = cadence === 'monthly' ? 'Monthly' : 'Quarterly';
  return `${label}, on the ${ordinalSuffix(day)}`;
}

/** camelCase / snake_case key → "Title Case" label; strips a "Cents" suffix. */
export function humanizeKey(key: string): string {
  const base = key.replace(/Cents$/, '').replace(/_/g, ' ');
  const spaced = base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
