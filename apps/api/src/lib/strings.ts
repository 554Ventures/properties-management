/**
 * "1 property", "2 properties", "3 leased units". Pass `pluralForm` when the
 * plural isn't just +"s". Counts are rendered with the noun so a summary can't
 * drift into "1 properties".
 */
export function plural(n: number, singular: string, pluralForm?: string): string {
  return `${n} ${n === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

/** "T. Okafor" → "t-okafor"; "5 Birch Ln" → "5-birch-ln". Used for insight dedupeKeys. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
