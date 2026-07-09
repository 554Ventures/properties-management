// Security headers (docs/SECURITY_PRIVACY_AUDIT.md §A5): @fastify/helmet adds
// CSP/HSTS/X-Content-Type-Options/X-Frame-Options to every response, and CORP
// is explicitly 'cross-origin' so local dev (web :5173 → api :3001) and CORS
// keep working — CORS_ORIGIN remains the real access-control gate.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

describe('security headers', () => {
  it('sets CSP, HSTS, and other helmet defaults on a JSON response', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['strict-transport-security']).toContain('max-age=15552000');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('keeps Cross-Origin-Resource-Policy permissive for cross-origin dev/API callers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/healthz' });
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('still honors CORS_ORIGIN for an allowed cross-origin caller', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/healthz',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});
