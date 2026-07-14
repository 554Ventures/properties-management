// Cross-app derivation constants. Shared so the API rules and the web's badge
// math can never drift apart.

/** A lease ending within this many days counts as "renew soon" everywhere
 *  (tenant status derivation, renewal_window insight, web renewal badges). */
export const RENEW_SOON_DAYS = 60;
