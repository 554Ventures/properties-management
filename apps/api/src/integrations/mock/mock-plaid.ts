// Mock Plaid: a fixed, stateless batch of 3 plausible fake bank transactions.
// Idempotency (don't re-import the same fake transactions on repeated clicks)
// is handled centrally by transaction.service's externalId dedup check, the
// same mechanism the real adapter relies on for Plaid's retry/redelivery
// semantics — so the mock doesn't need its own import-counter/gating state.
import { addDays } from '../../lib/dates';
import type { PlaidAdapter, PlaidBankTransaction } from '../types';

const MOCK_PUBLIC_TOKEN = 'mock-public-token';

export const mockPlaid: PlaidAdapter = {
  async createLinkToken(_accountId) {
    return { linkToken: 'mock_link_token', mock: true };
  },

  async exchangePublicToken(publicToken) {
    if (publicToken !== MOCK_PUBLIC_TOKEN) {
      throw new Error(`mock Plaid adapter received an unexpected public token: ${publicToken}`);
    }
    return { accessToken: 'mock_access_token', itemId: 'mock_item_id' };
  },

  async syncTransactions(_accessToken, _cursor) {
    const now = new Date();
    const transactions: PlaidBankTransaction[] = [
      {
        externalId: 'plaid_mock_1',
        date: addDays(now, -1),
        description: 'SHERWIN WILLIAMS #7012',
        vendor: 'Sherwin-Williams',
        amountCents: 9250,
        type: 'expense',
      },
      {
        externalId: 'plaid_mock_2',
        date: addDays(now, -2),
        description: 'CITY OF SPRINGFIELD ELECTRIC',
        vendor: 'City of Springfield',
        amountCents: 11340,
        type: 'expense',
      },
      {
        externalId: 'plaid_mock_3',
        date: addDays(now, -3),
        description: 'LOWES #00907',
        vendor: "Lowe's",
        amountCents: 6875,
        type: 'expense',
      },
    ];
    return { transactions, nextCursor: 'mock_cursor_1' };
  },

  async removeItem(_accessToken) {
    // no-op
  },
};
