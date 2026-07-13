// Shared Stripe Financial Connections connect flow, used by the Settings
// integration row and the onboarding wizard's "Connect your bank" step.
// In mock mode (no real Stripe keys configured server-side) connect completes
// immediately with no modal; with real keys it launches Stripe.js's hosted
// bank-auth modal (`collectFinancialConnectionsAccounts`). The publishable key
// arrives with the session response, so the web bundle needs no Stripe
// build-time env.
//
// A successful connect immediately chains the first bank import so the flow
// doesn't dead-end on a toast: the user's transactions land in the review
// queue right away, and the toast's CTA deep-links there instead of leaving
// them to discover the Money page's "Import from bank" button.
import { loadStripe } from '@stripe/stripe-js';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiClientError } from '../api/client';
import { useCompleteStripeFcSession, useCreateStripeFcSession, useImportTransactions } from '../api/queries';
import { useToast } from '../components/ui/Toast';
import { importToastMessage } from './importToastMessage';

export interface StripeFcConnectOptions {
  /** Fires as Stripe's hosted modal opens/closes (real mode only) — e.g. the
      onboarding wizard hides its own dialog so the two never stack. */
  onModalOpenChange?: (open: boolean) => void;
}

export function useStripeFcConnect({ onModalOpenChange }: StripeFcConnectOptions = {}) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const createSession = useCreateStripeFcSession();
  const complete = useCompleteStripeFcSession();
  const importBank = useImportTransactions();
  const [modalOpen, setModalOpenState] = useState(false);

  const setModalOpen = (open: boolean) => {
    setModalOpenState(open);
    onModalOpenChange?.(open);
  };

  const runFirstImport = () => {
    importBank.mutate(undefined, {
      onSuccess: (res) => {
        const { message } = importToastMessage(res, true);
        toast(
          `Bank connected. ${message}`,
          'positive',
          res.imported > 0
            ? { label: 'Review transactions', onClick: () => navigate('/money/review') }
            : undefined,
        );
      },
      onError: (err) => {
        // Reconnecting shortly after a sync trips the server-side import
        // cooldown — the connection itself is fine.
        if (err instanceof ApiClientError && err.code === 'import_rate_limited') {
          toast('Bank connected — transactions were already imported recently.', 'positive', {
            label: 'Go to Money',
            onClick: () => navigate('/money'),
          });
          return;
        }
        toast(
          'Bank connected, but the first import failed. Use "Import from bank" on the Money page.',
          'neutral',
          { label: 'Go to Money', onClick: () => navigate('/money') },
        );
      },
    });
  };

  const finishConnecting = (sessionId: string) => {
    complete.mutate(sessionId, {
      onSuccess: runFirstImport,
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

  // The post-connect import intentionally isn't part of `busy` — the
  // connection is done at that point and the import announces itself via
  // toast when it lands.
  return { connect, busy: createSession.isPending || complete.isPending || modalOpen };
}
