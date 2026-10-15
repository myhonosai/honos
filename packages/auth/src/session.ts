import jwt, { type JwtPayload } from 'jsonwebtoken';
import { AuthValidationError, type ManusConfig, type SessionConfig } from './config.js';

export const HON_SESSION_COOKIE = 'hon_session';
export const MANUS_SESSION_COOKIE = 'webdev_app_session';
export const SESSION_SECONDS = 43_200;
export interface NormalizedIdentity { externalSubject: string; displayName?: string; email?: string; }

export function textClaim(value: unknown, max: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new AuthValidationError();
  return value.trim();
}
export function normalizedIdentity(input: Record<string, unknown>): NormalizedIdentity {
  const externalSubject = textClaim(input.externalSubject, 2048)!;
  // A subject is an opaque identity key, never silently rewrite it.
  if (externalSubject !== input.externalSubject) throw new AuthValidationError();
  const displayName = textClaim(input.displayName, 256, true);
  const email = textClaim(input.email, 254, true);
  return { externalSubject, ...(displayName === undefined ? {} : { displayName }), ...(email === undefined ? {} : { email }) };
}

export function issueSession(identity: NormalizedIdentity, config: SessionConfig, now = Math.floor(Date.now() / 1000)): string {
  return jwt.sign({ ...normalizedIdentity({ ...identity }), iss: config.mode, aud: config.audience, iat: now, exp: now + SESSION_SECONDS }, config.secret, { algorithm: 'HS256' });
}
export function verifySession(token: string, config: SessionConfig, now = Math.floor(Date.now() / 1000)): NormalizedIdentity {
  try {
    if (token.length > 8192) throw new Error();
    const result = jwt.verify(token, config.secret, { algorithms: ['HS256'], issuer: config.mode, audience: config.audience, clockTimestamp: now, complete: true });
    const payload = result.payload;
    if (typeof payload === 'string' || result.header.typ !== 'JWT' || Object.keys(result.header).some((key) => !['alg', 'typ'].includes(key))) throw new Error();
    if (Object.keys(payload).some((key) => !['externalSubject', 'displayName', 'email', 'iss', 'aud', 'iat', 'exp'].includes(key))) throw new Error();
    if (payload.iss !== config.mode || payload.aud !== config.audience || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat! > now || payload.exp! <= now || payload.exp! <= payload.iat! || payload.exp! - payload.iat! > SESSION_SECONDS) throw new Error();
    const identity = normalizedIdentity(payload);
    if (identity.displayName !== payload.displayName || identity.email !== payload.email) throw new Error();
    return identity;
  } catch { throw new AuthValidationError(); }
}

// Never used by the API. Only the explicitly selected web development adapter may convert this cookie.
export function verifyManusSession(token: string, config: ManusConfig): NormalizedIdentity {
  try {
    if (token.length > 8192) throw new Error();
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as JwtPayload;
    if (typeof payload === 'string' || payload.appId !== config.projectId || !Number.isSafeInteger(payload.exp)) throw new Error();
    return normalizedIdentity({ externalSubject: payload.openId ?? payload.sub, displayName: payload.name, email: payload.email });
  } catch { throw new AuthValidationError(); }
}
export function issueManusSession(identity: NormalizedIdentity, config: ManusConfig): string {
  return jwt.sign({ appId: config.projectId, openId: identity.externalSubject, name: identity.displayName, email: identity.email }, config.jwtSecret, { algorithm: 'HS256', expiresIn: SESSION_SECONDS });
}

// Reject duplicate or malformed cookies rather than let proxy/framework parsing pick different identities.
export function cookieValue(header: string | undefined | null, name: string): string | undefined {
  if (!header) return undefined;
  let value: string | undefined;
  for (const entry of header.split(';')) {
    const split = entry.indexOf('=');
    if (split < 0 || entry.slice(0, split).trim() !== name) continue;
    if (value !== undefined) throw new AuthValidationError();
    try { value = decodeURIComponent(entry.slice(split + 1).trim()); } catch { throw new AuthValidationError(); }
  }
  return value;
}
