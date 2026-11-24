import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { AuthValidationError, sessionConfig, type Environment } from './config.js';
import { issueSession, verifySession, SESSION_SECONDS } from './session.js';
import { pkceChallenge } from './transaction.js';
import {
  MOBILE_HANDOFF_SECONDS, MOBILE_START_SECONDS, MobileHandoffUnavailableError, bearerToken, exchangeMobileHandoff, issueMobileHandoff, issueMobileSession,
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

const ledger = () => { const seen = new Set<string>(); const calls: { app: string; jti: string; expiresAt: Date }[] = [];
  const redeem = async (r: { app: 'family' | 'staff'; jti: string; expiresAt: Date }) => { calls.push(r); const k = `${r.app}:${r.jti}`; if (seen.has(k)) return false; seen.add(k); return true; };
  return { calls, redeem }; };

describe('mobile hand-off code', () => {
  it('exchanges once the app proves the verifier, giving a mobile session for the same identity', async () => {
    const code = issueMobileHandoff(identity, challenge, config, now);
    const l = ledger();
    const session = await exchangeMobileHandoff(code, verifier, l.redeem, config, now + 5);
    expect(verifyMobileSession(session.token, config, now + 6)).toEqual(identity);
    expect(session.expiresAt).toBe(new Date((now + 5 + SESSION_SECONDS) * 1000).toISOString());
    expect(l.calls).toHaveLength(1);
    expect(l.calls[0]!.app).toBe('family');
    expect(l.calls[0]!.expiresAt.getTime()).toBe((now + MOBILE_HANDOFF_SECONDS) * 1000);
  });
  it('is single use: the same code and verifier a second time is refused (security review 2026-11-22)', async () => {
    const code = issueMobileHandoff(identity, challenge, config, now);
    const l = ledger();
    await exchangeMobileHandoff(code, verifier, l.redeem, config, now + 5);
    await expect(exchangeMobileHandoff(code, verifier, l.redeem, config, now + 6)).rejects.toThrow(AuthValidationError);
    expect(l.calls.map(c => c.jti)).toEqual([l.calls[0]!.jti, l.calls[0]!.jti]);
  });
  it('gives every code its own jti', async () => {
    const l = ledger();
    await exchangeMobileHandoff(issueMobileHandoff(identity, challenge, config, now), verifier, l.redeem, config, now + 1);
    await exchangeMobileHandoff(issueMobileHandoff(identity, challenge, config, now), verifier, l.redeem, config, now + 1);
    expect(new Set(l.calls.map(c => c.jti)).size).toBe(2);
  });
  it('issues nothing when the ledger cannot answer, or answers anything but true', async () => {
    const code = issueMobileHandoff(identity, challenge, config, now);
    await expect(exchangeMobileHandoff(code, verifier, async () => { throw new Error('down'); }, config, now + 5)).rejects.toThrow(MobileHandoffUnavailableError);
    await expect(exchangeMobileHandoff(code, verifier, async () => 'yes' as unknown as boolean, config, now + 5)).rejects.toThrow(AuthValidationError);
  });
  it('is useless without the matching verifier, and an invalid code never reaches the ledger', async () => {
    const code = issueMobileHandoff(identity, challenge, config, now);
    const l = ledger();
    await expect(exchangeMobileHandoff(code, 'w'.repeat(43), l.redeem, config, now + 5)).rejects.toThrow(AuthValidationError);
    await expect(exchangeMobileHandoff(code, 'bad', l.redeem, config, now + 5)).rejects.toThrow(AuthValidationError);
    expect(l.calls).toHaveLength(0);
  });
  it('refuses a code without a jti (issued before 0655)', async () => {
    const legacy = jwt.sign({ externalSubject: identity.externalSubject, displayName: identity.displayName, email: identity.email, challenge, iss: config.mode, aud: `${config.audience}:mobile-handoff`, iat: now, exp: now + 60 },
      config.secret, { algorithm: 'HS256', header: { alg: 'HS256', typ: 'hon-mobile-handoff+jwt' } });
    const l = ledger();
    await expect(exchangeMobileHandoff(legacy, verifier, l.redeem, config, now + 5)).rejects.toThrow(AuthValidationError);
    expect(l.calls).toHaveLength(0);
  });
  it('expires after a minute', async () => {
    const code = issueMobileHandoff(identity, challenge, config, now);
    await expect(exchangeMobileHandoff(code, verifier, ledger().redeem, config, now + MOBILE_HANDOFF_SECONDS)).rejects.toThrow(AuthValidationError);
  });
  it('cannot be used as a session, and a session cannot be used as a code', async () => {
    const code = issueMobileHandoff(identity, challenge, config, now);
    expect(() => verifyMobileSession(code, config, now + 1)).toThrow(AuthValidationError);
    expect(() => verifySession(code, config, now + 1)).toThrow(AuthValidationError);
    await expect(exchangeMobileHandoff(issueMobileSession(identity, config, now), verifier, ledger().redeem, config, now + 1)).rejects.toThrow(AuthValidationError);
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

// S0 HON Staff app: a separate token family. Family and staff tokens must never verify as each other.
import {
  STAFF_MOBILE_START_COOKIE, exchangeStaffMobileHandoff, issueStaffMobileHandoff, issueStaffMobileSession, issueStaffMobileStart,
  staffMobileHandoffForBrowser, verifyStaffMobileSession, verifyStaffMobileStart,
} from './mobile.js';

describe('staff mobile session (S0)', () => {
  it('round-trips with its own type and audience', () => {
    const token = issueStaffMobileSession(identity, config, now);
    expect(verifyStaffMobileSession(token, config, now + 60)).toEqual(identity);
    const decoded = jwt.decode(token, { complete: true })!;
    expect(decoded.header).toEqual({ alg: 'HS256', typ: 'hon-staff-mobile-session+jwt' });
    expect((decoded.payload as jwt.JwtPayload).aud).toBe('hon-test-app:staff-mobile');
    expect(() => verifyStaffMobileSession(token, config, now + SESSION_SECONDS)).toThrow(AuthValidationError);
  });
  it('family, staff and web sessions never verify as each other', () => {
    const staff = issueStaffMobileSession(identity, config, now);
    expect(() => verifyMobileSession(staff, config, now + 1)).toThrow(AuthValidationError);
    expect(() => verifySession(staff, config, now + 1)).toThrow(AuthValidationError);
    expect(() => verifyStaffMobileSession(issueMobileSession(identity, config, now), config, now + 1)).toThrow(AuthValidationError);
    expect(() => verifyStaffMobileSession(issueSession(identity, config, now), config, now + 1)).toThrow(AuthValidationError);
  });
  it('a staff session with the family typ but staff audience (or the reverse) is refused', () => {
    const mixed = jwt.sign({ ...identity, iss: 'OIDC', aud: 'hon-test-app:staff-mobile', iat: now, exp: now + 60 }, secret, { algorithm: 'HS256', header: { alg: 'HS256', typ: 'hon-mobile-session+jwt' } });
    expect(() => verifyStaffMobileSession(mixed, config, now + 1)).toThrow(AuthValidationError);
    expect(() => verifyMobileSession(mixed, config, now + 1)).toThrow(AuthValidationError);
  });
  it('start cookie: own cookie name, own type, challenge validated', () => {
    expect(STAFF_MOBILE_START_COOKIE).toBe('hon_staff_mobile_start');
    const start = issueStaffMobileStart(challenge, config, now);
    expect(verifyStaffMobileStart(start, config, now + 1)).toBe(challenge);
    expect(() => verifyMobileStart(start, config, now + 1)).toThrow(AuthValidationError);
    expect(() => verifyStaffMobileStart(issueMobileStart(challenge, config, now), config, now + 1)).toThrow(AuthValidationError);
    expect(() => issueStaffMobileStart('short', config, now)).toThrow(AuthValidationError);
    expect(() => verifyStaffMobileStart(start, config, now + MOBILE_START_SECONDS)).toThrow(AuthValidationError);
  });
  it('hand-off: exchanges only with the verifier, only on the staff side, within 60 s, once', async () => {
    const code = issueStaffMobileHandoff(identity, challenge, config, now);
    const l = ledger();
    await expect(exchangeStaffMobileHandoff(code, 'w'.repeat(43), l.redeem, config, now + 5)).rejects.toThrow(AuthValidationError);
    await expect(exchangeMobileHandoff(code, verifier, l.redeem, config, now + 5)).rejects.toThrow(AuthValidationError);
    await expect(exchangeStaffMobileHandoff(issueMobileHandoff(identity, challenge, config, now), verifier, l.redeem, config, now + 5)).rejects.toThrow(AuthValidationError);
    expect(l.calls).toHaveLength(0);
    const { token, expiresAt } = await exchangeStaffMobileHandoff(code, verifier, l.redeem, config, now + 5);
    expect(verifyStaffMobileSession(token, config, now + 6)).toEqual(identity);
    expect(expiresAt).toBe(new Date((now + 5 + SESSION_SECONDS) * 1000).toISOString());
    expect(l.calls.map(c => c.app)).toEqual(['staff']);
    await expect(exchangeStaffMobileHandoff(code, verifier, l.redeem, config, now + 6)).rejects.toThrow(AuthValidationError);
    await expect(exchangeStaffMobileHandoff(code, verifier, ledger().redeem, config, now + MOBILE_HANDOFF_SECONDS)).rejects.toThrow(AuthValidationError);
  });

  it('browser side: needs the staff start cookie and a web session issued at or after it', () => {
    const start = issueStaffMobileStart(challenge, config, now);
    const fresh = issueSession(identity, config, now + 10);
    expect(staffMobileHandoffForBrowser(fresh, start, config, now + 20)).toEqual({ identity, challenge });
    expect(() => staffMobileHandoffForBrowser(issueSession(identity, config, now - 1), start, config, now + 20)).toThrow(AuthValidationError);
    expect(() => staffMobileHandoffForBrowser(fresh, issueMobileStart(challenge, config, now), config, now + 20)).toThrow(AuthValidationError);
    expect(() => mobileHandoffForBrowser(fresh, start, config, now + 20)).toThrow(AuthValidationError);
    expect(() => staffMobileHandoffForBrowser(undefined, start, config, now + 20)).toThrow(AuthValidationError);
  });
});
