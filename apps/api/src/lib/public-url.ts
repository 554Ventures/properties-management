// The externally reachable origin of this deployment, used to build the OAuth
// resource identifiers Claude discovers (RFC 9728 protected-resource metadata
// and the `resource_metadata` hint on a 401 from /mcp).
//
// In production the container sits behind the Cloudflare Worker, so the
// inbound Host/proto are not the public ones — PUBLIC_APP_URL
// (https://app.554properties.com) is authoritative there. Dev and the test
// suite leave it unset and fall back to the request's own host, so
// `npm run dev` and `app.listen({ port: 0 })` need no configuration.
import type { FastifyRequest } from 'fastify';

export function publicBaseUrl(req: FastifyRequest): string {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.headers.host ?? 'localhost'}`;
}

/** RFC 9728 metadata document for the /mcp resource. */
export function mcpResourceMetadataUrl(req: FastifyRequest): string {
  return `${publicBaseUrl(req)}/.well-known/oauth-protected-resource/mcp`;
}
