import {
  ApplyLateFeeInputSchema,
  PeriodSchema,
  RecordRentPaymentInputSchema,
  SendRemindersInputSchema,
} from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../lib/authz';
import { parseBody, parseQuery } from '../plugins/zod-validation';
import * as rentService from '../services/rent.service';

const TrackerQuerySchema = z.object({ period: PeriodSchema.optional() });

export async function rentRoutes(app: FastifyInstance): Promise<void> {
  const needsRent = { preHandler: requirePermission('rent') };

  // Period defaults resolve inside the service on the account's timezone (WS4).
  app.get('/rent/tracker', async (req) => {
    const q = parseQuery(TrackerQuerySchema, req.query);
    return rentService.getMonthStatus(req.accountId, q.period);
  });

  // Rent-categorized income that could apply to a still-open charge but isn't
  // linked (plan §C5) — read-only; the Rent page renders these as nudges.
  app.get('/rent/unlinked-deposits', async (req) => {
    const q = parseQuery(TrackerQuerySchema, req.query);
    return rentService.findUnlinkedRentDeposits(req.accountId, q.period);
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

  // Apply a late fee to a late charge (WS7). Explicit human action — the fee is
  // stamped on the charge; no ledger row until it's collected. Body may specify
  // feeCents, otherwise the effective policy (lease override or account default)
  // is used; a charge that's not past grace, already has a fee, or has no policy
  // configured is rejected 400.
  app.post<{ Params: { id: string } }>(
    '/rent/payments/:id/late-fee',
    needsRent,
    async (req, reply) => {
      const input = parseBody(ApplyLateFeeInputSchema, req.body);
      const payment = await rentService.applyLateFee(req.accountId, req.params.id, input);
      return reply.code(200).send(payment);
    },
  );

  // Waive an applied late fee (WS7): resets it to 0. Blocked once the charge is
  // fully collected against its total (would strand an overpayment).
  app.delete<{ Params: { id: string } }>(
    '/rent/payments/:id/late-fee',
    needsRent,
    async (req) => rentService.waiveLateFee(req.accountId, req.params.id),
  );

  app.post('/rent/reminders', needsRent, async (req) => {
    const input = parseBody(SendRemindersInputSchema, req.body);
    return rentService.sendReminders(req.accountId, input, 'user', (data, message) =>
      req.log.info(data, message),
    );
  });
}
