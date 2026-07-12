// Unit tests for the real Stripe Financial Connections adapter's
// request/response mapping — run entirely against a mocked 'stripe' module
// (same pattern as real-plaid.test.ts) so they stay offline. The
// highest-risk correctness bug here is the amount sign: Stripe FC is
// negative = money out (the OPPOSITE of Plaid's convention) — both
// directions are asserted explicitly below.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const customersCreate = vi.fn();
const sessionsCreate = vi.fn();
const sessionsRetrieve = vi.fn();
const accountsRetrieve = vi.fn();
const accountsSubscribe = vi.fn();
const accountsDisconnect = vi.fn();
const transactionsList = vi.fn();

vi.mock('stripe', () => {
  class StripeError extends Error {
    type = 'api_error';
    code = 'mock';
  }
  class MockStripe {
    customers = { create: customersCreate };
    financialConnections = {
      sessions: { create: sessionsCreate, retrieve: sessionsRetrieve },
      accounts: {
        retrieve: accountsRetrieve,
        subscribe: accountsSubscribe,
        disconnect: accountsDisconnect,
      },
      transactions: { list: transactionsList },
    };
    static errors = { StripeError };
  }
  return { default: MockStripe };
});

import { createRealStripeFcAdapter } from '../integrations/real/real-stripe-fc';

