import { PeriodSchema, RecordRentPaymentInputSchema, SendRemindersInputSchema } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentPeriod } from '../lib/dates';
import { parseBody, parseQuery } from '../plugins/zod-validation';
import * as rentService from '../services/rent.service';

const TrackerQuerySchema = z.object({ period: PeriodSchema.optional() });

export async function rentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/rent/tracker', async (req) => {
    const q = parseQuery(TrackerQuerySchema, req.query);
    return rentService.getMonthStatus(req.accountId, q.period ?? currentPeriod());
  });

  app.post('/rent/payments', async (req, reply) => {
    const input = parseBody(RecordRentPaymentInputSchema, req.body);
    const payment = await rentService.recordPayment(req.accountId, input);
    return reply.code(201).send(payment);
  });

  app.post<{ Params: { id: string } }>('/rent/payments/:id/payment-link', async (req) =>
    rentService.createPaymentLink(req.accountId, req.params.id),
  );

  app.post('/rent/reminders', async (req) => {
    const input = parseBody(SendRemindersInputSchema, req.body);
    return rentService.sendReminders(req.accountId, input);
  });
}
