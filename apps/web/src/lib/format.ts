// Date/period display helpers. Currency formatting always comes from
// @hearth/shared (formatUsd / formatUsdWhole) — never reimplemented here.

/** ISO datetime → "Jul 3, 2026". */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
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

/** Current period as "YYYY-MM". */
export function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** Signed percent for trend text: 4.2 → "up 4.2%", -1.5 → "down 1.5%". */
export function trendText(pct: number): string {
  const abs = Math.abs(pct);
  const rounded = abs >= 10 ? Math.round(abs).toString() : abs.toFixed(1).replace(/\.0$/, '');
  if (pct === 0) return 'flat';
  return `${pct > 0 ? 'up' : 'down'} ${rounded}%`;
}

/** camelCase / snake_case key → "Title Case" label; strips a "Cents" suffix. */
export function humanizeKey(key: string): string {
  const base = key.replace(/Cents$/, '').replace(/_/g, ' ');
  const spaced = base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
