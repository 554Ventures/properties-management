import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './plugins/auth';
import { registerErrorHandler } from './plugins/error-handler';
import { categoriesRoutes } from './routes/categories';
import { chatRoutes } from './routes/chat';
import { contractorsRoutes } from './routes/contractors';
import { dashboardRoutes } from './routes/dashboard';
import { devicesRoutes } from './routes/devices';
import { documentsRoutes } from './routes/documents';
import { insightsRoutes } from './routes/insights';
import { internalRoutes } from './routes/internal';
import { leasesRoutes } from './routes/leases';
import { onboardingRoutes } from './routes/onboarding';
import { propertiesRoutes } from './routes/properties';
import { rentRoutes } from './routes/rent';
import { reportsRoutes } from './routes/reports';
import { settingsRoutes } from './routes/settings';
import { teamRoutes } from './routes/team';
import { tenantsRoutes } from './routes/tenants';
import { transactionsRoutes } from './routes/transactions';
import { unitsRoutes } from './routes/units';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  // CORS_ORIGIN: comma-separated allowed origins (deployment plan §4.6);
  // defaults cover local dev. Same-origin production traffic never needs it.
  const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  await app.register(cors, { origin: corsOrigins });

  // Security headers (docs/SECURITY_PRIVACY_AUDIT.md §A5). This process only
  // ever returns JSON or document downloads (PDF/CSV/image/receipt) — never
  // HTML — so a maximally strict CSP costs nothing and closes the
  // stored-content-spoofing risk on the document-download route. CORP is
  // explicitly 'cross-origin' (not helmet's 'same-origin' default) because
  // CORS_ORIGIN above is the real access-control gate here — local dev calls
  // this API cross-origin (web on :5173, API on :3001) and must keep working.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], objectSrc: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: { maxAge: 15552000, includeSubDomains: true },
  });

  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  registerErrorHandler(app);
  registerAuth(app);

  // Per-route opt-in rate limiting (deployment plan §4.5) — only the chat
  // routes set `config.rateLimit` today. Keyed per account (the auth hook is
  // registered first, so accountId is resolved before counting); IP fallback
  // covers unauthenticated 401 traffic. Cloudflare adds an edge layer on top.
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => req.accountId || req.ip,
    // The 429 is shaped into the ApiError envelope by error-handler.ts.
  });

  app.get('/api/v1/healthz', async () => ({ status: 'ok' }));

  await app.register(
    async (api) => {
      await api.register(propertiesRoutes);
      await api.register(unitsRoutes);
      await api.register(tenantsRoutes);
      await api.register(leasesRoutes);
      await api.register(transactionsRoutes);
      await api.register(categoriesRoutes);
      await api.register(contractorsRoutes);
      await api.register(rentRoutes);
      await api.register(documentsRoutes);
      await api.register(reportsRoutes);
      await api.register(insightsRoutes);
      await api.register(dashboardRoutes);
      await api.register(settingsRoutes);
      await api.register(teamRoutes);
      await api.register(devicesRoutes);
      await api.register(onboardingRoutes);
      await api.register(chatRoutes);
      await api.register(internalRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