/** stripe-node list calls are async-iterable (auto-pagination). */
function asyncList<T>(items: T[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

describe('real Stripe FC adapter', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_123';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('createSession creates a Stripe Customer when none exists yet', async () => {
    customersCreate.mockResolvedValue({ id: 'cus_new' });
    sessionsCreate.mockResolvedValue({ id: 'fcsess_1', client_secret: 'fcsess_secret_1' });
    const adapter = createRealStripeFcAdapter();
    const result = await adapter.createSession('acct_1', null);
    expect(customersCreate).toHaveBeenCalledWith({ metadata: { hearthAccountId: 'acct_1' } });
    expect(sessionsCreate).toHaveBeenCalledWith({
      account_holder: { type: 'customer', customer: 'cus_new' },
      permissions: ['transactions'],
    });
    expect(result).toEqual({
      clientSecret: 'fcsess_secret_1',
      sessionId: 'fcsess_1',
      publishableKey: 'pk_test_123',
      mock: false,
    });
  });

  it('createSession reuses an existing Stripe Customer across reconnects', async () => {
    sessionsCreate.mockResolvedValue({ id: 'fcsess_2', client_secret: 'fcsess_secret_2' });
    const adapter = createRealStripeFcAdapter();
    await adapter.createSession('acct_1', 'cus_existing');
    expect(customersCreate).not.toHaveBeenCalled();
    expect(sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ account_holder: { type: 'customer', customer: 'cus_existing' } }),
    );
  });

  it('createSession rejects a session missing its client_secret instead of returning it empty', async () => {
    customersCreate.mockResolvedValue({ id: 'cus_new' });
    sessionsCreate.mockResolvedValue({ id: 'fcsess_3', client_secret: null });
    const adapter = createRealStripeFcAdapter();
    await expect(adapter.createSession('acct_1', null)).rejects.toThrow(/client_secret/);
  });

  it('completeSession subscribes every collected account to transaction refreshes', async () => {
    sessionsRetrieve.mockResolvedValue({
      id: 'fcsess_1',
      account_holder: { type: 'customer', customer: 'cus_1' },
      accounts: {
        data: [
          { id: 'fca_1', institution_name: 'First Bank', last4: '1234' },
          { id: 'fca_2', institution_name: 'First Bank', last4: null },
        ],
      },
    });
    accountsSubscribe.mockResolvedValue({});
    const adapter = createRealStripeFcAdapter();
    const result = await adapter.completeSession('fcsess_1');
    expect(accountsSubscribe).toHaveBeenCalledTimes(2);
    expect(accountsSubscribe).toHaveBeenCalledWith('fca_1', { features: ['transactions'] });
    expect(result).toEqual({
      customerId: 'cus_1',
      accounts: [
        { id: 'fca_1', institutionName: 'First Bank', last4: '1234' },
        { id: 'fca_2', institutionName: 'First Bank', last4: null },
      ],
    });
  });

  it('completeSession rejects a session that collected no accounts (user closed the modal)', async () => {
    sessionsRetrieve.mockResolvedValue({
      id: 'fcsess_1',
      account_holder: { type: 'customer', customer: 'cus_1' },
      accounts: { data: [] },
    });
    const adapter = createRealStripeFcAdapter();
    await expect(adapter.completeSession('fcsess_1')).rejects.toThrow(/no accounts/);
    expect(accountsSubscribe).not.toHaveBeenCalled();
  });

  it('first sync (no cursor): maps amount sign (negative = expense), voids to removed, advances the cursor', async () => {
    accountsRetrieve.mockResolvedValue({
      id: 'fca_1',
      transaction_refresh: { id: 'fctxnref_1', status: 'succeeded' },
    });
    transactionsList.mockReturnValue(
      asyncList([
        {
          id: 'fctxn_out',
          amount: -8412, // money left the account → expense
          currency: 'usd',
          description: 'HOME DEPOT',
          status: 'posted',
          transacted_at: 1_751_500_800, // 2025-07-03T00:00:00Z
        },
        {
          id: 'fctxn_in',
          amount: 115000, // money came in → income
          currency: 'usd',
          description: 'ACH CREDIT RENT',
          status: 'pending',
          transacted_at: 1_751_500_800,
        },
        {
          id: 'fctxn_void',
          amount: -500,
          currency: 'usd',
          description: 'VOIDED AUTH',
          status: 'void',
          transacted_at: 1_751_500_800,
        },
      ]),
    );
    const adapter = createRealStripeFcAdapter();
    const result = await adapter.syncTransactions(['fca_1'], {});
    // No stored cursor → no transaction_refresh[after] filter on the list.
    expect(transactionsList).toHaveBeenCalledWith({ account: 'fca_1', limit: 100 });
    expect(result.added).toEqual([
      {
        externalId: 'fctxn_out',
        date: new Date(1_751_500_800 * 1000),
        description: 'HOME DEPOT',
        vendor: null,
        amountCents: 8412,
        type: 'expense',
      },
      {
        externalId: 'fctxn_in',
        date: new Date(1_751_500_800 * 1000),
        description: 'ACH CREDIT RENT',
        vendor: null,
        amountCents: 115000,
        type: 'income',
      },
    ]);
    expect(result.modified).toEqual([]);
    expect(result.removed).toEqual(['fctxn_void']);
    expect(result.nextCursors).toEqual({ fca_1: 'fctxnref_1' });
  });

  it('incremental sync: filters by transaction_refresh[after] and delivers changes as modified', async () => {
    accountsRetrieve.mockResolvedValue({
      id: 'fca_1',
      transaction_refresh: { id: 'fctxnref_2', status: 'succeeded' },
    });
    transactionsList.mockReturnValue(
      asyncList([
        {
          id: 'fctxn_out',
          amount: -8550,
          currency: 'usd',
          description: 'HOME DEPOT — POSTED',
          status: 'posted',
          transacted_at: 1_751_500_800,
        },
      ]),
    );
    const adapter = createRealStripeFcAdapter();
    const result = await adapter.syncTransactions(['fca_1'], { fca_1: 'fctxnref_1' });
    expect(transactionsList).toHaveBeenCalledWith({
      account: 'fca_1',
      limit: 100,
      transaction_refresh: { after: 'fctxnref_1' },
    });
    expect(result.added).toEqual([]);
    expect(result.modified).toHaveLength(1);
    expect(result.modified[0]).toMatchObject({ externalId: 'fctxn_out', amountCents: 8550 });
    expect(result.nextCursors).toEqual({ fca_1: 'fctxnref_2' });
  });

  it('does not advance the cursor while the refresh is still pending (re-pull is dedup-safe)', async () => {
    accountsRetrieve.mockResolvedValue({
      id: 'fca_1',
      transaction_refresh: { id: 'fctxnref_pending', status: 'pending' },
    });
    transactionsList.mockReturnValue(asyncList([]));
    const adapter = createRealStripeFcAdapter();
    const result = await adapter.syncTransactions(['fca_1'], {});
    expect(result.nextCursors).toEqual({});
  });

  it('disconnectAccounts is best-effort: a Stripe-side error never rejects', async () => {
    accountsDisconnect
      .mockRejectedValueOnce(new Error('stripe down'))
      .mockResolvedValueOnce({});
    const adapter = createRealStripeFcAdapter();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(adapter.disconnectAccounts(['fca_1', 'fca_2'])).resolves.toBeUndefined();
    expect(accountsDisconnect).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });
});
