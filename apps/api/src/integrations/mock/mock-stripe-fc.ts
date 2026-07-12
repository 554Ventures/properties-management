// Mock Stripe Financial Connections: a deterministic, cursor-keyed sync
// script mirroring mock-plaid.ts. Unlike mock Plaid there is no stateless
// demo path — the import pipeline only syncs Stripe FC when a connected
// Integration row exists, so the cursor always has a home to persist to:
//   cursors {}                            → 3 `added` transactions
//   cursors {fca_mock_1: 'fctxnref_mock_1'} → 1 `modified` (Home Depot posts
//                                           at a settled amount) + 1 `removed`
//                                           (State Farm pending auth voided)
//   anything later                        → empty steady state
// Amounts deliberately avoid the seed's rent figures (seed-constants.ts) so
// mock FC imports never trigger the review-queue rent match that
// plaid_mock_4 exercises.
import { addDays } from '../../lib/dates';
import type { PlaidBankTransaction, StripeFcAdapter } from '../types';

export const MOCK_FC_SESSION_ID = 'mock_fc_session';
export const MOCK_FC_ACCOUNT_ID = 'fca_mock_1';

function initialBatch(now: Date): PlaidBankTransaction[] {
  return [
    {
      externalId: 'stripe_fc_mock_1',
      date: addDays(now, -1),
      description: 'HOME DEPOT #4521',
      vendor: 'Home Depot',
      amountCents: 8412,
      type: 'expense',
    },
    {
      externalId: 'stripe_fc_mock_2',
      date: addDays(now, -2),
      description: 'STATE FARM INSURANCE PREMIUM',
      vendor: 'State Farm',
      amountCents: 15600,
      type: 'expense',
    },
    {
      externalId: 'stripe_fc_mock_3',
      date: addDays(now, -4),
      description: 'INTEREST PAYMENT',
      vendor: null,
      amountCents: 123,
      type: 'income',
    },
  ];
}

export const mockStripeFc: StripeFcAdapter = {
  async createSession(_accountId, existingCustomerId) {
    void existingCustomerId;
    return {
      clientSecret: 'mock_fc_client_secret',
      sessionId: MOCK_FC_SESSION_ID,
      publishableKey: 'pk_mock',
      mock: true,
    };
  },

  async completeSession(sessionId) {
    // Same guard as mock Plaid's MOCK_PUBLIC_TOKEN: a real Stripe session id
    // must never accidentally route through the mock adapter.
    if (sessionId !== MOCK_FC_SESSION_ID) {
      throw new Error(`mock Stripe FC adapter received an unexpected session id: ${sessionId}`);
    }
    return {
      customerId: 'mock_fc_customer',
      accounts: [{ id: MOCK_FC_ACCOUNT_ID, institutionName: 'Demo Bank', last4: '4321' }],
    };
  },

  async syncTransactions(_accountIds, cursors) {
    const now = new Date();
    const cursor = cursors[MOCK_FC_ACCOUNT_ID] ?? null;
    if (cursor == null) {
      return {
        added: initialBatch(now),
        modified: [],
        removed: [],
        nextCursors: { [MOCK_FC_ACCOUNT_ID]: 'fctxnref_mock_1' },
      };
    }
    if (cursor === 'fctxnref_mock_1') {
      return {
        added: [],
        modified: [
          {
            // The pending Home Depot charge posts with a settled amount.
            externalId: 'stripe_fc_mock_1',
            date: addDays(now, -1),
            description: 'HOME DEPOT #4521 — POSTED',
            vendor: 'Home Depot',
            amountCents: 8550,
            type: 'expense',
          },
        ],
        removed: ['stripe_fc_mock_2'], // State Farm pending auth voided
        nextCursors: { [MOCK_FC_ACCOUNT_ID]: 'fctxnref_mock_2' },
      };
    }
    return { added: [], modified: [], removed: [], nextCursors: cursors };
  },

  async disconnectAccounts(_accountIds) {
    // no-op
  },
};
