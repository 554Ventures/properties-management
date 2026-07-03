/** "T. Okafor" → "t-okafor"; "5 Birch Ln" → "5-birch-ln". Used for insight dedupeKeys. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
