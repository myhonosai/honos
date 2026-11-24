import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AuthValidationError, type SessionConfig } from './config.js';
import { normalizedIdentity, SESSION_SECONDS, verifySession, type NormalizedIdentity } from './session.js';
import { constantEqual, pkceChallenge } from './transaction.js';

/**
 * Native app sign-in: HON Family (parent) app (M2) and HON Staff app (S0). The app never talks to the identity provider directly: it reuses the web OIDC
 * sign-in in the system browser, which hands back a one-minute code bound to the app's PKCE challenge. Only the app
 * holds the verifier, so an intercepted code is useless (RFC 7636 / RFC 8252). Each token kind has its own JWT type
 * and audience, so none can be replayed as another (web session, start cookie, hand-off code, mobile session).
 */
export const MOBILE_START_COOKIE = 'hon_mobile_start';
export const MOBILE_START_SECONDS = 600;
export const MOBILE_HANDOFF_SECONDS = 60;
const PKCE = /^[A-Za-z0-9_-]{43}$/;
const JTI = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY_CLAIMS = ['externalSubject', 'displayName', 'email'] as const;

type Kind = { typ: string; aud: (c: SessionConfig) => string; seconds: number; extra: readonly string[] };
type Family = { app: MobileApp; session: Kind; start: Kind; handoff: Kind };
export type MobileApp = 'family' | 'staff';
/**
 * Records one hand-off code as used. Resolves true the first time a code (app + jti) is seen and false for a replay;
 * rejects when the ledger cannot be reached. The API backs this with hon.redeem_mobile_handoff (0655).
 */
export type MobileHandoffRedeemer = (redemption: { app: MobileApp; jti: string; expiresAt: Date }) => Promise<boolean>;
/** The ledger could not answer: the code was not used and the app may try again. */
export class MobileHandoffUnavailableError extends Error {}
/** One token family per native app. Each has its own JWT types and audiences, so no token verifies in the other app. */
function family(prefix: 'mobile' | 'staff-mobile'): Family {
  return {
    app: prefix === 'mobile' ? 'family' : 'staff',
    session: { typ: `hon-${prefix}-session+jwt`, aud: c => `${c.audience}:${prefix}`, seconds: SESSION_SECONDS, extra: IDENTITY_CLAIMS },
    start: { typ: `hon-${prefix}-start+jwt`, aud: c => `${c.audience}:${prefix}-start`, seconds: MOBILE_START_SECONDS, extra: ['challenge'] },
    handoff: { typ: `hon-${prefix}-handoff+jwt`, aud: c => `${c.audience}:${prefix}-handoff`, seconds: MOBILE_HANDOFF_SECONDS, extra: [...IDENTITY_CLAIMS, 'challenge', 'jti'] },
  };
}
/** HON Family (parent) app, M2. */
const FAMILY = family('mobile');
/** HON Staff app, S0. */
const STAFF = family('staff-mobile');

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

function issueSessionFor(f: Family, identity: NormalizedIdentity, config: SessionConfig, now: number): string {
  return sign(f.session, profile(identity), config, now);
}
function verifySessionFor(f: Family, token: string, config: SessionConfig, now: number): NormalizedIdentity {
  try { return identityFrom(verify(f.session, token, config, now)); } catch { throw new AuthValidationError(); }
}
function issueStartFor(f: Family, challenge: string, config: SessionConfig, now: number): string {
  if (!PKCE.test(challenge)) throw new AuthValidationError();
  return sign(f.start, { challenge }, config, now);
}
function verifyStartFor(f: Family, token: string | undefined, config: SessionConfig, now: number): string {
  try {
    const p = verify(f.start, token, config, now);
    if (typeof p.challenge !== 'string' || !PKCE.test(p.challenge)) throw new Error();
    return p.challenge;
  } catch { throw new AuthValidationError(); }
}
function issueHandoffFor(f: Family, identity: NormalizedIdentity, challenge: string, config: SessionConfig, now: number): string {
  if (!PKCE.test(challenge)) throw new AuthValidationError();
  return sign(f.handoff, { ...profile(identity), challenge, jti: randomUUID() }, config, now);
}
/**
 * The browser side of the hand-off: the web session and the app's start cookie must both be valid, and the web
 * session must have been issued at or after the start cookie. The app opens an ephemeral browser session, so a real
 * app sign-in always produces a fresh web session; an older session already sitting in the person's everyday browser
 * (someone else's link to the start page) is refused and they must sign in again.
 */
