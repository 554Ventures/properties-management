import { CreatePropertyInputSchema, UpdatePropertyInputSchema } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../lib/authz';
import { currentPeriodInTz, yearRangeInTz } from '../lib/dates';
import { parseBody, parseQuery } from '../plugins/zod-validation';
import { accountTimezone } from '../services/account.service';
import * as propertyService from '../services/property.service';

const PnlQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export async function propertiesRoutes(app: FastifyInstance): Promise<void> {
  const needsProperties = { preHandler: requirePermission('properties') };

  app.get('/properties', async (req) => propertyService.list(req.accountId));

  app.post('/properties', needsProperties, async (req, reply) => {
    const input = parseBody(CreatePropertyInputSchema, req.body);
    const property = await propertyService.create(req.accountId, input);
    return reply.code(201).send(property);
  });

  app.get<{ Params: { id: string } }>('/properties/:id', async (req) =>
    propertyService.getDetail(req.accountId, req.params.id),
  );

  app.patch<{ Params: { id: string } }>('/properties/:id', needsProperties, async (req) => {
    const input = parseBody(UpdatePropertyInputSchema, req.body);
    return propertyService.update(req.accountId, req.params.id, input);
  });

  app.delete<{ Params: { id: string } }>('/properties/:id', needsProperties, async (req, reply) => {
    await propertyService.remove(req.accountId, req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/properties/:id/restore', needsProperties, async (req) =>
    propertyService.restore(req.accountId, req.params.id),
  );

  app.get<{ Params: { id: string } }>('/properties/:id/pnl', async (req) => {
    const q = parseQuery(PnlQuerySchema, req.query);
    // Default calendar-year range on the account's timezone (WS4).
    const tz = await accountTimezone(req.accountId);
    const currentYear = yearRangeInTz(Number(currentPeriodInTz(tz).slice(0, 4)), tz);
    const from = q.from ? new Date(q.from) : currentYear.from;
    const to = q.to ? new Date(q.to) : currentYear.to;
    return propertyService.getPnl(req.accountId, req.params.id, { from, to });
  });
}
