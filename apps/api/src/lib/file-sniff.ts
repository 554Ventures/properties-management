// Content-based (magic-byte) MIME verification (security remediation,
// docs/SECURITY_PRIVACY_AUDIT.md §A11). Multipart's declared Content-Type is
// attacker-controlled and was previously trusted as-is; every upload route
// must now confirm the bytes actually are what's claimed before accepting or
// storing a file, and the *sniffed* type — never the client-declared one —
// is what gets persisted/served back.
import { fileTypeFromBuffer } from 'file-type';

export class UnverifiableFileTypeError extends Error {
  constructor() {
    super('Could not verify the file contents match a supported type.');
    this.name = 'UnverifiableFileTypeError';
  }
}

/**
 * Sniffs the real MIME type from file content and requires it to be in
 * `allowed`. Throws `UnverifiableFileTypeError` if the content's actual type
 * can't be determined or doesn't match — refuse-by-default rather than
 * trusting the client-declared Content-Type, since every type in this app's
 * upload allowlists (PDF, JPEG/PNG/WebP/GIF, DOCX) has a detectable
 * signature.
 *
 * Returns the verified, content-derived MIME type — callers should persist
 * and serve *this* value, not the client's declared one.
 */
export async function verifyFileContentType(
  buffer: Buffer,
  allowed: ReadonlySet<string> | readonly string[],
): Promise<string> {
  const detected = await fileTypeFromBuffer(buffer);
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  if (!detected || !allowedSet.has(detected.mime)) {
    throw new UnverifiableFileTypeError();
  }
  return detected.mime;
}
