// Guided getting-started checklist. Step completion is derived server-side
// from real portfolio data, so anything the user creates here (or anywhere
// else in the app) checks off automatically; closing at any point loses
// nothing. Only one dialog is on screen at a time: the wizard hides itself
// while one of the shared form modals is open (stacked focus traps would
// fight over Tab/Escape).
import { ASSISTANT_NAME, type OnboardingState, type OnboardingStepId } from '@hearth/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePropertyDetail, useProperties, useUpdateOnboarding } from '../../api/queries';
import { LeaseFormModal } from '../forms/LeaseFormModal';
import { PropertyFormModal } from '../forms/PropertyFormModal';
import { TenantFormModal } from '../forms/TenantFormModal';
import { Button, buttonClasses } from '../ui/Button';
import { IconCheck } from '../ui/icons';
import { Modal } from '../ui/Modal';
import { ProgressBar } from '../ui/ProgressBar';

const STEP_META: Record<
  OnboardingStepId,
  { title: string; description: string; actionLabel: string }
> = {
  add_property: {
    title: 'Add your first property',
    description: 'An address and how many units it has — that’s all it takes.',
    actionLabel: 'Add property',
  },
  add_tenant: {
    title: 'Add a tenant',
    description: 'Who lives there? A name is enough; contact details can come later.',
    actionLabel: 'Add tenant',
  },
  create_lease: {
    title: 'Create a lease',
    description:
      'Connect a tenant to a unit with rent and dates — this powers the rent tracker.',
    actionLabel: 'Add lease',
  },
  log_transaction: {
    title: 'Log your first transaction',
    description: 'Record an income or expense so your cash flow starts from day one.',
    actionLabel: 'Go to Add transaction',
  },
  connect_bank: {
    title: 'Connect your bank',
    description:
      'Link your bank once and new transactions import for review automatically — no manual entry.',
    actionLabel: 'Connect in Settings',
  },
};

type ActiveForm = 'property' | 'tenant' | 'lease' | null;

export interface OnboardingWizardProps {
  open: boolean;
  onClose: () => void;
  state: OnboardingState;
}

export function OnboardingWizard({ open, onClose, state }: OnboardingWizardProps) {
  const update = useUpdateOnboarding();
  const [activeForm, setActiveForm] = useState<ActiveForm>(null);

  const properties = useProperties();
  const firstPropertyId = properties.data?.[0]?.id;
  // Fetched lazily (enabled iff an id exists) to hand the lease form a vacant
  // unit without making the user pick one mid-onboarding.
  const propertyDetail = usePropertyDetail(open ? firstPropertyId : undefined);
  const leaseUnit =
    propertyDetail.data?.units.find((u) => u.status === 'vacant' && u.archivedAt === null) ?? null;
  const leaseUnitLabel = propertyDetail.data
    ? `${propertyDetail.data.property.nickname ?? propertyDetail.data.property.addressLine1} · ${leaseUnit?.label ?? ''}`
    : undefined;

  const doneCount = state.steps.filter((s) => s.state !== 'pending').length;
  const allDone = doneCount === state.steps.length;
  const hasProperty = state.steps.find((s) => s.id === 'add_property')?.state === 'completed';

  const stepAction = (id: OnboardingStepId) => {
    switch (id) {
      case 'add_property':
        return (
          <Button size="sm" onClick={() => setActiveForm('property')}>
            {STEP_META[id].actionLabel}
          </Button>
        );
      case 'add_tenant':
        return (
          <Button size="sm" onClick={() => setActiveForm('tenant')}>
            {STEP_META[id].actionLabel}
          </Button>
        );
      case 'create_lease':
        if (!hasProperty || !leaseUnit) {
          return (
            <div className="flex flex-col items-start gap-1">
              <Button size="sm" disabled>
                {STEP_META[id].actionLabel}
              </Button>
              <p className="text-xs text-ink-faint">
                {hasProperty ? 'All units are already leased.' : 'Add a property first.'}
              </p>
            </div>
          );
        }
        return (
          <Button size="sm" onClick={() => setActiveForm('lease')}>
            {STEP_META[id].actionLabel}
          </Button>
        );
      // Real pages, not modals — leaving the wizard is fine because progress
      // is saved server-side and the banner offers the way back.
      case 'log_transaction':
        return (
          <Link to="/money/new" className={buttonClasses('primary', 'sm')} onClick={onClose}>
            {STEP_META[id].actionLabel}
          </Link>
        );
      case 'connect_bank':
        return (
          <Link to="/settings" className={buttonClasses('primary', 'sm')} onClick={onClose}>
            {STEP_META[id].actionLabel}
          </Link>
        );
    }
  };

  return (
    <>
      <Modal
        open={open && activeForm === null}
        onClose={onClose}
        title="Set up your portfolio"
        size="lg"
        footer={
          allDone ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <Button variant="secondary" onClick={onClose}>
              Save & close
            </Button>
          )
        }
      >
        <div className="flex flex-col gap-4">
          {allDone ? (
            <p className="text-sm text-ink">
              You’re all set — your portfolio, tenants, and money now live in one place.{' '}
              {ASSISTANT_NAME}’s insights get sharper as more activity comes in.
            </p>
          ) : (
            <>
              <p className="text-sm text-ink-muted">
                Your progress is saved automatically — close this anytime and pick up where you
                left off.
              </p>
              <ProgressBar
                value={doneCount}
                max={state.steps.length}
                label="Setup progress"
                text={`${doneCount} of ${state.steps.length} steps`}
              />
            </>
          )}

          <ol className="flex flex-col divide-y divide-border">
            {state.steps.map((step, index) => (
              <li key={step.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-xs font-medium text-ink-muted"
                >
                  {step.state === 'completed' ? (
                    <span className="text-positive">
                      <IconCheck size={14} />
                    </span>
                  ) : (
                    index + 1
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-ink">
                    {STEP_META[step.id].title}
                    {step.state === 'completed' && (
                      <span className="ml-2 text-xs font-medium text-positive">Done</span>
                    )}
                    {step.state === 'skipped' && (
                      <span className="ml-2 text-xs font-medium text-ink-faint">Skipped</span>
                    )}
                  </h3>
                  <p className="mt-0.5 text-sm text-ink-muted">{STEP_META[step.id].description}</p>
                  {step.state === 'pending' && (
                    <div className="mt-2 flex items-center gap-2">
                      {stepAction(step.id)}
                      <Button
                        variant="ghost"
                        size="sm"
                        busy={update.isPending && update.variables?.skipStep === step.id}
                        onClick={() => update.mutate({ skipStep: step.id })}
                      >
                        Skip
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </Modal>

      <PropertyFormModal
        mode="create"
        open={activeForm === 'property'}
        onClose={() => setActiveForm(null)}
        stayOnCreate
      />
      <TenantFormModal
        mode="create"
        open={activeForm === 'tenant'}
        onClose={() => setActiveForm(null)}
      />
      <LeaseFormModal
        mode="create"
        open={activeForm === 'lease'}
        onClose={() => setActiveForm(null)}
        unitId={leaseUnit?.id}
        unitLabel={leaseUnitLabel}
        suggestedRentCents={leaseUnit?.marketRentCents ?? null}
      />
    </>
  );
}
