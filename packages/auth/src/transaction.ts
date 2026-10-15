import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AuthValidationError, configuredPublicOrigin, type Environment, type SessionConfig } from './config.js';

export const AUTH_TRANSACTION_COOKIE = 'hon_auth_transaction';
export const TRANSACTION_SECONDS = 600;
export interface AuthTransaction {
  state: string; nonce: string; verifier: string; challenge: string; redirectUri: string;
}
export function constantEqual(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false;
  const left = Buffer.from(expected); const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}
export function createTransaction(redirectUri: string): AuthTransaction {
  const verifier = randomBytes(32).toString('base64url');
  return { state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), verifier, challenge: pkceChallenge(verifier), redirectUri };
}
export function issueTransaction(transaction: AuthTransaction, config: SessionConfig, now = Math.floor(Date.now() / 1000)): string {
  return jwt.sign({ ...transaction, iss: config.mode, aud: `${config.audience}:auth-transaction`, iat: now, exp: now + TRANSACTION_SECONDS }, config.secret, { algorithm: 'HS256', header: { alg: 'HS256', typ: 'hon-auth-transaction+jwt' } });
}
export function verifyTransaction(token: string | undefined, state: unknown, redirectUri: string, config: SessionConfig, now = Math.floor(Date.now() / 1000)): AuthTransaction {
  try {
    if (!token || token.length > 8192) throw new Error();
    const result = jwt.verify(token, config.secret, { algorithms: ['HS256'], issuer: config.mode, audience: `${config.audience}:auth-transaction`, clockTimestamp: now, complete: true });
    const p = result.payload;
    if (typeof p === 'string' || result.header.typ !== 'hon-auth-transaction+jwt' || Object.keys(result.header).some((key) => !['alg', 'typ'].includes(key))) throw new Error();
    if (Object.keys(p).some((key) => !['state', 'nonce', 'verifier', 'challenge', 'redirectUri', 'iss', 'aud', 'iat', 'exp'].includes(key))) throw new Error();
    if (p.iss !== config.mode || p.aud !== `${config.audience}:auth-transaction` || !Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp) || p.iat! > now || p.exp! <= now || p.exp! <= p.iat! || p.exp! - p.iat! > TRANSACTION_SECONDS) throw new Error();
    for (const field of ['state', 'nonce', 'verifier', 'challenge']) if (typeof p[field] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(p[field] as string)) throw new Error();
    if (!constantEqual(p.state as string, state) || p.redirectUri !== redirectUri || !constantEqual(p.challenge as string, pkceChallenge(p.verifier as string))) throw new Error();
    return { state: p.state as string, nonce: p.nonce as string, verifier: p.verifier as string, challenge: p.challenge as string, redirectUri };
  } catch { throw new AuthValidationError(); }
}

export function publicOrigin(headers: Pick<Headers, 'get'>, env: Environment = process.env): string {
  const configured = configuredPublicOrigin(env);
  if (configured) return configured;
  // Compatibility for trusted preview reverse proxies in MANUS_DEVELOPMENT only.
  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  const protocol = headers.get('x-forwarded-proto') ?? 'https';
  if (!host || !/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host) || !['http', 'https'].includes(protocol)) throw new AuthValidationError();
  const origin = new URL(`${protocol}://${host}`);
  if (protocol === 'http' && !['localhost', '127.0.0.1'].includes(origin.hostname)) throw new AuthValidationError();
  return origin.origin;
}
export function callbackParameters(url: URL): { code: string; state: string } {
  const code = url.searchParams.get('code'); const state = url.searchParams.get('state');
  if (url.searchParams.has('error') || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('state').length !== 1 || !code || code.length > 4096 || /[\x00-\x1f\x7f]/.test(code) || !state || state.length > 4096) throw new AuthValidationError();
  return { code, state };
}
