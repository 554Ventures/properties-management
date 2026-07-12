import { UpdateOnboardingInputSchema } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { parseBody } from '../plugins/zod-validation';
import * as onboardingService from '../services/onboarding.service';

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/onboarding', async (req) => onboardingService.getOnboarding(req.accountId));

  app.patch('/onboarding', async (req) => {
    const input = parseBody(UpdateOnboardingInputSchema, req.body);
    return onboardingService.updateOnboarding(req.accountId, input);
  });
}
