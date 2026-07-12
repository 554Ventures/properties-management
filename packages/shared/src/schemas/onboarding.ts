import { z } from 'zod';
import {
  OnboardingStatusSchema,
  OnboardingStepIdSchema,
  OnboardingStepStateSchema,
} from '../enums';

// Getting-started checklist for new accounts. Step completion is derived live
// from portfolio data (a property/tenant/lease/transaction exists), so
// progress stays honest no matter where the work happened; only the user's
// explicit choices — started, skipped steps, dismissed — are persisted.
export const OnboardingStepSchema = z.object({
  id: OnboardingStepIdSchema,
  state: OnboardingStepStateSchema,
});

// GET /onboarding + PATCH /onboarding response. `steps` is in display order.
export const OnboardingStateSchema = z.object({
  status: OnboardingStatusSchema,
  steps: z.array(OnboardingStepSchema),
});

// PATCH /onboarding — at least one field. `completed` can never be requested:
// it is derived server-side once every step is completed or skipped.
export const UpdateOnboardingInputSchema = z
  .object({
    status: z.enum(['in_progress', 'dismissed']).optional(),
    skipStep: OnboardingStepIdSchema.optional(),
  })
  .refine((v) => v.status !== undefined || v.skipStep !== undefined, {
    message: 'Provide status or skipStep',
  });
