// Shared Stripe Financial Connections connect flow, used by the Settings
// integration row and the onboarding wizard's "Connect your bank" step.
// In mock mode (no real Stripe keys configured server-side) connect completes
// immediately with no modal; with real keys it launches Stripe.js's hosted
// bank-auth modal (`collectFinancialConnectionsAccounts`). The publishable key
// arrives with the session response, so the web bundle needs no Stripe
// build-time env.
import { loadStripe } from '@stripe/stripe-js';
import { useState } from 'react';
import { useCompleteStripeFcSession, useCreateStripeFcSession } from '../api/queries';
import { useToast } from '../components/ui/Toast';

export interface StripeFcConnectOptions {
  /** Fires as Stripe's hosted modal opens/closes (real mode only) — e.g. the
      onboarding wizard hides its own dialog so the two never stack. */
  onModalOpenChange?: (open: boolean) => void;
}

export function useStripeFcConnect({ onModalOpenChange }: StripeFcConnectOptions = {}) {
  const { toast } = useToast();
  const createSession = useCreateStripeFcSession();
  const complete = useCompleteStripeFcSession();
  const [modalOpen, setModalOpenState] = useState(false);

  const setModalOpen = (open: boolean) => {
    setModalOpenState(open);
    onModalOpenChange?.(open);
  };

  const finishConnecting = (sessionId: string) => {
    complete.mutate(sessionId, {
      onSuccess: () => toast('Stripe Financial Connections connected.', 'positive'),
      onError: () => toast('Could not finish connecting the bank account. Try again.', 'danger'),
    });
  };

  const launchModal = async (sessionId: string, clientSecret: string, publishableKey: string) => {
    setModalOpen(true);
    try {
      const stripe = await loadStripe(publishableKey);
      if (!stripe) throw new Error('Stripe.js failed to load');
      const result = await stripe.collectFinancialConnectionsAccounts({ clientSecret });
      if (result.error) {
        toast(result.error.message ?? 'Could not connect the bank account.', 'danger');
        return;
      }
      if (result.financialConnectionsSession.accounts.length === 0) {
        // User closed the modal without linking anything — not an error.
        toast('No bank account was linked.', 'neutral');
        return;
      }
      finishConnecting(sessionId);
    } catch {
      toast('Could not open the bank connection window. Try again.', 'danger');
    } finally {
      setModalOpen(false);
    }
  };

  const connect = () => {
    createSession.mutate(undefined, {
      onSuccess: ({ sessionId, clientSecret, publishableKey, mock }) => {
        if (mock) {
          finishConnecting(sessionId);
        } else {
          void launchModal(sessionId, clientSecret, publishableKey);
        }
      },
      onError: () => toast('Could not start the bank connection. Try again.', 'danger'),
    });
  };

  return { connect, busy: createSession.isPending || complete.isPending || modalOpen };
}
