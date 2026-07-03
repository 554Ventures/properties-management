import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './plugins/auth';
import { registerErrorHandler } from './plugins/error-handler';
import { categoriesRoutes } from './routes/categories';
import { chatRoutes } from './routes/chat';
import { dashboardRoutes } from './routes/dashboard';
import { insightsRoutes } from './routes/insights';
import { leasesRoutes } from './routes/leases';
import { propertiesRoutes } from './routes/properties';
import { rentRoutes } from './routes/rent';
import { reportsRoutes } from './routes/reports';
import { settingsRoutes } from './routes/settings';
import { tenantsRoutes } from './routes/tenants';
import { transactionsRoutes } from './routes/transactions';
import { unitsRoutes } from './routes/units';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  await app.register(cors, {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  registerErrorHandler(app);
  registerAuth(app);

  app.get('/api/v1/healthz', async () => ({ status: 'ok' }));

  await app.register(
    async (api) => {
      await api.register(propertiesRoutes);
      await api.register(unitsRoutes);
      await api.register(tenantsRoutes);
      await api.register(leasesRoutes);
      await api.register(transactionsRoutes);
      await api.register(categoriesRoutes);
      await api.register(rentRoutes);
      await api.register(reportsRoutes);
      await api.register(insightsRoutes);
      await api.register(dashboardRoutes);
      await api.register(settingsRoutes);
      await api.register(chatRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
