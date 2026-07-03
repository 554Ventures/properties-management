// Money conventions (binding): all money values are integer cents, field names
// suffixed `Cents`. These helpers are the only USD formatters in the app.

/** Integer number of US cents. */
export type Cents = number;

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdWholeFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** 845000 → "$8,450.00"; -845000 → "-$8,450.00". */
export function formatUsd(cents: Cents): string {
  return usdFormatter.format(cents / 100);
}

/** 845000 → "$8,450" (rounded to whole dollars). */
export function formatUsdWhole(cents: Cents): string {
  return usdWholeFormatter.format(cents / 100);
}
