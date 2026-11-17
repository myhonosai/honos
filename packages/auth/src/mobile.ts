import jwt from 'jsonwebtoken';
import { AuthValidationError, type SessionConfig } from './config.js';
import { normalizedIdentity, SESSION_SECONDS, verifySession, type NormalizedIdentity } from './session.js';
import { constantEqual, pkceChallenge } from './transaction.js';

/**
 * Native parent app sign-in (M2). The app never talks to the identity provider directly: it reuses the web OIDC
 * sign-in in the system browser, which hands back a one-minute code bound to the app's PKCE challenge. Only the app
 * holds the verifier, so an intercepted code is useless (RFC 7636 / RFC 8252). Each token kind has its own JWT type
 * and audience, so none can be replayed as another (web session, start cookie, hand-off code, mobile session).
 */
export const MOBILE_START_COOKIE = 'hon_mobile_start';
export const MOBILE_START_SECONDS = 600;
export const MOBILE_HANDOFF_SECONDS = 60;
const PKCE = /^[A-Za-z0-9_-]{43}$/;
const IDENTITY_CLAIMS = ['externalSubject', 'displayName', 'email'] as const;

type Kind = { typ: string; aud: (c: SessionConfig) => string; seconds: number; extra: readonly string[] };
const SESSION: Kind = { typ: 'hon-mobile-session+jwt', aud: c => `${c.audience}:mobile`, seconds: SESSION_SECONDS, extra: IDENTITY_CLAIMS };
const START: Kind = { typ: 'hon-mobile-start+jwt', aud: c => `${c.audience}:mobile-start`, seconds: MOBILE_START_SECONDS, extra: ['challenge'] };
const HANDOFF: Kind = { typ: 'hon-mobile-handoff+jwt', aud: c => `${c.audience}:mobile-handoff`, seconds: MOBILE_HANDOFF_SECONDS, extra: [...IDENTITY_CLAIMS, 'challenge'] };

function sign(kind: Kind, claims: Record<string, unknown>, config: SessionConfig, now: number): string {
  return jwt.sign({ ...claims, iss: config.mode, aud: kind.aud(config), iat: now, exp: now + kind.seconds }, config.secret, { algorithm: 'HS256', header: { alg: 'HS256', typ: kind.typ } });
}
function verify(kind: Kind, token: unknown, config: SessionConfig, now: number): Record<string, unknown> {
  if (typeof token !== 'string' || !token || token.length > 8192) throw new Error();
  const result = jwt.verify(token, config.secret, { algorithms: ['HS256'], issuer: config.mode, audience: kind.aud(config), clockTimestamp: now, complete: true });
  const p = result.payload;
  if (typeof p === 'string' || result.header.typ !== kind.typ || Object.keys(result.header).some(k => !['alg', 'typ'].includes(k))) throw new Error();
  if (Object.keys(p).some(k => ![...kind.extra, 'iss', 'aud', 'iat', 'exp'].includes(k))) throw new Error();
  if (p.aud !== kind.aud(config) || !Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp) || p.iat! > now || p.exp! <= now || p.exp! - p.iat! > kind.seconds) throw new Error();
  return p as Record<string, unknown>;
}
function profile(identity: NormalizedIdentity): Record<string, unknown> {
  const { emailVerified: _drop, ...rest } = normalizedIdentity({ ...identity });
  return rest;
}
function identityFrom(p: Record<string, unknown>): NormalizedIdentity {
  const identity = normalizedIdentity({ externalSubject: p.externalSubject, displayName: p.displayName, email: p.email });
  if (identity.displayName !== p.displayName || identity.email !== p.email) throw new Error();
  return identity;
}

export function issueMobileSession(identity: NormalizedIdentity, config: SessionConfig, now = Math.floor(Date.now() / 1000)): string {
  return sign(SESSION, profile(identity), config, now);
}
export function verifyMobileSession(token: string, config: SessionConfig, now = Math.floor(Date.now() / 1000)): NormalizedIdentity {
  try { return identityFrom(verify(SESSION, token, config, now)); } catch { throw new AuthValidationError(); }
}

export function issueMobileStart(challenge: string, config: SessionConfig, now = Math.floor(Date.now() / 1000)): string {
  if (!PKCE.test(challenge)) throw new AuthValidationError();
  return sign(START, { challenge }, config, now);
}
export function verifyMobileStart(token: string | undefined, config: SessionConfig, now = Math.floor(Date.now() / 1000)): string {
  try {
    const p = verify(START, token, config, now);
    if (typeof p.challenge !== 'string' || !PKCE.test(p.challenge)) throw new Error();
    return p.challenge;
  } catch { throw new AuthValidationError(); }
}

export function issueMobileHandoff(identity: NormalizedIdentity, challenge: string, config: SessionConfig, now = Math.floor(Date.now() / 1000)): string {
  if (!PKCE.test(challenge)) throw new AuthValidationError();
  return sign(HANDOFF, { ...profile(identity), challenge }, config, now);
}
/**
 * The browser side of the hand-off: the web session and the app's start cookie must both be valid, and the web
 * session must have been issued at or after the start cookie. The app opens an ephemeral browser session, so a real
 * app sign-in always produces a fresh web session; an older session already sitting in the parent's everyday browser
 * (someone else's link to /auth/mobile/start) is refused and they must sign in again.
 */
export function mobileHandoffForBrowser(sessionToken: string | undefined, startToken: string | undefined, config: SessionConfig, now = Math.floor(Date.now() / 1000)): { identity: NormalizedIdentity; challenge: string } {
  try {
    const start = verify(START, startToken, config, now);
    if (typeof start.challenge !== 'string' || !PKCE.test(start.challenge)) throw new Error();
    if (typeof sessionToken !== 'string' || !sessionToken) throw new Error();
    const { emailVerified: _drop, ...identity } = verifySession(sessionToken, config, now);
    const sessionIat = (jwt.decode(sessionToken) as { iat?: unknown } | null)?.iat;
    if (!Number.isSafeInteger(sessionIat) || (sessionIat as number) < (start.iat as number)) throw new Error();
    return { identity, challenge: start.challenge };
  } catch { throw new AuthValidationError(); }
}

/** Turns a hand-off code into a mobile session, only for the app that holds the PKCE verifier. */
export function exchangeMobileHandoff(code: unknown, verifier: unknown, config: SessionConfig, now = Math.floor(Date.now() / 1000)): { token: string; expiresAt: string } {
  try {
    if (typeof verifier !== 'string' || !PKCE.test(verifier)) throw new Error();
    const p = verify(HANDOFF, code, config, now);
    if (typeof p.challenge !== 'string' || !constantEqual(p.challenge, pkceChallenge(verifier))) throw new Error();
    const identity = identityFrom(p);
    return { token: issueMobileSession(identity, config, now), expiresAt: new Date((now + SESSION_SECONDS) * 1000).toISOString() };
  } catch { throw new AuthValidationError(); }
}

/** Exactly one `Authorization: Bearer <token>` header, or none. Anything else is refused, never ignored. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== 'string') throw new AuthValidationError();
  const match = /^Bearer ([A-Za-z0-9_.-]{1,8192})$/.exec(header);
  if (!match) throw new AuthValidationError();
  return match[1];
}
