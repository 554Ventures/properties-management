// Getting-started banner (Dashboard). Never auto-launches anything: the
// wizard opens only from the CTA. Hidden once onboarding derives completed or
// the user dismisses it — dismissal always confirms first, because it's
// permanent (the banner won't come back). Renders nothing while loading or on
// error: the banner is optional chrome and must never block the dashboard.
import { useState } from 'react';
import { useOnboarding, useUpdateOnboarding } from '../../api/queries';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ProgressBar } from '../ui/ProgressBar';
import { OnboardingWizard } from './OnboardingWizard';

export function OnboardingBanner() {
  const onboarding = useOnboarding();
  const update = useUpdateOnboarding();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (onboarding.isPending || onboarding.isError) return null;
  const state = onboarding.data;

  // Keep the wizard mounted when completion happens mid-session so the user
  // sees the "all set" state instead of the dialog vanishing under them.
  const hidden = state.status === 'completed' || state.status === 'dismissed';
  if (hidden && !wizardOpen) return null;

  const started = state.status === 'in_progress';
  const doneCount = state.steps.filter((s) => s.state !== 'pending').length;

  const startSetup = () => {
    if (!started) update.mutate({ status: 'in_progress' });
    setWizardOpen(true);
  };

  return (
    <>
      {/* Not `Card`: its baked-in bg-surface would conflict with the brand
          tint (same specificity, stylesheet order decides). */}
      {!hidden && (
        <div className="min-w-0 rounded-lg border border-border bg-brand-soft p-5 shadow-card">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">
                {started ? 'Finish setting up your portfolio' : 'Welcome! Let’s set up your portfolio'}
              </h2>
              <p className="mt-1 text-sm text-ink-muted">
                {started
                  ? 'Pick up where you left off — your progress is saved.'
                  : 'A few quick steps to get your properties, tenants, and money in one place. Stop anytime; your progress is saved.'}
              </p>
              {started && (
                <ProgressBar
                  className="mt-2 max-w-xs"
                  value={doneCount}
                  max={state.steps.length}
                  label="Setup progress"
                  text={`${doneCount} of ${state.steps.length} steps`}
                />
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button onClick={startSetup}>{started ? 'Continue setup' : 'Get started'}</Button>
              <Button variant="ghost" onClick={() => setConfirmOpen(true)}>
                Dismiss
              </Button>
            </div>
          </div>
        </div>
      )}

      <OnboardingWizard open={wizardOpen} onClose={() => setWizardOpen(false)} state={state} />

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() =>
          update.mutate(
            { status: 'dismissed' },
            { onSuccess: () => setConfirmOpen(false) },
          )
        }
        title="Dismiss setup guide?"
        body="The guide won’t be shown again. You can still add properties, tenants, and leases from their own pages at any time."
        confirmLabel="Dismiss guide"
        confirmVariant="primary"
        busy={update.isPending}
      />
    </>
  );
}
