import { PeriodSchema, RecordRentPaymentInputSchema, SendRemindersInputSchema } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../lib/authz';
import { currentPeriod } from '../lib/dates';
import { parseBody, parseQuery } from '../plugins/zod-validation';
import * as rentService from '../services/rent.service';

const TrackerQuerySchema = z.object({ period: PeriodSchema.optional() });

export async function rentRoutes(app: FastifyInstance): Promise<void> {
  const needsRent = { preHandler: requirePermission('rent') };

  app.get('/rent/tracker', async (req) => {
    const q = parseQuery(TrackerQuerySchema, req.query);
    return rentService.getMonthStatus(req.accountId, q.period ?? currentPeriod());
  });

  // Rent-categorized income that could apply to a still-open charge but isn't
  // linked (plan §C5) — read-only; the Rent page renders these as nudges.
  app.get('/rent/unlinked-deposits', async (req) => {
    const q = parseQuery(TrackerQuerySchema, req.query);
    return rentService.findUnlinkedRentDeposits(req.accountId, q.period ?? currentPeriod());
  });

  app.post('/rent/payments', needsRent, async (req, reply) => {
    const input = parseBody(RecordRentPaymentInputSchema, req.body);
    const payment = await rentService.recordPayment(req.accountId, input);
    return reply.code(201).send(payment);
  });

  app.post<{ Params: { id: string } }>(
    '/rent/payments/:id/payment-link',
    needsRent,
    async (req) => rentService.createPaymentLink(req.accountId, req.params.id),
  );

  // Undo one deposit link (plan §B4): recomputes paidCents/status; the ledger
  // transaction survives as an ordinary confirmed row.
  app.delete<{ Params: { id: string; depositId: string } }>(
    '/rent/payments/:id/deposits/:depositId',
    needsRent,
    async (req) => rentService.unlinkDeposit(req.accountId, req.params.id, req.params.depositId),
  );

  app.post('/rent/reminders', needsRent, async (req) => {
    const input = parseBody(SendRemindersInputSchema, req.body);
    return rentService.sendReminders(req.accountId, input, 'user', (data, message) =>
      req.log.info(data, message),
    );
  });
}
