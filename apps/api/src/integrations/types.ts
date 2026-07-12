// Adapter interfaces (ARCHITECTURE §1 integrations/). v1 ships mocks only;
// real implementations slot in behind the same interfaces.
import type { EsignStatus, TransactionType } from '@hearth/shared';

export interface PlaidBankTransaction {
  externalId: string;
  date: Date;
  description: string;
  vendor: string | null;
  amountCents: number;
  type: TransactionType;
}

export interface PlaidSyncResult {
  added: PlaidBankTransaction[];
  /** Full replacement objects for previously delivered ids (Plaid semantics). */
  modified: PlaidBankTransaction[];
  /** Plaid transaction_ids whose transactions no longer exist bank-side. */
  removed: string[];
  nextCursor: string;
}

export interface PlaidAdapter {
  /** Create a Link token to hand to the frontend's Plaid Link launch. */
  createLinkToken(accountId: string): Promise<{ linkToken: string; mock: boolean }>;
  /** Exchange a Link `public_token` for a long-lived `access_token` + item id. */
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  /**
   * Cursor-based transaction sync (mirrors Plaid's `/transactions/sync`).
   * Pass `cursor: null` for the first sync; persist the returned `nextCursor`
   * and pass it back on the next call.
   */
  syncTransactions(accessToken: string, cursor: string | null): Promise<PlaidSyncResult>;
  /** Revoke access to an item (best-effort on the caller's side). */
  removeItem(accessToken: string): Promise<void>;
}

export interface StripeFcAccountSummary {
  /** Stripe Financial Connections account id (`fca_...`). */
  id: string;
  institutionName: string;
  last4: string | null;
}

export interface StripeFcSession {
  clientSecret: string;
  sessionId: string;
  /** Rides along so the web bundle needs no Stripe build-time env. */
  publishableKey: string;
  mock: boolean;
}

export interface StripeFcSyncResult {
  added: PlaidBankTransaction[];
  /** Status changes (pending → posted) redeliver the same fctxn id. */
  modified: PlaidBankTransaction[];
  /** fctxn ids whose transactions the bank voided. */
  removed: string[];
  /** fca account id → last processed transaction_refresh id. */
  nextCursors: Record<string, string>;
}

/**
 * Stripe Financial Connections — a second bank-transaction feed alongside
 * Plaid (not the deferred 'stripe' rent-payment rail). Flow: createSession →
 * Stripe.js `collectFinancialConnectionsAccounts(clientSecret)` on the client
 * → completeSession retrieves the collected accounts server-side and
 * subscribes each to daily transaction refreshes.
 */
export interface StripeFcAdapter {
  /** Create a Financial Connections Session (reusing the Stripe Customer when given). */
  createSession(accountId: string, existingCustomerId: string | null): Promise<StripeFcSession>;
  /**
   * Retrieve the accounts collected in a completed session and subscribe each
   * to transaction refreshes. Rejects when the session collected no accounts.
   */
  completeSession(
    sessionId: string,
  ): Promise<{ customerId: string | null; accounts: StripeFcAccountSummary[] }>;
  /**
   * Incremental pull mapped onto the same added/modified/removed shape the
   * bank-import pipeline consumes. `cursors` maps fca account id → the last
   * processed transaction_refresh id; pass {} on first sync and persist the
   * returned `nextCursors`.
   */
  syncTransactions(
    accountIds: string[],
    cursors: Record<string, string>,
  ): Promise<StripeFcSyncResult>;
  /** Disconnect every account bank-side (best-effort on the caller's side). */
  disconnectAccounts(accountIds: string[]): Promise<void>;
}

export interface StripeAdapter {
  createPaymentLink(ref: string, amountCents: number): Promise<{ url: string }>;
  /** Mock settlement: resolves immediately as 'paid'. */
  settleImmediately(ref: string, amountCents: number): Promise<{ externalRef: string; paidAt: Date }>;
}

export interface DocusignAdapter {
  sendEnvelope(leaseId: string, signerName: string): Promise<{ envelopeId: string; status: EsignStatus }>;
  /** sent → viewed → signed (stays signed). */
  advanceStatus(current: EsignStatus | null): EsignStatus;
}

export interface StorageAdapter {
  /** Write (or overwrite) the object at `key`. */
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** Read the object at `key`; resolves null when it doesn't exist. */
  get(key: string): Promise<Buffer | null>;
  /** Delete the object at `key` (best-effort: idempotent, missing keys are fine). */
  delete(key: string): Promise<void>;
}

export interface PushMessage {
  title: string;
  body: string;
  /** In-app route the notification tap should open, e.g. "/rent". */
  deepLink?: string;
}

export interface PushSendResult {
  ok: boolean;
  /** APNs said the token is gone (410/BadDeviceToken/Unregistered) — delete the row. */
  unregistered?: boolean;
  reason?: string;
}

export interface PushProvider {
  send(deviceToken: string, message: PushMessage): Promise<PushSendResult>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface EmailAdapter {
  send(message: EmailMessage): Promise<{ messageId: string }>;
}
