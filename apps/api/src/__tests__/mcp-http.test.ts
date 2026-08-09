// Remote MCP over Streamable HTTP (routes/mcp.ts) + its OAuth discovery
// document (routes/well-known.ts). Unlike every other API test this one binds
// a real socket: the route hijacks the reply so the MCP SDK can write the
// JSON-RPC response onto the raw Node response, which app.inject() cannot
// observe. Runs in Supabase mode so real accounts, roles and permissions
// exist; provisioned accounts are cleaned up in afterAll.
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { prisma } from '../lib/prisma';
import { resetAuthServiceCache } from '../services/auth.service';

const TEST_SECRET = 'test-jwt-secret-with-at-least-32-characters!';
const SUPABASE_URL = 'https://mcphttptest.supabase.co';

async function signToken(
  sub: string,
  email: string,
  opts: { clientId?: string } = {},
): Promise<string> {
  return new SignJWT({
    email,
    aud: 'authenticated',
    ...(opts.clientId ? { client_id: opts.clientId } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_SECRET));
}

/** Sign in a brand-new identity, forcing first-sight provisioning. */
async function provision(sub: string, email: string): Promise<string> {
  const token = await signToken(sub, email);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/properties',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return token;
}

let app: FastifyInstance;
let baseUrl = '';
let ownerAToken = '';
let ownerBToken = '';
let memberToken = '';
let propertyAAddress = '';

const openClients: Client[] = [];

async function mcpClient(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'mcp-http-test-client', version: '0.0.0' });
  await client.connect(transport);
  openClients.push(client);
  return client;
}

async function toolNames(token: string): Promise<string[]> {
  const client = await mcpClient(token);
  return (await client.listTools()).tools.map((t) => t.name);
}

async function callToolJson(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(result.content[0]!.text) as any;
}

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
  // Drives the `authorization_servers` entry in the discovery document. The
  // HS256 secret above still wins in verifySupabaseToken, so no JWKS fetch.
  process.env.SUPABASE_URL = SUPABASE_URL;
  resetAuthServiceCache();

  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  ownerAToken = await provision('mcp-http-owner-a', 'owner-a@mcphttptest.example');
  ownerBToken = await provision('mcp-http-owner-b', 'owner-b@mcphttptest.example');

  // A member of account A with 'ai' + 'properties' but deliberately no 'money'.
  const invite = await app.inject({
    method: 'POST',
    url: '/api/v1/team/invites',
    headers: { authorization: `Bearer ${ownerAToken}` },
    payload: { email: 'member@mcphttptest.example', permissions: ['ai', 'properties'] },
  });
  expect(invite.statusCode).toBe(201);
  memberToken = await provision('mcp-http-member', 'member@mcphttptest.example');

  // One property under account A only — the cross-account isolation target.
  propertyAAddress = '77 Isolation Ave';
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/properties',
    headers: { authorization: `Bearer ${ownerAToken}` },
    payload: {
      addressLine1: propertyAAddress,
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      units: [{ label: 'A' }],
    },
  });
  expect(created.statusCode).toBe(201);
});

afterAll(async () => {
  while (openClients.length) await openClients.pop()!.close();
  delete process.env.SUPABASE_JWT_SECRET;
  delete process.env.SUPABASE_URL;
  delete process.env.PUBLIC_APP_URL;
  resetAuthServiceCache();
  await prisma.account.deleteMany({ where: { email: { endsWith: '@mcphttptest.example' } } });
  await app.close();
});

describe('POST /mcp: unauthenticated', () => {
  it('401s with the RFC 9728 WWW-Authenticate discovery hint', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect((await res.json()).error.code).toBe('unauthorized');
  });

  it('does not add the hint to ordinary REST 401s', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/properties' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  it('405s GET and DELETE (stateless: no server-initiated streams)', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${baseUrl}/mcp`, {
        method,
        headers: { authorization: `Bearer ${ownerAToken}` },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });
});

describe('protected-resource metadata (RFC 9728)', () => {
  it('serves the /mcp document without a token', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [`${SUPABASE_URL}/auth/v1`],
      bearer_methods_supported: ['header'],
      scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
    });
  });

  it('serves the origin-level document with the origin as its resource', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    expect((await res.json()).resource).toBe(baseUrl);
  });

  it('prefers PUBLIC_APP_URL over the request host', async () => {
    process.env.PUBLIC_APP_URL = 'https://app.554properties.com/';
    try {
      const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
      // Trailing slash normalized away — the resource identifier must match
      // what the connector URL resolves to exactly.
      expect((await res.json()).resource).toBe('https://app.554properties.com/mcp');
    } finally {
      delete process.env.PUBLIC_APP_URL;
    }
  });
});

describe('POST /mcp: authorized', () => {
  it('completes initialize + tools/list over a real Streamable HTTP client', async () => {
    const client = await mcpClient(ownerAToken);
    expect(client.getServerVersion()?.name).toBe('hearth');

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('get_dashboard_kpis');
    expect(names).toContain('list_properties');
    // An owner keeps every write tool, unlike the stdio server's env gate.
    expect(names).toContain('create_transaction');
    expect(names).toContain('create_property');
    // Chat-only render tools never appear on the MCP surface.
    expect(names).not.toContain('render_chart');
    expect(names).not.toContain('ask_user_question');
  });

  it('accepts a token carrying client_id (third-party OAuth client)', async () => {
    const token = await signToken('mcp-http-owner-a', 'owner-a@mcphttptest.example', {
      clientId: 'claude-desktop-test-client',
    });
    const client = await mcpClient(token);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('hides write tools the member lacks permission for', async () => {
    const names = await toolNames(memberToken);
    // 'ai' + 'properties' → property writes stay, money writes disappear.
    expect(names).toContain('create_property');
    expect(names).toContain('update_unit');
    expect(names).not.toContain('create_transaction');
    expect(names).not.toContain('confirm_transaction');
    // Reads are open to any member.
    expect(names).toContain('list_transactions');
    expect(names).toContain('get_dashboard_kpis');
  });

  it('scopes tool results to the caller account', async () => {
    const asA = await callToolJson(await mcpClient(ownerAToken), 'list_properties');
    const asB = await callToolJson(await mcpClient(ownerBToken), 'list_properties');

    expect(asA.map((p: { addressLine1: string }) => p.addressLine1)).toContain(propertyAAddress);
    expect(asB).toEqual([]);
  });
});
