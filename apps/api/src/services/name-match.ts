// Tenant-name matching against bank deposit descriptors (rent-match
// heuristics v2). Pure and dependency-free, same precedent as vendor.ts —
// deterministic string matching only, so mock mode works offline.
//
// The name signal is strictly boost + disambiguate on top of the exact-amount
// rent-match gate: it never creates name-only suggestions. Accepted
// conservative misses, by design:
//   - a bare surname ("RIVERA") does not match "Juan Rivera" — the first name
//     is never corroborated, and surname-only would collide with vendors like
//     "RIVERA PLUMBING LLC";
//   - two candidates whose tenants share a surname (seed: A. Osei / R. Osei)
//     both match, so amount-tie disambiguation keeps suppressing — correct.

/**
 * Lowercased alphanumeric tokens with diacritics folded ("García" → garcia).
 * Splits on every non-alphanumeric, so periods ("T. Okafor"), hyphens,
 * apostrophes, and em-dashes all become token boundaries.
 */
export function nameTokens(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Does the descriptor mention this tenant? Exact token equality only (never
 * substring: "PARKING" ≠ "park"). Significant name tokens are length ≥ 3;
 * length-1–2 tokens (stored initials, particles) are never required and never
 * sufficient — a tenant stored as "J. R." can't match anything (lone-initial
 * guard). Rule: the last significant token (the surname — names are stored
 * first-name-first) must appear as an exact descriptor token, and every other
 * significant token must appear exactly or as its single-letter initial (the
 * truncated "ZELLE FROM RIVERA J" shape). Token sets are order-insensitive,
 * so FIRST-LAST and LAST-FIRST descriptors both work.
 */
function nameMatchesDescriptor(fullName: string, descriptorTokens: ReadonlySet<string>): boolean {
  const significant = nameTokens(fullName).filter((t) => t.length >= 3);
  if (significant.length === 0) return false;
  const surname = significant[significant.length - 1] as string;
  if (!descriptorTokens.has(surname)) return false;
  return significant
    .slice(0, -1)
    .every((t) => descriptorTokens.has(t) || descriptorTokens.has(t.charAt(0)));
}

/**
 * Does this descriptor text mention this one tenant? The same rule
 * `matchTenantName` applies, exposed per-name so a caller can ask how MANY
 * tenants a descriptor names rather than just which one it names first —
 * deposit attribution must refuse to guess when two tenants both match.
 */
export function descriptorNamesTenant(fullName: string, descriptorText: string): boolean {
  return nameMatchesDescriptor(fullName, new Set(nameTokens(descriptorText)));
}

/**
 * First (primary-first) tenant name the descriptor text mentions, else null.
 * Callers build `descriptorText` as `description + ' ' + (vendor ?? '')`.
 */
export function matchTenantName(
  tenantNames: readonly string[],
  descriptorText: string,
): string | null {
  const descriptorTokens = new Set(nameTokens(descriptorText));
  return tenantNames.find((name) => nameMatchesDescriptor(name, descriptorTokens)) ?? null;
}
