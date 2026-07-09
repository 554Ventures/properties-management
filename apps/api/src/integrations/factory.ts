// Mock/real Plaid adapter selection, mirroring ai/client.ts's createAiClient().
import { mockPlaid } from './mock/mock-plaid';
import { mockStorage } from './mock/mock-storage';
import { createRealPlaidAdapter } from './real/real-plaid';
import { createRealStorageAdapter } from './real/real-storage';
import type { PlaidAdapter, StorageAdapter } from './types';

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

let realStorageAdapter: StorageAdapter | undefined;
let storageWarned = false;

/** True once SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both set. */
export function isRealStorageConfigured(): boolean {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  const configured = [SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY];
  const setCount = configured.filter(Boolean).length;

  if (setCount > 0 && setCount < configured.length && !storageWarned) {
    storageWarned = true;
    console.warn(
      '[storage] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are partially set — ' +
        'falling back to the mock filesystem storage adapter until both are configured.',
    );
  }

  return setCount === configured.length;
}

/** Real Supabase Storage adapter only when both env vars are set, else the mock. */
export function createStorageAdapter(): StorageAdapter {
  if (!isRealStorageConfigured()) return mockStorage;
  if (!realStorageAdapter) realStorageAdapter = createRealStorageAdapter();
  return realStorageAdapter;
}
