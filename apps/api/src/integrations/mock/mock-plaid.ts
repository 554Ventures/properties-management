// Mock Plaid: returns 3 plausible new bank transactions when the review queue
// is empty, otherwise 0 — so repeated imports don't pile up duplicates.
import { addDays } from '../../lib/dates';
import type { PlaidAdapter, PlaidBankTransaction } from '../types';

let importCounter = 0;

export const mockPlaid: PlaidAdapter = {
  async fetchNewTransactions(_accountRef, { pendingReviewCount }) {
    if (pendingReviewCount > 0) return [];
    importCounter += 1;
    const now = new Date();
    const batch: PlaidBankTransaction[] = [
      {
        externalId: `plaid_mock_${importCounter}_1`,
        date: addDays(now, -1),
        description: 'SHERWIN WILLIAMS #7012',
        vendor: 'Sherwin-Williams',
        amountCents: 9250,
        type: 'expense',
      },
      {
        externalId: `plaid_mock_${importCounter}_2`,
        date: addDays(now, -2),
        description: 'CITY OF SPRINGFIELD ELECTRIC',
        vendor: 'City of Springfield',
        amountCents: 11340,
        type: 'expense',
      },
      {
        externalId: `plaid_mock_${importCounter}_3`,
        date: addDays(now, -3),
        description: 'LOWES #00907',
        vendor: "Lowe's",
        amountCents: 6875,
        type: 'expense',
      },
    ];
    return batch;
  },
};
