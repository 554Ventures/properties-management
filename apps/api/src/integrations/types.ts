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
  /**
   * Pull new bank transactions. `pendingReviewCount` lets the mock stay
   * idempotent-ish: it returns rows only when the review queue is empty.
   */
  fetchNewTransactions(
    accountRef: string,
    opts: { pendingReviewCount: number },
  ): Promise<PlaidBankTransaction[]>;
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
