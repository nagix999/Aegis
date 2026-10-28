/** Preserve the server's SHA-256 evidence format on HTTP origins without SubtleCrypto. */
export async function sha256Hex(value: string): Promise<string> {
  const input = new TextEncoder().encode(value);
  const subtle = globalThis.crypto?.subtle;
  const bytes = typeof subtle?.digest === 'function'
    ? new Uint8Array(await subtle.digest('SHA-256', input))
    : (await import('@noble/hashes/sha2.js')).sha256(input);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
