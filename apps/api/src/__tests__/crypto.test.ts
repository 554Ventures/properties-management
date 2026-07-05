import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../lib/crypto';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

describe('lib/crypto', () => {
  it('round-trips a plaintext through encrypt/decrypt', () => {
    const ciphertext = encrypt('access-sandbox-abc123', KEY);
    expect(ciphertext).not.toContain('access-sandbox-abc123');
    expect(decrypt(ciphertext, KEY)).toBe('access-sandbox-abc123');
  });

  it('produces a different ciphertext each call (random IV)', () => {
    const a = encrypt('same-plaintext', KEY);
    const b = encrypt('same-plaintext', KEY);
    expect(a).not.toBe(b);
  });

  it('fails to decrypt with the wrong key', () => {
    const ciphertext = encrypt('access-sandbox-abc123', KEY);
    expect(() => decrypt(ciphertext, OTHER_KEY)).toThrow();
  });
});
