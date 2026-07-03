// Mock Stripe: fake payment links + immediate 'paid' settlement.
import type { StripeAdapter } from '../types';

let linkCounter = 0;
let paymentCounter = 0;

export const mockStripe: StripeAdapter = {
  async createPaymentLink(ref, amountCents) {
    linkCounter += 1;
    return {
      url: `https://pay.mock.stripe.local/plink_${linkCounter}_${ref}?amount=${amountCents}`,
    };
  },

  async settleImmediately(ref, _amountCents) {
    paymentCounter += 1;
    return { externalRef: `pi_mock_${paymentCounter}_${ref}`, paidAt: new Date() };
  },
};
