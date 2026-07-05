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
  syncTransactions(
    accessToken: string,
    cursor: string | null,
  ): Promise<{ transactions: PlaidBankTransaction[]; nextCursor: string }>;
  /** Revoke access to an item (best-effort on the caller's side). */
  removeItem(accessToken: string): Promise<void>;
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

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface EmailAdapter {
  send(message: EmailMessage): Promise<{ messageId: string }>;
}
