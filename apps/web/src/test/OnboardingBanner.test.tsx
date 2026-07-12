// Onboarding banner + wizard: the banner never auto-opens anything, hides
// only on derived completion or confirmed dismissal, and the wizard's
// progress round-trips through the (stubbed) API exactly like the real
// server derives it — skips persist, completion is derived, closing loses
// nothing.
import type { OnboardingState, OnboardingStepId, OnboardingStepState } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnboardingBanner } from '../components/onboarding/OnboardingBanner';
import { ToastProvider } from '../components/ui/Toast';

const STEP_IDS: OnboardingStepId[] = [
  'add_property',
  'add_tenant',
  'create_lease',
  'log_transaction',
  'connect_bank',
];

function makeState(
  status: OnboardingState['status'],
  stepStates: OnboardingStepState[], // one per STEP_IDS entry
): OnboardingState {
  return { status, steps: STEP_IDS.map((id, i) => ({ id, state: stepStates[i]! })) };
}

/**
 * Stateful fetch stub that mimics onboarding.service: PATCHes mutate the held
 * state (skips flip a step to skipped; all-done derives completed) and GETs
 * return it. Other endpoints the wizard touches resolve to empty lists.
 */
function stubOnboardingApi(initial: OnboardingState) {
  let state = initial;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const json = (body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    if (path === '/api/v1/onboarding') {
      if (init?.method === 'PATCH') {
        const input = JSON.parse(String(init.body)) as {
          status?: 'in_progress' | 'dismissed';
          skipStep?: OnboardingStepId;
        };
        let steps = state.steps;
        if (input.skipStep) {
          steps = steps.map((s) =>
            s.id === input.skipStep && s.state === 'pending' ? { ...s, state: 'skipped' } : s,
          );
        }
        const allDone = steps.every((s) => s.state !== 'pending');
        state = {
          status: allDone ? 'completed' : (input.status ?? state.status),
          steps,
        };
      }
      return json(state);
    }
    return json([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function patchCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as unknown);
}

function Providers({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OnboardingBanner visibility', () => {
  it('renders nothing when onboarding derived completed', async () => {
    stubOnboardingApi(makeState('completed', ['completed', 'completed', 'completed', 'completed', 'completed']));
    render(<Providers><OnboardingBanner /></Providers>);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByText(/set up your portfolio/i)).not.toBeInTheDocument();
  });

  it('renders nothing when dismissed', async () => {
    stubOnboardingApi(makeState('dismissed', ['pending', 'pending', 'pending', 'pending', 'pending']));
    render(<Providers><OnboardingBanner /></Providers>);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /get started/i })).not.toBeInTheDocument();
  });

  it('shows the welcome CTA for a not-started account and never auto-opens the wizard', async () => {
    stubOnboardingApi(makeState('not_started', ['pending', 'pending', 'pending', 'pending', 'pending']));
    render(<Providers><OnboardingBanner /></Providers>);
    expect(await screen.findByRole('button', { name: 'Get started' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows resume copy and progress once in progress', async () => {
    stubOnboardingApi(makeState('in_progress', ['completed', 'skipped', 'pending', 'pending', 'pending']));
    render(<Providers><OnboardingBanner /></Providers>);
    expect(await screen.findByRole('button', { name: 'Continue setup' })).toBeInTheDocument();
    expect(screen.getByText('2 of 5 steps')).toBeInTheDocument();
  });
});

describe('starting and stopping the wizard', () => {
  it('the CTA marks onboarding in_progress and opens the wizard; closing keeps progress', async () => {
    const fetchMock = stubOnboardingApi(
      makeState('not_started', ['pending', 'pending', 'pending', 'pending', 'pending']),
    );
    render(<Providers><OnboardingBanner /></Providers>);

    fireEvent.click(await screen.findByRole('button', { name: 'Get started' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set up your portfolio' });
    expect(dialog).toBeInTheDocument();
    await waitFor(() => expect(patchCalls(fetchMock)).toContainEqual({ status: 'in_progress' }));

    // Stop at any point: closing the wizard leaves the banner in resume mode.
    fireEvent.click(screen.getByRole('button', { name: 'Save & close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Continue setup' })).toBeInTheDocument();
  });

  it('the lease step is gated until a property exists', async () => {
    stubOnboardingApi(makeState('in_progress', ['pending', 'pending', 'pending', 'pending', 'pending']));
    render(<Providers><OnboardingBanner /></Providers>);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue setup' }));
    await screen.findByRole('dialog', { name: 'Set up your portfolio' });
    expect(screen.getByRole('button', { name: 'Add lease' })).toBeDisabled();
    expect(screen.getByText('Add a property first.')).toBeInTheDocument();
  });

  it('skipping the last pending step derives completion and the banner goes away', async () => {
    const fetchMock = stubOnboardingApi(
      makeState('in_progress', ['completed', 'completed', 'completed', 'skipped', 'pending']),
    );
    render(<Providers><OnboardingBanner /></Providers>);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue setup' }));
    await screen.findByRole('dialog', { name: 'Set up your portfolio' });

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() =>
      expect(patchCalls(fetchMock)).toContainEqual({ skipStep: 'connect_bank' }),
    );

    // Derived completed → celebration state, then Done closes everything.
    expect(await screen.findByText(/you’re all set/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/finish setting up/i)).not.toBeInTheDocument();
  });
});

describe('dismissal', () => {
  it('dismissing asks for confirmation; cancel keeps the banner', async () => {
    const fetchMock = stubOnboardingApi(
      makeState('not_started', ['pending', 'pending', 'pending', 'pending', 'pending']),
    );
    render(<Providers><OnboardingBanner /></Providers>);

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await screen.findByRole('dialog', { name: 'Dismiss setup guide?' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(patchCalls(fetchMock)).toEqual([]);
    expect(screen.getByRole('button', { name: 'Get started' })).toBeInTheDocument();
  });

  it('confirming dismissal persists it and hides the banner', async () => {
    const fetchMock = stubOnboardingApi(
      makeState('not_started', ['pending', 'pending', 'pending', 'pending', 'pending']),
    );
    render(<Providers><OnboardingBanner /></Providers>);

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await screen.findByRole('dialog', { name: 'Dismiss setup guide?' });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss guide' }));

    await waitFor(() => expect(patchCalls(fetchMock)).toContainEqual({ status: 'dismissed' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Get started' })).not.toBeInTheDocument(),
    );
  });
});
