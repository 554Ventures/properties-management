// Unit tests for the real Plaid adapter's request/response mapping — run
// entirely against a mocked 'plaid' module (vi.mock at the module level,
// same pattern as ../ai/client in chat-render-tool-regression.test.ts) so
// they stay offline. The highest-risk correctness bug this feature could
// ship is Plaid's inverted amount sign (positive = expense, negative =
// income) — both directions are asserted explicitly below.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const linkTokenCreate = vi.fn();
const itemPublicTokenExchange = vi.fn();
const transactionsSync = vi.fn();
const itemRemove = vi.fn();

vi.mock('plaid', () => ({
  Configuration: class {
    constructor(public opts: unknown) {}
  },
  PlaidApi: class {
    linkTokenCreate = linkTokenCreate;
    itemPublicTokenExchange = itemPublicTokenExchange;
    transactionsSync = transactionsSync;
    itemRemove = itemRemove;
  },
  PlaidEnvironments: { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' },
  CountryCode: { Us: 'US' },
  Products: { Transactions: 'transactions' },
}));

import { createRealPlaidAdapter } from '../integrations/real/real-plaid';

describe('real Plaid adapter', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.PLAID_CLIENT_ID = 'test_client_id';
    process.env.PLAID_SECRET = 'test_secret';
    process.env.PLAID_ENV = 'sandbox';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('creates a link token', async () => {
    linkTokenCreate.mockResolvedValue({ data: { link_token: 'link-abc', expiration: '', request_id: '' } });
    const adapter = createRealPlaidAdapter();
    const result = await adapter.createLinkToken('acct_1');
    expect(result).toEqual({ linkToken: 'link-abc', mock: false });
    expect(linkTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({ user: { client_user_id: 'acct_1' } }),
    );
  });

  it('exchanges a public token for an access token', async () => {
    itemPublicTokenExchange.mockResolvedValue({
      data: { access_token: 'access-xyz', item_id: 'item-1', request_id: '' },
    });
    const adapter = createRealPlaidAdapter();
    const result = await adapter.exchangePublicToken('public-abc');
    expect(result).toEqual({ accessToken: 'access-xyz', itemId: 'item-1' });
  });

  it('maps a positive Plaid amount to an expense', async () => {
    transactionsSync.mockResolvedValue({
      data: {
        added: [
          {
            transaction_id: 't1',
            date: '2026-07-01',
            name: 'LOWES #123',
            merchant_name: "Lowe's",
            amount: 45.5,
          },
        ],
        modified: [],
        removed: [],
        next_cursor: 'cursor-1',
        has_more: false,
      },
    });
    const adapter = createRealPlaidAdapter();
    const { added } = await adapter.syncTransactions('access-xyz', null);
    expect(added).toEqual([
      {
        externalId: 't1',
        date: new Date('2026-07-01'),
        description: 'LOWES #123',
        vendor: "Lowe's",
        amountCents: 4550,
        type: 'expense',
      },
    ]);
  });

  it('maps a negative Plaid amount to income', async () => {
    transactionsSync.mockResolvedValue({
      data: {
        added: [
          {
            transaction_id: 't2',
            date: '2026-07-02',
            name: 'RENT DEPOSIT',
            merchant_name: null,
            amount: -1200,
          },
        ],
        modified: [],
        removed: [],
        next_cursor: 'cursor-2',
        has_more: false,
      },
    });
    const adapter = createRealPlaidAdapter();
    const { added } = await adapter.syncTransactions('access-xyz', null);
    expect(added[0]).toMatchObject({ amountCents: 120000, type: 'income', vendor: null });
  });

  it('loops through has_more pages and returns only the final cursor', async () => {
    transactionsSync
      .mockResolvedValueOnce({
        data: {
          added: [
            { transaction_id: 'p1', date: '2026-07-01', name: 'A', merchant_name: null, amount: 1 },
          ],
          modified: [],
          removed: [],
          next_cursor: 'cursor-page-1',
          has_more: true,
        },
      })
      .mockResolvedValueOnce({
        data: {
          added: [
            { transaction_id: 'p2', date: '2026-07-02', name: 'B', merchant_name: null, amount: 2 },
          ],
          modified: [],
          removed: [],
          next_cursor: 'cursor-page-2',
          has_more: false,
        },
      });
    const adapter = createRealPlaidAdapter();
    const result = await adapter.syncTransactions('access-xyz', null);
    expect(transactionsSync).toHaveBeenCalledTimes(2);
    expect(transactionsSync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: 'cursor-page-1' }),
    );
    expect(result.added.map((t) => t.externalId)).toEqual(['p1', 'p2']);
    expect(result.nextCursor).toBe('cursor-page-2');
  });

  it('maps modified and removed, accumulating across has_more pages', async () => {
    transactionsSync
      .mockResolvedValueOnce({
        data: {
          added: [],
          modified: [
            { transaction_id: 'm1', date: '2026-07-03', name: 'POSTED CHARGE', merchant_name: 'Store', amount: 10 },
          ],
          removed: [{ transaction_id: 'r1' }],
          next_cursor: 'cursor-page-1',
          has_more: true,
        },
      })
      .mockResolvedValueOnce({
        data: {
          added: [],
          modified: [],
          removed: [{ transaction_id: 'r2' }],
          next_cursor: 'cursor-page-2',
          has_more: false,
        },
      });
    const adapter = createRealPlaidAdapter();
    const result = await adapter.syncTransactions('access-xyz', 'cursor-0');
    expect(result.added).toEqual([]);
    expect(result.modified).toEqual([
      {
        externalId: 'm1',
        date: new Date('2026-07-03'),
        description: 'POSTED CHARGE',
        vendor: 'Store',
        amountCents: 1000,
        type: 'expense',
      },
    ]);
    expect(result.removed).toEqual(['r1', 'r2']);
    expect(result.nextCursor).toBe('cursor-page-2');
  });

  it('swallows a failed itemRemove instead of throwing', async () => {
    itemRemove.mockRejectedValue({ response: { data: { error_code: 'ITEM_NOT_FOUND' } } });
    const adapter = createRealPlaidAdapter();
    await expect(adapter.removeItem('access-xyz')).resolves.toBeUndefined();
  });
});
