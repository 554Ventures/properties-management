import { RegisterDeviceInputSchema } from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { parseBody } from '../plugins/zod-validation';
import * as pushService from '../services/push.service';

export async function devicesRoutes(app: FastifyInstance): Promise<void> {
  app.post('/devices', async (req, reply) => {
    const input = parseBody(RegisterDeviceInputSchema, req.body);
    // req.userId (null in demo mode) is stamped so per-user notification
    // routing knows whose device this is; re-registration self-heals old rows.
    const device = await pushService.registerDevice(req.accountId, input, req.userId);
    return reply.code(201).send(device);
  });

  app.get('/devices', async (req) => pushService.listDevices(req.accountId));

  app.delete<{ Params: { token: string } }>('/devices/:token', async (req, reply) => {
    await pushService.unregisterDevice(req.accountId, req.params.token);
    return reply.code(204).send();
  });
}
