// Request auth, two modes (deployment plan §4.1):
//   • Supabase mode — enabled when SUPABASE_JWT_SECRET or SUPABASE_URL is set.
//     Every request must carry a Supabase Auth JWT (HS256 via the project JWT
//     secret, or asymmetric keys via the project JWKS endpoint); the verified
//     identity maps to an Account through services/auth.service.ts.
//   • Demo mode (default) — the seeded demo account attached to every request,
//     optionally gated by a static DEV_BEARER_TOKEN. Keeps the offline demo
//     and the test suite working with no Supabase project.
// Env is read per request so tests can flip modes without rebuilding the app.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { prisma } from '../lib/prisma';
import { resolveAccountForIdentity } from '../services/auth.service';
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

function supabaseModeEnabled(): boolean {
  return Boolean(process.env.SUPABASE_JWT_SECRET || process.env.SUPABASE_URL);
}

// JWKS is cached per URL; jose re-fetches on unknown-kid misses, which covers
// Supabase's (rare) signing-key rotations.
let jwksCache: { url: string; keySet: ReturnType<typeof createRemoteJWKSet> } | null = null;

async function verifySupabaseToken(token: string): Promise<JWTPayload> {
  const audience = 'authenticated';
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (secret) {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { audience });
    return payload;
  }
  const url = new URL('/auth/v1/.well-known/jwks.json', process.env.SUPABASE_URL).toString();
  if (jwksCache?.url !== url) {
    jwksCache = { url, keySet: createRemoteJWKSet(new URL(url)) };
  }
  const { payload } = await jwtVerify(token, jwksCache.keySet, { audience });
  return payload;
}

function unauthorized(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(401).send({ error: { code: 'unauthorized', message } });
}

export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('accountId', '');
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/v1/healthz')) return;
    // Internal automation endpoints authenticate with their own shared secret
    // (routes/internal.ts) — cron callers have no user JWT.
    if (req.url.startsWith('/api/v1/internal/')) return;

    if (supabaseModeEnabled()) {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) {
        return unauthorized(reply, 'Missing bearer token');
      }
      let payload: JWTPayload;
      try {
        payload = await verifySupabaseToken(header.slice('Bearer '.length));
      } catch {
        return unauthorized(reply, 'Invalid or expired token');
      }
      if (!payload.sub) return unauthorized(reply, 'Token has no subject');
      const email = typeof payload.email === 'string' ? payload.email : undefined;
      req.accountId = await resolveAccountForIdentity(payload.sub, email);
      return;
    }

    const token = process.env.DEV_BEARER_TOKEN;
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      return unauthorized(reply, 'Missing or invalid bearer token');
    }
    req.accountId = await getDemoAccountId();
  });
}
