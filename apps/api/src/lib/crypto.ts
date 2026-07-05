// At-rest encryption for third-party secrets (e.g. a Plaid access token)
// stored in Integration.configJson. AES-256-GCM, random IV per call.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;

function loadKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new Error('encryption key must decode to 32 bytes (openssl rand -base64 32)');
  }
  return key;
}

export function encrypt(plaintext: string, keyB64: string): string {
  const key = loadKey(keyB64);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((buf) => buf.toString('base64')).join('.');
}

export function decrypt(encoded: string, keyB64: string): string {
  const key = loadKey(keyB64);
  const [ivB64, authTagB64, ciphertextB64] = encoded.split('.');
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error('malformed ciphertext: expected iv.authTag.ciphertext');
  }
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
