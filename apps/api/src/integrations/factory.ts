// Mock/real Plaid adapter selection, mirroring ai/client.ts's createAiClient().
import { mockPlaid } from './mock/mock-plaid';
import { createRealPlaidAdapter } from './real/real-plaid';
import type { PlaidAdapter } from './types';

let realAdapter: PlaidAdapter | undefined;
let warned = false;

/** True once PLAID_CLIENT_ID, PLAID_SECRET, and INTEGRATION_ENCRYPTION_KEY are all set. */
export function isRealPlaidConfigured(): boolean {
  const { PLAID_CLIENT_ID, PLAID_SECRET, INTEGRATION_ENCRYPTION_KEY } = process.env;
  const configured = [PLAID_CLIENT_ID, PLAID_SECRET, INTEGRATION_ENCRYPTION_KEY];
  const setCount = configured.filter(Boolean).length;

  if (setCount > 0 && setCount < configured.length && !warned) {
    warned = true;
    console.warn(
      '[plaid] PLAID_CLIENT_ID/PLAID_SECRET/INTEGRATION_ENCRYPTION_KEY are partially set — ' +
        'falling back to the mock Plaid adapter until all three are configured.',
    );
  }

  return setCount === configured.length;
}

/** Real Plaid adapter only when all three env vars are set, else the mock. */
export function createPlaidAdapter(): PlaidAdapter {
  if (!isRealPlaidConfigured()) return mockPlaid;
  if (!realAdapter) realAdapter = createRealPlaidAdapter();
  return realAdapter;
}
