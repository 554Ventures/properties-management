// Getting-started checklist for new accounts. Step completion is derived live
// from portfolio data (does a property/tenant/lease/bank feed exist?) so
// progress stays honest no matter where the work happened — the row only
// persists the user's explicit choices: started, skipped steps, dismissed.
// No AuditLog here: onboarding state isn't money/tenant-touching (precedent:
// push.service / integration.service).
import type { OnboardingState, OnboardingStepId, UpdateOnboardingInput } from '@hearth/shared';
import { OnboardingStepIdSchema } from '@hearth/shared';
import { prisma } from '../lib/prisma';

// Display order of the checklist; the shared enum is the source of the ids.
const STEP_ORDER: OnboardingStepId[] = OnboardingStepIdSchema.options;

async function completedSteps(accountId: string): Promise<Set<OnboardingStepId>> {
  const [properties, tenants, leases, bankConnections] = await Promise.all([
    prisma.property.count({ where: { accountId, archivedAt: null } }),
    prisma.tenant.count({ where: { accountId, archivedAt: null } }),
    prisma.lease.count({ where: { unit: { property: { accountId } } } }),
    // Either bank feed (Plaid or Stripe Financial Connections) completes the
    // step. 'mock' is the demo seed's placeholder status (a fresh account has
    // no integration rows at all) — counting it keeps the fully-set-up demo
    // account deriving completed. Connecting for real flips to 'connected'.
    prisma.integration.count({
      where: {
        accountId,
        type: { in: ['plaid', 'stripe_fc'] },
        status: { in: ['connected', 'mock'] },
      },
    }),
  ]);
  const done = new Set<OnboardingStepId>();
  if (properties > 0) done.add('add_property');
  if (tenants > 0) done.add('add_tenant');
  if (leases > 0) done.add('create_lease');
  if (bankConnections > 0) done.add('connect_bank');
  return done;
}

function toApiState(
  storedStatus: string,
  skipped: string[],
  completed: Set<OnboardingStepId>,
): OnboardingState {
  const steps = STEP_ORDER.map((id) => ({
    id,
    state: completed.has(id)
      ? ('completed' as const)
      : skipped.includes(id)
        ? ('skipped' as const)
        : ('pending' as const),
  }));
  const allDone = steps.every((s) => s.state !== 'pending');
  const status = allDone
    ? 'completed'
    : (storedStatus as OnboardingState['status']);
  return { status, steps };
}

export async function getOnboarding(accountId: string): Promise<OnboardingState> {
  const [row, completed] = await Promise.all([
    prisma.onboardingState.findUnique({ where: { accountId } }),
    completedSteps(accountId),
  ]);
  const skipped = row ? (JSON.parse(row.skippedJson) as string[]) : [];
  return toApiState(row?.status ?? 'not_started', skipped, completed);
}

export async function updateOnboarding(
  accountId: string,
  input: UpdateOnboardingInput,
): Promise<OnboardingState> {
  const existing = await prisma.onboardingState.findUnique({ where: { accountId } });
  const skipped = new Set(existing ? (JSON.parse(existing.skippedJson) as string[]) : []);
  if (input.skipStep) skipped.add(input.skipStep);
  const status = input.status ?? existing?.status ?? 'in_progress';
  const skippedJson = JSON.stringify([...skipped]);
  await prisma.onboardingState.upsert({
    where: { accountId },
    create: { accountId, status, skippedJson },
    update: { status, skippedJson },
  });
  return toApiState(status, [...skipped], await completedSteps(accountId));
}
