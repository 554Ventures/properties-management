// Real APNs push adapter: ES256 provider JWT (jose) + raw node:http2 POSTs to
// Apple. Hand-rolled instead of pulling in `apns2` — it's ~100 lines of stable
// protocol and `jose` is already a dependency.
import { connect } from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';
import type { PushMessage, PushProvider, PushSendResult } from '../types';

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  /** PKCS8 PEM. Env delivery is \n-escaped; normalized here. */
  privateKey: string;
  bundleId: string;
  env: 'sandbox' | 'production';
}

/** Seam for tests: POST `body` to https://{host}{path}, resolve status + response body. */
export type ApnsPostFn = (
  host: string,
  path: string,
  headers: Record<string, string>,
  body: string,
) => Promise<{ status: number; body: string }>;

const defaultPost: ApnsPostFn = (host, path, headers, body) =>
  new Promise((resolve, reject) => {
    const client = connect(`https://${host}`);
    client.on('error', reject);
    const req = client.request({ ':method': 'POST', ':path': path, ...headers });
    let status = 0;
    let data = '';
    req.setEncoding('utf8');
    req.on('response', (resHeaders) => {
      status = Number(resHeaders[':status'] ?? 0);
    });
    req.on('data', (chunk: string) => {
      data += chunk;
    });
    req.on('end', () => {
      client.close();
      resolve({ status, body: data });
    });
    req.on('error', (err) => {
      client.close();
      reject(err);
    });
    req.end(body);
  });

// Apple requires provider tokens between 20 and 60 minutes old; refresh at 50.
const JWT_TTL_MS = 50 * 60 * 1000;

export function createApnsPushProvider(config: ApnsConfig, post: ApnsPostFn = defaultPost): PushProvider {
  const host = config.env === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
  const pem = config.privateKey.replace(/\\n/g, '\n');

  let cachedJwt: { token: string; issuedAt: number } | undefined;
  async function providerJwt(): Promise<string> {
    if (cachedJwt && Date.now() - cachedJwt.issuedAt < JWT_TTL_MS) return cachedJwt.token;
    const key = await importPKCS8(pem, 'ES256');
    const token = await new SignJWT({ iss: config.teamId })
      .setProtectedHeader({ alg: 'ES256', kid: config.keyId })
      .setIssuedAt()
      .sign(key);
    cachedJwt = { token, issuedAt: Date.now() };
    return token;
  }

  return {
    async send(deviceToken: string, message: PushMessage): Promise<PushSendResult> {
      try {
        const jwt = await providerJwt();
        const payload = JSON.stringify({
          aps: { alert: { title: message.title, body: message.body } },
          ...(message.deepLink ? { deepLink: message.deepLink } : {}),
        });
        const { status, body } = await post(
          host,
          `/3/device/${deviceToken}`,
          {
            authorization: `bearer ${jwt}`,
            'apns-topic': config.bundleId,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'content-type': 'application/json',
          },
          payload,
        );
        if (status === 200) return { ok: true };
        let reason = `http_${status}`;
        try {
          const parsed = JSON.parse(body) as { reason?: string };
          if (parsed.reason) reason = parsed.reason;
        } catch {
          // non-JSON error body — keep the status-derived reason
        }
        const unregistered =
          status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered';
        return { ok: false, unregistered, reason };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
