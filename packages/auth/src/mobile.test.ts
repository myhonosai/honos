import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { AuthValidationError, sessionConfig, type Environment } from './config.js';
import { issueSession, verifySession, SESSION_SECONDS } from './session.js';
import { pkceChallenge } from './transaction.js';
import {
  MOBILE_HANDOFF_SECONDS, MOBILE_START_SECONDS, bearerToken, exchangeMobileHandoff, issueMobileHandoff, issueMobileSession,
  issueMobileStart, mobileHandoffForBrowser, verifyMobileSession, verifyMobileStart,
} from './mobile.js';

const secret = 'TEST_ONLY_HON_KEY_123456789012345678901234';
const env: Environment = { NODE_ENV: 'production', HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: secret, HON_SESSION_AUDIENCE: 'hon-test-app' };
const config = sessionConfig(env);
const identity = { externalSubject: 'oidc:iss:parent-1', displayName: 'Test Parent', email: 'parent@example.invalid' };
const verifier = 'v'.repeat(43);
const challenge = pkceChallenge(verifier);
const now = 1_800_000_000;

describe('mobile session', () => {
  it('round-trips the identity with the mobile type and audience', () => {
    const token = issueMobileSession(identity, config, now);
    expect(verifyMobileSession(token, config, now + 60)).toEqual(identity);
    const decoded = jwt.decode(token, { complete: true })!;
    expect(decoded.header).toEqual({ alg: 'HS256', typ: 'hon-mobile-session+jwt' });
    expect((decoded.payload as jwt.JwtPayload).aud).toBe('hon-test-app:mobile');
  });
  it('expires after the same maximum as the web session', () => {
    const token = issueMobileSession(identity, config, now);
    expect(() => verifyMobileSession(token, config, now + SESSION_SECONDS)).toThrow(AuthValidationError);
  });
  it('is never accepted as a web session, and a web session is never accepted as mobile', () => {
    expect(() => verifySession(issueMobileSession(identity, config, now), config, now + 1)).toThrow(AuthValidationError);
    expect(() => verifyMobileSession(issueSession(identity, config, now), config, now + 1)).toThrow(AuthValidationError);
  });
  it('rejects a tampered or foreign-key token', () => {
    const token = issueMobileSession(identity, config, now);
    expect(() => verifyMobileSession(token.slice(0, -2) + 'xx', config, now + 1)).toThrow(AuthValidationError);
    const forged = jwt.sign({ ...identity, iss: 'OIDC', aud: 'hon-test-app:mobile', iat: now, exp: now + 60 }, 'OTHER_KEY_000000000000000000000000000000', { algorithm: 'HS256', header: { alg: 'HS256', typ: 'hon-mobile-session+jwt' } });
    expect(() => verifyMobileSession(forged, config, now + 1)).toThrow(AuthValidationError);
  });
  it('rejects unknown claims (no family, school or role can ride along)', () => {
    const extra = jwt.sign({ ...identity, familyId: 'f', iss: 'OIDC', aud: 'hon-test-app:mobile', iat: now, exp: now + 60 }, secret, { algorithm: 'HS256', header: { alg: 'HS256', typ: 'hon-mobile-session+jwt' } });
    expect(() => verifyMobileSession(extra, config, now + 1)).toThrow(AuthValidationError);
  });
});

describe('mobile start cookie', () => {
  it('holds only a well-formed S256 challenge for ten minutes', () => {
    const token = issueMobileStart(challenge, config, now);
    expect(verifyMobileStart(token, config, now + MOBILE_START_SECONDS - 1)).toBe(challenge);
    expect(() => verifyMobileStart(token, config, now + MOBILE_START_SECONDS)).toThrow(AuthValidationError);
    expect(() => issueMobileStart('short', config, now)).toThrow(AuthValidationError);
    expect(() => verifyMobileStart(undefined, config, now)).toThrow(AuthValidationError);
  });
});

describe('mobile hand-off code', () => {
  it('exchanges once the app proves the verifier, giving a mobile session for the same identity', () => {
    const code = issueMobileHandoff(identity, challenge, config, now);
    const session = exchangeMobileHandoff(code, verifier, config, now + 5);
    expect(verifyMobileSession(session.token, config, now + 6)).toEqual(identity);
    expect(session.expiresAt).toBe(new Date((now + 5 + SESSION_SECONDS) * 1000).toISOString());
  });
  it('is useless without the matching verifier', () => {
    const code = issueMobileHandoff(identity, challenge, config, now);
    expect(() => exchangeMobileHandoff(code, 'w'.repeat(43), config, now + 5)).toThrow(AuthValidationError);
    expect(() => exchangeMobileHandoff(code, 'bad', config, now + 5)).toThrow(AuthValidationError);
  });
  it('expires after a minute', () => {
    const code = issueMobileHandoff(identity, challenge, config, now);
    expect(() => exchangeMobileHandoff(code, verifier, config, now + MOBILE_HANDOFF_SECONDS)).toThrow(AuthValidationError);
  });
  it('cannot be used as a session, and a session cannot be used as a code', () => {
    const code = issueMobileHandoff(identity, challenge, config, now);
    expect(() => verifyMobileSession(code, config, now + 1)).toThrow(AuthValidationError);
    expect(() => verifySession(code, config, now + 1)).toThrow(AuthValidationError);
    expect(() => exchangeMobileHandoff(issueMobileSession(identity, config, now), verifier, config, now + 1)).toThrow(AuthValidationError);
  });
});

describe('browser hand-off', () => {
  const start = issueMobileStart(challenge, config, now);
  it('accepts a web session issued at or after the app started sign-in', () => {
    expect(mobileHandoffForBrowser(issueSession(identity, config, now), start, config, now + 1)).toEqual({ identity, challenge });
    expect(mobileHandoffForBrowser(issueSession(identity, config, now + 30), start, config, now + 31)).toEqual({ identity, challenge });
  });
  it('refuses an older web session (a link to start opened in an already signed-in browser)', () => {
    expect(() => mobileHandoffForBrowser(issueSession(identity, config, now - 1), start, config, now + 1)).toThrow(AuthValidationError);
  });
  it('refuses a missing or wrong-type start cookie or session', () => {
    const session = issueSession(identity, config, now);
    expect(() => mobileHandoffForBrowser(session, undefined, config, now + 1)).toThrow(AuthValidationError);
    expect(() => mobileHandoffForBrowser(undefined, start, config, now + 1)).toThrow(AuthValidationError);
    expect(() => mobileHandoffForBrowser(issueMobileSession(identity, config, now), start, config, now + 1)).toThrow(AuthValidationError);
    expect(() => mobileHandoffForBrowser(session, session, config, now + 1)).toThrow(AuthValidationError);
  });
});

describe('bearer header', () => {
  it('reads exactly one well-formed bearer token', () => {
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(() => bearerToken('Basic abc')).toThrow(AuthValidationError);
    expect(() => bearerToken('Bearer ')).toThrow(AuthValidationError);
    expect(() => bearerToken('Bearer a b')).toThrow(AuthValidationError);
    expect(() => bearerToken(['Bearer a', 'Bearer b'])).toThrow(AuthValidationError);
  });
});
