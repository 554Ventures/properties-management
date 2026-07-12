// Real Stripe Financial Connections adapter. Selected by
// integrations/factory.ts only when STRIPE_SECRET_KEY and
// STRIPE_PUBLISHABLE_KEY are both set. Unlike Plaid there is no stored
// bearer credential: we persist only fca_/cus_ ids, which are inert without
// the secret key, so INTEGRATION_ENCRYPTION_KEY is not required here.
import Stripe from 'stripe';
import type { PlaidBankTransaction, StripeFcAdapter } from '../types';

/** Log only Stripe's structured error surface, never the raw request. */
function stripeError(err: unknown): unknown {
  if (err instanceof Stripe.errors.StripeError) {
    return { type: err.type, code: err.code, message: err.message };
  }
  return err;
}

function toBankTransaction(t: Stripe.FinancialConnections.Transaction): PlaidBankTransaction {
  // Stripe FC amounts are already minor units, negative when money left the
  // account — the OPPOSITE sign convention of Plaid (see real-plaid.ts).
  return {
    externalId: t.id,
    date: new Date(t.transacted_at * 1000),
    description: t.description,
    vendor: null, // FC has no merchant enrichment; description is all we get
    amountCents: Math.abs(t.amount),
    type: t.amount < 0 ? 'expense' : 'income',
  };
}

export function createRealStripeFcAdapter(): StripeFcAdapter {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

  return {
    async createSession(accountId, existingCustomerId) {
      const customerId =
        existingCustomerId ??
        (await stripe.customers.create({ metadata: { hearthAccountId: accountId } })).id;
      const session = await stripe.financialConnections.sessions.create({
        account_holder: { type: 'customer', customer: customerId },
        permissions: ['transactions'],
      });
      if (!session.client_secret) {
        // Nullable in the SDK types, but a freshly created session always
        // carries one — treat its absence as a hard error, not a silent ''.
        throw new Error('Stripe returned a Financial Connections session without a client_secret.');
      }
      return {
        clientSecret: session.client_secret,
        sessionId: session.id,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY!,
        mock: false,
      };
    },

    async completeSession(sessionId) {
      const session = await stripe.financialConnections.sessions.retrieve(sessionId);
      const collected = session.accounts.data;
      if (collected.length === 0) {
        throw new Error('Stripe Financial Connections session collected no accounts.');
      }
      // Daily automatic refreshes; the periodic import then just lists what
      // changed instead of paying for an on-demand refresh per pull.
      for (const account of collected) {
        await stripe.financialConnections.accounts.subscribe(account.id, {
          features: ['transactions'],
        });
      }
      const holder = session.account_holder;
      const customer = holder?.type === 'customer' ? holder.customer : null;
      return {
        customerId: typeof customer === 'string' ? customer : (customer?.id ?? null),
        accounts: collected.map((a) => ({
          id: a.id,
          institutionName: a.institution_name,
          last4: a.last4 ?? null,
        })),
      };
    },

    async syncTransactions(accountIds, cursors) {
      const added: PlaidBankTransaction[] = [];
      const modified: PlaidBankTransaction[] = [];
      const removed: string[] = [];
      const nextCursors: Record<string, string> = { ...cursors };

      for (const accountId of accountIds) {
        const account = await stripe.financialConnections.accounts.retrieve(accountId);
        const refresh = account.transaction_refresh;
        const lastSeen = cursors[accountId];

        // `transaction_refresh[after]` returns only transactions added or
        // updated by refreshes newer than the one we last processed — the FC
        // equivalent of Plaid's sync cursor. Without a stored cursor this is
        // the first pull and everything comes back.
        const listed: Stripe.FinancialConnections.Transaction[] = [];
        const params: Stripe.FinancialConnections.TransactionListParams = {
          account: accountId,
          limit: 100,
          ...(lastSeen ? { transaction_refresh: { after: lastSeen } } : {}),
        };
        for await (const t of stripe.financialConnections.transactions.list(params)) {
          listed.push(t);
        }
        for (const t of listed) {
          if (t.status === 'void') removed.push(t.id);
          else if (lastSeen) modified.push(toBankTransaction(t));
          else added.push(toBankTransaction(t));
        }

        // Only advance the cursor past a completed refresh: while the first
        // (post-subscribe) refresh is still pending the list may be partial,
        // and re-pulling next time is safe — dedup by externalId absorbs it.
        if (refresh && refresh.status === 'succeeded') {
          nextCursors[accountId] = refresh.id;
        }
      }
      return { added, modified, removed, nextCursors };
    },

    async disconnectAccounts(accountIds) {
      for (const accountId of accountIds) {
        try {
          await stripe.financialConnections.accounts.disconnect(accountId);
        } catch (err) {
          // Best-effort: a Stripe-side error must never block the user's
          // local disconnect (same contract as real-plaid's removeItem).
          console.error(
            `[stripe_fc] disconnect failed for ${accountId} (continuing local disconnect)`,
            stripeError(err),
          );
        }
      }
    },
  };
}
