// Request auth, two modes (deployment plan §4.1):
//   • Supabase mode — enabled when SUPABASE_JWT_SECRET or SUPABASE_URL is set.
//     Every request must carry a Supabase Auth JWT (HS256 via the project JWT
//     secret, or asymmetric keys via the project JWKS endpoint); the verified
//     identity maps to an Account through services/auth.service.ts.
//   • Demo mode (default) — the seeded demo account attached to every request,
//     optionally gated by a static DEV_BEARER_TOKEN. Keeps the offline demo
//     and the test suite working with no Supabase project.
// Env is read per request so tests can flip modes without rebuilding the app.
import { ALL_MEMBER_PERMISSIONS, type MemberPermission, type UserRole } from '@hearth/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { prisma } from '../lib/prisma';
import { mcpResourceMetadataUrl } from '../lib/public-url';
import { resolveAccountForIdentity } from '../services/auth.service';
import { DEMO_EMAIL } from '../../prisma/seed-constants';

declare module 'fastify' {
  interface FastifyRequest {
    accountId: string;
    // Set only in Supabase mode (the User row this identity resolved to) —
    // used for per-identity records like policy-consent acceptance. Absent
    // in demo mode, where there is no User row at all.
    userId: string | null;
    // Authorization context (docs/WHATS_NEXT.md §4). In demo mode there is no
    // User row, so the single operator is treated as an owner with every
    // permission and all guards no-op.
    userRole: UserRole;
    userPermissions: MemberPermission[];
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

/** The remote MCP endpoint, ignoring any query string. */
function isMcpRequest(url: string): boolean {
  const path = url.split('?')[0];
  return path === '/mcp' || path === '/mcp/';
}

function unauthorized(req: FastifyRequest, reply: FastifyReply, message: string): FastifyReply {
  // RFC 9728 §5.1: an MCP client's whole OAuth discovery starts from this
  // header, so a bare 401 leaves Claude with no way in.
  if (isMcpRequest(req.url)) {
    reply.header('WWW-Authenticate', `Bearer resource_metadata="${mcpResourceMetadataUrl(req)}"`);
  }
  return reply.code(401).send({ error: { code: 'unauthorized', message } });
}

export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('accountId', '');
  app.decorateRequest('userId', null);
  app.decorateRequest('userRole', 'owner');
  // Fastify forbids reference-type decorator defaults (shared-state hazard), so
  // seed with null and let the onRequest hook assign the real array per request
  // before any handler runs.
  app.decorateRequest('userPermissions', null as unknown as MemberPermission[]);
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/v1/healthz')) return;
    // Internal automation endpoints authenticate with their own shared secret
    // (routes/internal.ts) — cron callers have no user JWT.
    if (req.url.startsWith('/api/v1/internal/')) return;
    // OAuth discovery (routes/well-known.ts) necessarily precedes any token.
    if (req.url.startsWith('/.well-known/oauth-protected-resource')) return;

    if (supabaseModeEnabled()) {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) {
        return unauthorized(req, reply, 'Missing bearer token');
      }
      let payload: JWTPayload;
      try {
        payload = await verifySupabaseToken(header.slice('Bearer '.length));
      } catch {
        return unauthorized(req, reply, 'Invalid or expired token');
      }
      if (!payload.sub) return unauthorized(req, reply, 'Token has no subject');
      // Supabase's OAuth 2.1 server stamps `client_id` on the tokens it issues
      // to third-party clients, and only those: gotrue's AccessTokenClaims
      // declares it `omitempty` and populates it solely from the session's
      // OAuth client id (supabase/auth internal/tokens/service.go), so
      // first-party web/iOS sessions never carry the claim. Dynamic client
      // registration is open, so a token obtained that way must stay confined
      // to the MCP surface the user consented to — it is not a general REST
      // credential.
      if (typeof payload.client_id === 'string' && payload.client_id && !isMcpRequest(req.url)) {
        return unauthorized(req, reply, 'OAuth client tokens are only accepted on /mcp');
      }
      const email = typeof payload.email === 'string' ? payload.email : undefined;
      const identity = await resolveAccountForIdentity(payload.sub, email);
      req.accountId = identity.accountId;
      req.userId = identity.userId;
      req.userRole = identity.role;
      req.userPermissions = identity.permissions;
      return;
    }

    const token = process.env.DEV_BEARER_TOKEN;
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      return unauthorized(req, reply, 'Missing or invalid bearer token');
    }
    req.accountId = await getDemoAccountId();
    req.userId = null;
    // Demo mode: no User row → the single operator is an owner with everything.
    req.userRole = 'owner';
    req.userPermissions = [...ALL_MEMBER_PERMISSIONS];
  });
}
