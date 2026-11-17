import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { HON_SESSION_COOKIE, MOBILE_START_COOKIE, exchangeMobileHandoff, issueMobileSession, issueMobileStart, issueSession, pkceChallenge, sessionConfig, verifyMobileSession, verifyMobileStart } from '@hon/auth';
import { GET as start } from '../src/app/auth/mobile/start/route';
import { GET as finish } from '../src/app/auth/mobile/finish/route';

const testEnv = { NODE_ENV: 'production', HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: 'TEST_ONLY_HON_KEY_123456789012345678901234', HON_SESSION_AUDIENCE: 'hon-web-test', HON_PUBLIC_ORIGIN: 'https://hon.example', HON_OIDC_ISSUER: 'https://provider.example/issuer', HON_OIDC_AUTHORIZATION_ENDPOINT: 'https://provider.example/authorize', HON_OIDC_TOKEN_ENDPOINT: 'https://provider.example/token', HON_OIDC_JWKS_URI: 'https://provider.example/jwks', HON_OIDC_CLIENT_ID: 'hon-web-client', HON_OIDC_SCOPES: 'openid profile email', HON_OIDC_REDIRECT_URI: 'https://hon.example/auth/callback', HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'none' };
const identity = { externalSubject: 'oidc:parent', displayName: 'Test Parent' };
const verifier = 'v'.repeat(43);
const challenge = pkceChallenge(verifier);
let saved: NodeJS.ProcessEnv;
beforeEach(() => { saved = { ...process.env }; Object.assign(process.env, testEnv); });
afterEach(() => { process.env = saved; });
const req = (path: string, cookie?: string) => new NextRequest(`https://hon.example${path}`, { headers: { host: 'hon.example', ...(cookie ? { cookie } : {}) } });
const setCookie = (r: Response, name: string) => r.headers.getSetCookie().find(c => c.startsWith(`${name}=`));

describe('/auth/mobile/start', () => {
  it('remembers only the app challenge and sends the parent to the normal sign-in with the mobile intent', async () => {
    const response = await start(req(`/auth/mobile/start?challenge=${challenge}`));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://hon.example/auth/login?for=mobile');
    const cookie = setCookie(response, MOBILE_START_COOKIE)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/auth/);
    expect(verifyMobileStart(decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!), sessionConfig())).toBe(challenge);
  });
  it.each(['', 'short', `${challenge}x`, `${challenge}&challenge=${challenge}`])('refuses a bad challenge %j', async bad => {
    const response = await start(req(`/auth/mobile/start?challenge=${bad}`));
    expect(response.status).toBe(400);
    expect(setCookie(response, MOBILE_START_COOKIE)).toBeUndefined();
  });
});

describe('/auth/mobile/finish', () => {
  const both = () => `${HON_SESSION_COOKIE}=${issueSession(identity, sessionConfig())}; ${MOBILE_START_COOKIE}=${issueMobileStart(challenge, sessionConfig())}`;
  it('hands the app a one-time code for the signed-in parent, only to the fixed app address', async () => {
    const response = await finish(req('/auth/mobile/finish', both()));
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    expect(`${location.protocol}//${location.host}${location.pathname}`).toBe('honparent://auth');
    const code = location.searchParams.get('code')!;
    const session = exchangeMobileHandoff(code, verifier, sessionConfig());
    expect(verifyMobileSession(session.token, sessionConfig())).toEqual(identity);
    expect(setCookie(response, MOBILE_START_COOKIE)).toMatch(/Max-Age=0/);
  });
  it('refuses without the start cookie, without a web session, or with a mobile token as the session', async () => {
    expect((await finish(req('/auth/mobile/finish', `${HON_SESSION_COOKIE}=${issueSession(identity, sessionConfig())}`))).status).toBe(400);
    expect((await finish(req('/auth/mobile/finish', `${MOBILE_START_COOKIE}=${issueMobileStart(challenge, sessionConfig())}`))).status).toBe(401);
    expect((await finish(req('/auth/mobile/finish', `${HON_SESSION_COOKIE}=${issueMobileSession(identity, sessionConfig())}; ${MOBILE_START_COOKIE}=${issueMobileStart(challenge, sessionConfig())}`))).status).toBe(401);
  });
  it('ignores any return address in the request', async () => {
    const response = await finish(req('/auth/mobile/finish?redirect=https://evil.example&code=x', both()));
    expect(response.headers.get('location')).toMatch(/^honparent:\/\/auth\?code=/);
  });
});
