// Mock Plaid: a deterministic, cursor-keyed sync script (stateless — the
// cursor the caller passes back selects the page, mirroring the real
// /transactions/sync contract):
//   cursor null            → the initial batch of 4 `added` transactions
//   cursor 'mock_cursor_1' → 1 `modified` (Sherwin-Williams posts at a new
//                            amount) + 1 `removed` (Lowe's pending auth
//                            voided), exercising both update paths end-to-end
//   anything else          → empty steady state (repeated imports no-op)
// The service only advances the cursor when a connected Integration row
// exists to persist it on; without one (pure demo) every call replays the
// initial batch and transaction.service's externalId dedup keeps it
// idempotent — the same mechanism the real adapter relies on for Plaid's
// retry/redelivery semantics.
import { addDays } from '../../lib/dates';
import type { PlaidAdapter, PlaidBankTransaction } from '../types';

const MOCK_PUBLIC_TOKEN = 'mock-public-token';

function initialBatch(now: Date): PlaidBankTransaction[] {
  return [
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
    {
      // Exercises the review-queue rent match end-to-end: amount equals the
      // seed's OKAFOR_RENT_CENTS (seed-constants.ts — keep in sync) whose
      // current-month RentPayment is late, so this deposit suggests as
      // "T. Okafor's rent".
      externalId: 'plaid_mock_4',
      date: addDays(now, -1),
      description: 'ACH CREDIT — RENT T OKAFOR',
      vendor: 'ACH transfer',
      amountCents: 115000,
      type: 'income',
    },
  ];
}

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

  async syncTransactions(_accessToken, cursor) {
    const now = new Date();
    if (cursor == null) {
      return { added: initialBatch(now), modified: [], removed: [], nextCursor: 'mock_cursor_1' };
    }
    if (cursor === 'mock_cursor_1') {
      return {
        added: [],
        modified: [
          {
            // The pending Sherwin-Williams charge posts with a settled amount.
            externalId: 'plaid_mock_1',
            date: addDays(now, -1),
            description: 'SHERWIN WILLIAMS #7012 — POSTED',
            vendor: 'Sherwin-Williams',
            amountCents: 9310,
            type: 'expense',
          },
        ],
        removed: ['plaid_mock_3'], // Lowe's pending auth voided by the bank
        nextCursor: 'mock_cursor_2',
      };
    }
    return { added: [], modified: [], removed: [], nextCursor: cursor };
  },

  async removeItem(_accessToken) {
    // no-op
  },
};
