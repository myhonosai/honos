// Node's crypto is the reference implementation here; the app itself uses expo-crypto.
const { createHash, randomBytes } = jest.requireActual('crypto') as {
  createHash: (a: string) => { update(d: Uint8Array | string): { digest(): Uint8Array } };
  randomBytes: (n: number) => Uint8Array & { toString(enc: string): string };
};
import { base64url, pkceChallenge } from '../src/session/pkce';

describe('PKCE helpers', () => {
  it('base64url-encodes bytes exactly like Node', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = randomBytes(n);
      expect(base64url(new Uint8Array(bytes))).toBe(bytes.toString('base64url'));
    }
  });
  it('matches the RFC 7636 appendix B example', async () => {
    const sha256 = async (data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest()).buffer;
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', sha256)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});
