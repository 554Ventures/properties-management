// Mock/real Plaid adapter selection, mirroring ai/client.ts's createAiClient().
import { mockPlaid } from './mock/mock-plaid';
import { mockPush } from './mock/mock-push';
import { mockStorage } from './mock/mock-storage';
import { mockStripeFc } from './mock/mock-stripe-fc';
import { createApnsPushProvider } from './real/real-apns';
import { createRealPlaidAdapter } from './real/real-plaid';
import { createRealStorageAdapter } from './real/real-storage';
import { createRealStripeFcAdapter } from './real/real-stripe-fc';
import type { PlaidAdapter, PushProvider, StorageAdapter, StripeFcAdapter } from './types';

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

let realStripeFcAdapter: StripeFcAdapter | undefined;
let stripeFcWarned = false;

/** True once STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY are both set.
 *  No INTEGRATION_ENCRYPTION_KEY in the trio: Stripe FC stores only inert
 *  fca_/cus_ ids, never a bearer credential (see real-stripe-fc.ts). */
export function isRealStripeFcConfigured(): boolean {
  const { STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY } = process.env;
  const configured = [STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY];
  const setCount = configured.filter(Boolean).length;

  if (setCount > 0 && setCount < configured.length && !stripeFcWarned) {
    stripeFcWarned = true;
    console.warn(
      '[stripe_fc] STRIPE_SECRET_KEY/STRIPE_PUBLISHABLE_KEY are partially set — ' +
        'falling back to the mock Stripe Financial Connections adapter until both are configured.',
    );
  }

  return setCount === configured.length;
}

/** Real Stripe FC adapter only when both env vars are set, else the mock. */
export function createStripeFcAdapter(): StripeFcAdapter {
  if (!isRealStripeFcConfigured()) return mockStripeFc;
  if (!realStripeFcAdapter) realStripeFcAdapter = createRealStripeFcAdapter();
  return realStripeFcAdapter;
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

let realPushProvider: PushProvider | undefined;
let pushWarned = false;

/** True once APNS_TEAM_ID/KEY_ID/PRIVATE_KEY/BUNDLE_ID are all set. */
export function isRealPushConfigured(): boolean {
  const { APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY, APNS_BUNDLE_ID } = process.env;
  const configured = [APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY, APNS_BUNDLE_ID];
  const setCount = configured.filter(Boolean).length;

  if (setCount > 0 && setCount < configured.length && !pushWarned) {
    pushWarned = true;
    console.warn(
      '[push] APNS_TEAM_ID/APNS_KEY_ID/APNS_PRIVATE_KEY/APNS_BUNDLE_ID are partially set — ' +
        'falling back to the mock push provider until all four are configured.',
    );
  }

  return setCount === configured.length;
}

/** Real APNs provider only when all APNS_* vars are set, else the mock. */
export function createPushProvider(): PushProvider {
  if (!isRealPushConfigured()) return mockPush;
  if (!realPushProvider) {
    realPushProvider = createApnsPushProvider({
      teamId: process.env.APNS_TEAM_ID!,
      keyId: process.env.APNS_KEY_ID!,
      privateKey: process.env.APNS_PRIVATE_KEY!,
      bundleId: process.env.APNS_BUNDLE_ID!,
      env: process.env.APNS_ENV === 'production' ? 'production' : 'sandbox',
    });
  }
  return realPushProvider;
}
