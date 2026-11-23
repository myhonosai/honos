const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** RFC 4648 §5 base64url without padding (React Native has no Buffer). */
export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    out += ALPHABET[a >> 2]! + ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += ALPHABET[c & 63]!;
  }
  return out;
}

/** S256 challenge for an ASCII verifier, with the platform's SHA-256 injected (expo-crypto on device). */
export async function pkceChallenge(verifier: string, sha256: (data: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>): Promise<string> {
  const ascii = new Uint8Array([...verifier].map(ch => ch.charCodeAt(0)));
  return base64url(new Uint8Array(await sha256(ascii)));
}
