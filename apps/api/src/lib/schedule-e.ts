// IRS Schedule E line mapping. `Category.irsScheduleELine` is free text (no
// Prisma enum — see the schema header), so the labels the report service
// branches on live here, beside the rule that reads them.
//
// TWO ORTHOGONAL AXES decide how a money row is treated, and conflating them is
// exactly the bug this module exists to prevent:
//   • `Transaction.classification` (lib/pnl.ts) decides whether a row counts in
//     the books AT ALL — transfers and owner contributions never do.
//   • `Category.irsScheduleELine` decides which IRS line a row that DOES count
//     lands on. A non-rental receipt (a tax refund, bank interest) is real
//     income for your P&L but is not Schedule E rental income, so it carries
//     NOT_ON_SCHEDULE_E and stays out of "Rents received".
// Marking a deposit "Not Rental Income" therefore changes its tax line, not its
// P&L participation; the Treatment select is still the tool for "this was never
// income".

export const SCHEDULE_E_RENTS_LINE = 'Line 3 – Rents received';

/** Where an expense with no mapped line falls (Schedule E's catch-all). */
export const SCHEDULE_E_OTHER_EXPENSE_LINE = 'Line 19 – Other';

/** Sentinel for income that is a real receipt but not rental income. Schedule E
 *  has no "other income" line for rentals — Line 3 is rents and Line 4 is
 *  royalties — so these belong off the form entirely, reported separately. */
export const NOT_ON_SCHEDULE_E = 'Not reported on Schedule E';

/** The system income category carrying NOT_ON_SCHEDULE_E. Seeded for every
 *  account (prisma/seed-constants.ts SEED_CATEGORIES). */
export const NON_RENTAL_INCOME_CATEGORY = 'Not Rental Income';

/**
 * Does this income category land on "Rents received"?
 *
 * Uncategorized income counts as rents: for a landlord an unlabeled deposit is
 * overwhelmingly rent, and Line 3 is where the ledger reconciles against the
 * rent roll. Only an explicit off-Line-3 mapping moves money out of it.
 */
export function isScheduleERentsLine(line: string | null | undefined): boolean {
  return (line ?? SCHEDULE_E_RENTS_LINE) === SCHEDULE_E_RENTS_LINE;
}

/**
 * Bank-descriptor patterns for income that probably isn't rent, shared by the
 * review-queue suggester (transaction.service) and the misfiled_income insight
 * (insight.service) so a row can't be suggested one way and flagged the other.
 *
 * Confidence is split deliberately against BULK_CONFIRM_MIN_CONFIDENCE (0.7):
 *   • Unambiguous non-rental receipts (US Treasury / IRS refunds, bank
 *     interest, dividends) sit at keyword strength — a bulk confirm may act on
 *     them, because "not rent" is the safe answer either way.
 *   • Transfer-shaped descriptors sit BELOW the threshold on purpose. The right
 *     answer for those is usually a `transfer`/`owner_contribution` treatment,
 *     which a category suggestion cannot set, so a human has to look.
 */
export const NON_RENTAL_INCOME_RULES: Array<{ pattern: RegExp; confidence: number }> = [
  // "IRS TREAS 310 TAX REF", "US TREASURY 310", "TAX REFUND"
  { pattern: /treas\s*310|\birs\b|us\s*treasury|tax\s*ref/i, confidence: 0.84 },
  { pattern: /\b(interest|dividend|div\s*pmt)\b/i, confidence: 0.84 },
  { pattern: /\b(transfer|xfer)\b|from\s+(checking|savings|personal)/i, confidence: 0.5 },
];

/** First matching rule for a bank descriptor, or null. */
export function matchNonRentalIncome(text: string): { confidence: number } | null {
  return NON_RENTAL_INCOME_RULES.find((r) => r.pattern.test(text)) ?? null;
}
