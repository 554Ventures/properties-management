// The externally reachable origin of this deployment, used to build the OAuth
// resource identifiers Claude discovers (RFC 9728 protected-resource metadata
// and the `resource_metadata` hint on a 401 from /mcp).
//
// PUBLIC_APP_URL (https://app.554properties.com) is authoritative when set.
//
// The fallback must never report http:// for a public host. The container sits
// behind the Cloudflare Worker and is reached over plain HTTP, so req.protocol
// says "http" for a site that is https to the outside world — and a resource
// identifier that disagrees with the URL the client actually called fails OAuth
// discovery outright (RFC 9728 §3: it must match). So only loopback stays http;
// anything else is assumed https unless a forwarded proto says otherwise. That
// keeps `npm run dev` and `app.listen({ port: 0 })` config-free while making a
// missing/unpropagated PUBLIC_APP_URL a non-event in production.
import type { FastifyRequest } from 'fastify';

function isLoopbackHost(host: string): boolean {
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '[::1]';
}

/**
 * The configured origin with no request to fall back on — for code that builds
 * user-facing links outside a request (the scheduler's notification emails).
 * Null when PUBLIC_APP_URL is unset: there is no safe guess without a Host
 * header, so callers must degrade to link-free copy rather than emit a link
 * into localhost.
 */
export function configuredPublicAppUrl(): string | null {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  return configured ? configured.replace(/\/+$/, '') : null;
}

export function publicBaseUrl(req: FastifyRequest): string {
  const configured = configuredPublicAppUrl();
  if (configured) return configured;
  const host = req.headers.host ?? 'localhost';
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    ?.trim();
  const protocol = forwarded || (isLoopbackHost(host) ? req.protocol : 'https');
  return `${protocol}://${host}`;
}

/** RFC 9728 metadata document for the /mcp resource. */
export function mcpResourceMetadataUrl(req: FastifyRequest): string {
  return `${publicBaseUrl(req)}/.well-known/oauth-protected-resource/mcp`;
}
