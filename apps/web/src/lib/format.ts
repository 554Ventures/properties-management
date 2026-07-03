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
