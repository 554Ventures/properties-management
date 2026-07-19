import { CreateFeedbackInputSchema } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { parseBody } from '../plugins/zod-validation';
import * as feedbackService from '../services/feedback.service';

// Per-account limit on feedback submissions (each one triggers an outbound
// email). Note: read once at route registration (like CHAT_RATE_LIMIT_MAX in
// routes/chat.ts), unlike FEEDBACK_NOTIFY_EMAIL which the service reads at
// call time.
function feedbackWriteLimit() {
  return {
    rateLimit: {
      max: Number(process.env.FEEDBACK_RATE_LIMIT_MAX ?? 10),
      timeWindow: '1 minute',
    },
  };
}

export async function feedbackRoutes(app: FastifyInstance): Promise<void> {
  app.post('/feedback', { config: feedbackWriteLimit() }, async (req, reply) => {
    const input = parseBody(CreateFeedbackInputSchema, req.body);
    const feedback = await feedbackService.create(req.accountId, input, {
      userId: req.userId,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return reply.code(201).send(feedback);
  });
}
