// Single-account dev auth (ARCHITECTURE resolved decision): if
// DEV_BEARER_TOKEN is set, require it as a Bearer token; otherwise open.
// Every request gets the seeded demo account's id attached.
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma';
import { DEMO_EMAIL } from '../../prisma/seed-constants';

declare module 'fastify' {
  interface FastifyRequest {
    accountId: string;
  }
}

let cachedAccountId: string | null = null;

export async function getDemoAccountId(): Promise<string> {
  if (cachedAccountId) return cachedAccountId;
  const account = await prisma.account.findUnique({ where: { email: DEMO_EMAIL } });
  if (!account) {
    throw new Error(`Demo account ${DEMO_EMAIL} not found — run \`npm run db:setup -w apps/api\``);
  }
  cachedAccountId = account.id;
  return account.id;
}

/** Test helper: forget the cached account id (seed re-runs create a new one). */
export function resetAuthCache(): void {
  cachedAccountId = null;
}

export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('accountId', '');
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/v1/healthz')) return;
    const token = process.env.DEV_BEARER_TOKEN;
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      return reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'Missing or invalid bearer token' } });
    }
    req.accountId = await getDemoAccountId();
  });
}
