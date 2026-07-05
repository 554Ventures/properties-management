// Real Plaid adapter (Sandbox or Production, per PLAID_ENV). Selected by
// integrations/factory.ts only when PLAID_CLIENT_ID/PLAID_SECRET/
// INTEGRATION_ENCRYPTION_KEY are all set.
import { Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products } from 'plaid';
import type { PlaidAdapter, PlaidBankTransaction } from '../types';

function plaidError(err: unknown): unknown {
  // Never log the full Axios error — it echoes the request headers, which
  // include PLAID-SECRET.
  if (err && typeof err === 'object' && 'response' in err) {
    const response = (err as { response?: { data?: unknown } }).response;
    return response?.data ?? err;
  }
  return err;
}

function toBankTransaction(t: {
  transaction_id: string;
  date: string;
  name: string;
  merchant_name?: string | null;
  amount: number;
}): PlaidBankTransaction {
  // Plaid's amount sign is the OPPOSITE of naive intuition: positive means
  // money left the account (expense), negative means money came in (income).
  return {
    externalId: t.transaction_id,
    date: new Date(t.date),
    description: t.name,
    vendor: t.merchant_name ?? null,
    amountCents: Math.round(Math.abs(t.amount) * 100),
    type: t.amount > 0 ? 'expense' : 'income',
  };
}

export function createRealPlaidAdapter(): PlaidAdapter {
  const env = process.env.PLAID_ENV === 'production' ? 'production' : 'sandbox';
  const client = new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[env],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
          'PLAID-SECRET': process.env.PLAID_SECRET,
          'Plaid-Version': '2020-09-14',
        },
      },
    }),
  );

  return {
    async createLinkToken(accountId) {
      const res = await client.linkTokenCreate({
        user: { client_user_id: accountId },
        client_name: '554 Properties',
        products: [Products.Transactions],
        country_codes: [CountryCode.Us],
        language: 'en',
      });
      return { linkToken: res.data.link_token, mock: false };
    },

    async exchangePublicToken(publicToken) {
      const res = await client.itemPublicTokenExchange({ public_token: publicToken });
      return { accessToken: res.data.access_token, itemId: res.data.item_id };
    },

    async syncTransactions(accessToken, cursor) {
      const transactions: PlaidBankTransaction[] = [];
      let nextCursor = cursor ?? undefined;
      let hasMore = true;
      while (hasMore) {
        const res = await client.transactionsSync({
          access_token: accessToken,
          cursor: nextCursor,
        });
        transactions.push(...res.data.added.map(toBankTransaction));
        nextCursor = res.data.next_cursor;
        hasMore = res.data.has_more;
      }
      return { transactions, nextCursor: nextCursor ?? '' };
    },

    async removeItem(accessToken) {
      try {
        await client.itemRemove({ access_token: accessToken });
      } catch (err) {
        // Best-effort: a transient Plaid-side error must never block the
        // user's local disconnect.
        console.error('[plaid] itemRemove failed (continuing local disconnect)', plaidError(err));
      }
    },
  };
}
