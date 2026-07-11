// APNs adapter unit tests: provider JWT header/claims + caching, request
// shape, and response → PushSendResult mapping — all through the injected
// http2 seam (no network).
import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  createApnsPushProvider,
  type ApnsConfig,
  type ApnsPostFn,
} from '../integrations/real/real-apns';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const config: ApnsConfig = {
  teamId: 'TEAM123456',
  keyId: 'KEY1234567',
  privateKey: pem,
  bundleId: 'com.properties554.hearth',
  env: 'sandbox',
};

interface RecordedCall {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

function recordingPost(
  respond: (call: RecordedCall) => { status: number; body: string },
): { post: ApnsPostFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const post: ApnsPostFn = async (host, path, headers, body) => {
    const call = { host, path, headers, body };
    calls.push(call);
    return respond(call);
  };
  return { post, calls };
}

const ok = () => ({ status: 200, body: '' });

describe('provider JWT', () => {
  it('signs ES256 with kid header and iss/iat claims', async () => {
    const { post, calls } = recordingPost(ok);
    const provider = createApnsPushProvider(config, post);
    await provider.send('tok1', { title: 'T', body: 'B' });

    const auth = calls[0]!.headers.authorization!;
    expect(auth.startsWith('bearer ')).toBe(true);
    const jwt = auth.slice('bearer '.length);
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    const claims = decodeJwt(jwt);
    expect(claims.iss).toBe('TEAM123456');
    expect(typeof claims.iat).toBe('number');
    expect(Math.abs(Date.now() / 1000 - (claims.iat as number))).toBeLessThan(60);
  });

  it('is cached across sends (Apple wants 20–60 min old tokens, not per-request)', async () => {
    const { post, calls } = recordingPost(ok);
    const provider = createApnsPushProvider(config, post);
    await provider.send('tok1', { title: 'T', body: 'B' });
    await provider.send('tok2', { title: 'T', body: 'B' });
    expect(calls[0]!.headers.authorization).toBe(calls[1]!.headers.authorization);
  });

  it('accepts a \\n-escaped PEM (how env vars deliver it)', async () => {
    const { post } = recordingPost(ok);
    const escaped = { ...config, privateKey: pem.replace(/\n/g, '\\n') };
    const provider = createApnsPushProvider(escaped, post);
    await expect(provider.send('tok1', { title: 'T', body: 'B' })).resolves.toEqual({ ok: true });
  });
});

describe('request shape', () => {
  it('POSTs the alert payload to the sandbox host with APNs headers', async () => {
    const { post, calls } = recordingPost(ok);
    const provider = createApnsPushProvider(config, post);
    const result = await provider.send('devicetoken', {
      title: 'Rent received',
      body: 'Amara paid $1,850.00 for 2026-07',
      deepLink: '/rent',
    });

    expect(result).toEqual({ ok: true });
    const call = calls[0]!;
    expect(call.host).toBe('api.sandbox.push.apple.com');
    expect(call.path).toBe('/3/device/devicetoken');
    expect(call.headers['apns-topic']).toBe('com.properties554.hearth');
    expect(call.headers['apns-push-type']).toBe('alert');
    expect(call.headers['apns-priority']).toBe('10');
    expect(JSON.parse(call.body)).toEqual({
      aps: { alert: { title: 'Rent received', body: 'Amara paid $1,850.00 for 2026-07' } },
      deepLink: '/rent',
    });
  });

  it('uses the production host when env=production', async () => {
    const { post, calls } = recordingPost(ok);
    const provider = createApnsPushProvider({ ...config, env: 'production' }, post);
    await provider.send('tok1', { title: 'T', body: 'B' });
    expect(calls[0]!.host).toBe('api.push.apple.com');
  });
});

describe('response mapping', () => {
  it.each([
    [410, '{"reason":"Unregistered"}', { ok: false, unregistered: true, reason: 'Unregistered' }],
    [
      400,
      '{"reason":"BadDeviceToken"}',
      { ok: false, unregistered: true, reason: 'BadDeviceToken' },
    ],
    [
      403,
      '{"reason":"InvalidProviderToken"}',
      { ok: false, unregistered: false, reason: 'InvalidProviderToken' },
    ],
    [500, 'not json', { ok: false, unregistered: false, reason: 'http_500' }],
  ])('maps %i %s', async (status, body, expected) => {
    const { post } = recordingPost(() => ({ status, body }));
    const provider = createApnsPushProvider(config, post);
    await expect(provider.send('tok1', { title: 'T', body: 'B' })).resolves.toEqual(expected);
  });

  it('a thrown transport error resolves { ok: false } instead of rejecting', async () => {
    const post: ApnsPostFn = async () => {
      throw new Error('ECONNRESET');
    };
    const provider = createApnsPushProvider(config, post);
    await expect(provider.send('tok1', { title: 'T', body: 'B' })).resolves.toEqual({
      ok: false,
      reason: 'ECONNRESET',
    });
  });
});
