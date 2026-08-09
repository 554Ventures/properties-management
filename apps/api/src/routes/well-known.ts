// OAuth 2.1 protected-resource metadata (RFC 9728) for the remote MCP
// connector. Claude Desktop reads this to learn which authorization server
// issues tokens for /mcp, then runs dynamic client registration against
// Supabase Auth. Registered at the ROOT (not under /api/v1) because the
// well-known path is fixed by the RFC, and exempt from the auth hook in
// plugins/auth.ts — discovery necessarily happens before a token exists.
//
// Supabase's OAuth server publishes a fixed scope list (openid profile email
// phone offline_access) and supports no custom scopes, so these grant no write
// authority on their own: what an AI client may change is decided by the
// acting user's role/permissions (ai/tools.ts `deniedWriteTools`).
import type { FastifyInstance } from 'fastify';
import { publicBaseUrl } from '../lib/public-url';

const SCOPES_SUPPORTED = ['openid', 'profile', 'email', 'offline_access'];

/** Supabase Auth is the issuer; derived from SUPABASE_URL so staging/prod
 *  projects need no extra config. Empty in demo mode (no Supabase project). */
function authorizationServers(): string[] {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  if (!supabaseUrl) return [];
  return [new URL('/auth/v1', supabaseUrl).toString()];
}

function metadata(resource: string) {
  return {
    resource,
    authorization_servers: authorizationServers(),
    bearer_methods_supported: ['header'],
    scopes_supported: SCOPES_SUPPORTED,
  };
}

export async function wellKnownRoutes(app: FastifyInstance): Promise<void> {
  // Origin-level document (the fallback location clients probe).
  app.get('/.well-known/oauth-protected-resource', async (req) => metadata(publicBaseUrl(req)));

  // Path-scoped document for the MCP endpoint itself — what the 401's
  // `resource_metadata` hint points at.
  app.get('/.well-known/oauth-protected-resource/mcp', async (req) =>
    metadata(`${publicBaseUrl(req)}/mcp`),
  );
}