function handoffForBrowserFor(f: Family, sessionToken: string | undefined, startToken: string | undefined, config: SessionConfig, now: number): { identity: NormalizedIdentity; challenge: string } {
  try {
    const start = verify(f.start, startToken, config, now);
    if (typeof start.challenge !== 'string' || !PKCE.test(start.challenge)) throw new Error();
    if (typeof sessionToken !== 'string' || !sessionToken) throw new Error();
    const { emailVerified: _drop, ...identity } = verifySession(sessionToken, config, now);
    const sessionIat = (jwt.decode(sessionToken) as { iat?: unknown } | null)?.iat;
    if (!Number.isSafeInteger(sessionIat) || (sessionIat as number) < (start.iat as number)) throw new Error();
    return { identity, challenge: start.challenge };
  } catch { throw new AuthValidationError(); }
}
/**
 * Turns a hand-off code into a session of the same app, only for the app that holds the PKCE verifier, and only once:
 * the code's jti must be recorded as used by `redeem` before a session is issued (security review 2026-11-22). A
 * replayed code, a code without a jti, or any invalid input is AuthValidationError; an unreachable ledger is
 * MobileHandoffUnavailableError and issues nothing.
 */
async function exchangeFor(f: Family, code: unknown, verifier: unknown, redeem: MobileHandoffRedeemer, config: SessionConfig, now: number): Promise<{ token: string; expiresAt: string }> {
  let identity: NormalizedIdentity, jti: string, exp: number;
  try {
    if (typeof verifier !== 'string' || !PKCE.test(verifier)) throw new Error();
    const p = verify(f.handoff, code, config, now);
    if (typeof p.challenge !== 'string' || !constantEqual(p.challenge, pkceChallenge(verifier))) throw new Error();
    if (typeof p.jti !== 'string' || !JTI.test(p.jti)) throw new Error();
    identity = identityFrom(p); jti = p.jti; exp = p.exp as number;
  } catch { throw new AuthValidationError(); }
  let fresh: boolean;
  try { fresh = await redeem({ app: f.app, jti, expiresAt: new Date(exp * 1000) }); }
  catch { throw new MobileHandoffUnavailableError(); }
  if (fresh !== true) throw new AuthValidationError();
  return { token: issueSessionFor(f, identity, config, now), expiresAt: new Date((now + SESSION_SECONDS) * 1000).toISOString() };
}
const nowSeconds = () => Math.floor(Date.now() / 1000);

// HON Family (parent) app: names and behaviour unchanged since M2.
export const issueMobileSession = (identity: NormalizedIdentity, config: SessionConfig, now = nowSeconds()) => issueSessionFor(FAMILY, identity, config, now);
export const verifyMobileSession = (token: string, config: SessionConfig, now = nowSeconds()) => verifySessionFor(FAMILY, token, config, now);
export const issueMobileStart = (challenge: string, config: SessionConfig, now = nowSeconds()) => issueStartFor(FAMILY, challenge, config, now);
export const verifyMobileStart = (token: string | undefined, config: SessionConfig, now = nowSeconds()) => verifyStartFor(FAMILY, token, config, now);
export const issueMobileHandoff = (identity: NormalizedIdentity, challenge: string, config: SessionConfig, now = nowSeconds()) => issueHandoffFor(FAMILY, identity, challenge, config, now);
export const mobileHandoffForBrowser = (sessionToken: string | undefined, startToken: string | undefined, config: SessionConfig, now = nowSeconds()) => handoffForBrowserFor(FAMILY, sessionToken, startToken, config, now);
export const exchangeMobileHandoff = (code: unknown, verifier: unknown, redeem: MobileHandoffRedeemer, config: SessionConfig, now = nowSeconds()) => exchangeFor(FAMILY, code, verifier, redeem, config, now);

// HON Staff app (S0): the same flow with its own token family and start cookie.
export const STAFF_MOBILE_START_COOKIE = 'hon_staff_mobile_start';
export const issueStaffMobileSession = (identity: NormalizedIdentity, config: SessionConfig, now = nowSeconds()) => issueSessionFor(STAFF, identity, config, now);
export const verifyStaffMobileSession = (token: string, config: SessionConfig, now = nowSeconds()) => verifySessionFor(STAFF, token, config, now);
export const issueStaffMobileStart = (challenge: string, config: SessionConfig, now = nowSeconds()) => issueStartFor(STAFF, challenge, config, now);
export const verifyStaffMobileStart = (token: string | undefined, config: SessionConfig, now = nowSeconds()) => verifyStartFor(STAFF, token, config, now);
export const issueStaffMobileHandoff = (identity: NormalizedIdentity, challenge: string, config: SessionConfig, now = nowSeconds()) => issueHandoffFor(STAFF, identity, challenge, config, now);
export const staffMobileHandoffForBrowser = (sessionToken: string | undefined, startToken: string | undefined, config: SessionConfig, now = nowSeconds()) => handoffForBrowserFor(STAFF, sessionToken, startToken, config, now);
export const exchangeStaffMobileHandoff = (code: unknown, verifier: unknown, redeem: MobileHandoffRedeemer, config: SessionConfig, now = nowSeconds()) => exchangeFor(STAFF, code, verifier, redeem, config, now);

/** Exactly one `Authorization: Bearer <token>` header, or none. Anything else is refused, never ignored. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== 'string') throw new AuthValidationError();
  const match = /^Bearer ([A-Za-z0-9_.-]{1,8192})$/.exec(header);
  if (!match) throw new AuthValidationError();
  return match[1];
}
