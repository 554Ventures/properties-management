// Real storage adapter against Supabase Storage's REST API (plain fetch — no
// SDK dependency). Selected by integrations/factory.ts only when SUPABASE_URL
// and SUPABASE_SERVICE_ROLE_KEY are both set. The bucket must exist (created
// once, private, in the Supabase dashboard); SUPABASE_STORAGE_BUCKET overrides
// the default 'documents'.
import type { StorageAdapter } from '../types';

export function createRealStorageAdapter(): StorageAdapter {
  const baseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'documents';

  // Percent-encode each key segment so filename characters (%, #, ?, unicode)
  // can't be re-interpreted by the URL parser — the stored key must map to the
  // exact object path.
  const objectUrl = (key: string) =>
    `${baseUrl}/storage/v1/object/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const authHeader = { Authorization: `Bearer ${serviceRoleKey}` };

  return {
    async put(key, data, contentType) {
      const res = await fetch(objectUrl(key), {
        method: 'POST',
        headers: {
          ...authHeader,
          'content-type': contentType,
          // Upsert: re-running the seed (or replacing a file) must not fail.
          'x-upsert': 'true',
        },
        body: new Uint8Array(data),
      });
      if (!res.ok) {
        throw new Error(`[storage] upload failed for ${key}: ${res.status} ${await res.text()}`);
      }
    },

    async get(key) {
      const res = await fetch(objectUrl(key), { headers: authHeader });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`[storage] download failed for ${key}: ${res.status} ${await res.text()}`);
      }
      return Buffer.from(await res.arrayBuffer());
    },

    async delete(key) {
      const res = await fetch(objectUrl(key), { method: 'DELETE', headers: authHeader });
      // Best-effort idempotent delete — a missing object is not an error.
      if (!res.ok && res.status !== 404) {
        throw new Error(`[storage] delete failed for ${key}: ${res.status} ${await res.text()}`);
      }
    },
  };
}
