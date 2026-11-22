import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { NextRequest } from 'next/server';
import { HON_SESSION_COOKIE, MOBILE_START_COOKIE, STAFF_MOBILE_START_COOKIE, exchangeMobileHandoff, exchangeStaffMobileHandoff, issueMobileStart, issueSession, issueStaffMobileSession, issueStaffMobileStart, pkceChallenge, sessionConfig, verifyStaffMobileSession, verifyStaffMobileStart } from '@hon/auth';
import { GET as start } from '../src/app/auth/staff-mobile/start/route';
import { GET as finish, POST as finishPost } from '../src/app/auth/staff-mobile/finish/route';

const testEnv = { NODE_ENV: 'production', HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: 'TEST_ONLY_HON_KEY_123456789012345678901234', HON_SESSION_AUDIENCE: 'hon-web-test', HON_PUBLIC_ORIGIN: 'https://hon.example', HON_OIDC_ISSUER: 'https://provider.example/issuer', HON_OIDC_AUTHORIZATION_ENDPOINT: 'https://provider.example/authorize', HON_OIDC_TOKEN_ENDPOINT: 'https://provider.example/token', HON_OIDC_JWKS_URI: 'https://provider.example/jwks', HON_OIDC_CLIENT_ID: 'hon-web-client', HON_OIDC_SCOPES: 'openid profile email', HON_OIDC_REDIRECT_URI: 'https://hon.example/auth/callback', HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'none' };
const identity = { externalSubject: 'oidc:staff', displayName: 'Test Instructor' };
const verifier = 'v'.repeat(43);
const challenge = pkceChallenge(verifier);
let saved: NodeJS.ProcessEnv;
beforeEach(() => { saved = { ...process.env }; Object.assign(process.env, testEnv); });
afterEach(() => { process.env = saved; });
const req = (path: string, cookie?: string) => new NextRequest(`https://hon.example${path}`, { headers: { host: 'hon.example', ...(cookie ? { cookie } : {}) } });
const setCookie = (r: Response, name: string) => r.headers.getSetCookie().find(c => c.startsWith(`${name}=`));

describe('/auth/staff-mobile/start', () => {
  it('remembers only the app challenge and sends the parent to the normal sign-in with the mobile intent', async () => {
    const response = await start(req(`/auth/staff-mobile/start?challenge=${challenge}`));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://hon.example/auth/login?for=staff-mobile');
    const cookie = setCookie(response, STAFF_MOBILE_START_COOKIE)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/auth/);
    expect(verifyStaffMobileStart(decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!), sessionConfig())).toBe(challenge);
  });
  it.each(['', 'short', `${challenge}x`, `${challenge}&challenge=${challenge}`])('refuses a bad challenge %j', async bad => {
    const response = await start(req(`/auth/staff-mobile/start?challenge=${bad}`));
    expect(response.status).toBe(400);
    expect(setCookie(response, STAFF_MOBILE_START_COOKIE)).toBeUndefined();
  });
});

describe('/auth/staff-mobile/finish', () => {
  const both = (sessionIat?: number) => `${HON_SESSION_COOKIE}=${issueSession(identity, sessionConfig(), sessionIat)}; ${STAFF_MOBILE_START_COOKIE}=${issueStaffMobileStart(challenge, sessionConfig())}`;
  const post = (cookie: string, headers: Record<string, string> = { origin: 'https://hon.example' }, path = '/auth/staff-mobile/finish') =>
    new NextRequest(`https://hon.example${path}`, { method: 'POST', headers: { host: 'hon.example', cookie, ...headers } });

  it('a GET only shows who is signed in and never hands anything to the app', async () => {
    const response = await finish(req('/auth/staff-mobile/finish', both()));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    const html = await response.text();
    expect(html).not.toMatch(/honstaff:\/\/auth\?code/);
    expect(html).toContain('Test Instructor');
    expect(html).toContain('<form method="post" action="/auth/staff-mobile/finish">');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
    expect(setCookie(response, STAFF_MOBILE_START_COOKIE)).toBeUndefined();
  });
  it('escapes the name shown on the page', async () => {
    const cookie = `${HON_SESSION_COOKIE}=${issueSession({ ...identity, displayName: '<b>x</b>' }, sessionConfig())}; ${STAFF_MOBILE_START_COOKIE}=${issueStaffMobileStart(challenge, sessionConfig())}`;
    const html = await (await finish(req('/auth/staff-mobile/finish', cookie))).text();
    expect(html).not.toContain('<b>x</b>');
  });
  it('Continue from HON\'s own page hands the app a one-time code, only to the fixed app address', async () => {
    const response = await finishPost(post(both()));
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    expect(`${location.protocol}//${location.host}${location.pathname}`).toBe('honstaff://auth');
    const code = location.searchParams.get('code')!;
    const session = exchangeStaffMobileHandoff(code, verifier, sessionConfig());
    expect(verifyStaffMobileSession(session.token, sessionConfig())).toEqual(identity);
    expect(setCookie(response, STAFF_MOBILE_START_COOKIE)).toMatch(/Max-Age=0/);
  });
  it('accepts a null Origin only when the browser reports same-origin', async () => {
    expect((await finishPost(post(both(), { origin: 'null', 'sec-fetch-site': 'same-origin' }))).status).toBe(303);
    expect((await finishPost(post(both(), { 'sec-fetch-site': 'same-origin' }))).status).toBe(303);
    expect((await finishPost(post(both(), { origin: 'null', 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await finishPost(post(both(), {}))).status).toBe(403);
  });
  it('refuses a cross-site POST (another site submitting the form)', async () => {
    const response = await finishPost(post(both(), { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }));
    expect(response.status).toBe(403);
    expect(response.headers.get('location')).toBeNull();
  });
  it('refuses a web session older than the app\'s sign-in start (an already signed-in everyday browser)', async () => {
    const old = Math.floor(Date.now() / 1000) - 120;
    expect((await finish(req('/auth/staff-mobile/finish', both(old)))).status).toBe(401);
    expect((await finishPost(post(both(old)))).status).toBe(401);
  });
  it('refuses without the start cookie, without a web session, or with a mobile token as the session', async () => {
    for (const cookie of [
      `${HON_SESSION_COOKIE}=${issueSession(identity, sessionConfig())}`,
      `${STAFF_MOBILE_START_COOKIE}=${issueStaffMobileStart(challenge, sessionConfig())}`,
      `${HON_SESSION_COOKIE}=${issueStaffMobileSession(identity, sessionConfig())}; ${STAFF_MOBILE_START_COOKIE}=${issueStaffMobileStart(challenge, sessionConfig())}`,
    ]) {
      expect((await finish(req('/auth/staff-mobile/finish', cookie))).status).toBe(401);
      expect((await finishPost(post(cookie))).status).toBe(401);
    }
  });
  it('ignores any return address in the request', async () => {
    const response = await finishPost(post(both(), undefined, '/auth/staff-mobile/finish?redirect=https://evil.example&code=x'));
    expect(response.headers.get('location')).toMatch(/^honstaff:\/\/auth\?code=/);
  });
});

describe('staff app sign-in end to end (web side)', () => {
  it('start -> login stores the mobile intent -> continue lands on the confirmation page, never the app', async () => {
    const { GET: login } = await import('../src/app/auth/login/route');
    const { GET: continueRoute } = await import('../src/app/auth/continue/route');
    const started = await start(req(`/auth/staff-mobile/start?challenge=${challenge}`));
    expect(new URL(started.headers.get('location')!).pathname + new URL(started.headers.get('location')!).search).toBe('/auth/login?for=staff-mobile');
    const loggedIn = await login(req('/auth/login?for=staff-mobile'));
    expect(loggedIn.cookies.get('hon_post_login')?.value).toBe('staff-mobile');
    const continued = await continueRoute(req('/auth/continue', `${HON_SESSION_COOKIE}=${issueSession(identity, sessionConfig())}; hon_post_login=staff-mobile`));
    expect(continued.headers.get('location')).toBe('/auth/staff-mobile/finish');
  });
});

describe('staff and family hand-offs never cross', () => {
  const session = () => `${HON_SESSION_COOKIE}=${issueSession(identity, sessionConfig())}`;
  const post = (cookie: string) => new NextRequest('https://hon.example/auth/staff-mobile/finish', { method: 'POST', headers: { host: 'hon.example', cookie, origin: 'https://hon.example' } });
  it('a family start cookie does not open the staff confirmation, and the staff code is not a family code', async () => {
    const familyStart = `${session()}; ${MOBILE_START_COOKIE}=${issueMobileStart(challenge, sessionConfig())}`;
    expect((await finish(req('/auth/staff-mobile/finish', familyStart))).status).toBe(401);
    expect((await finishPost(post(familyStart))).status).toBe(401);
    const staffStart = `${session()}; ${STAFF_MOBILE_START_COOKIE}=${issueStaffMobileStart(challenge, sessionConfig())}`;
    const code = new URL((await finishPost(post(staffStart))).headers.get('location')!).searchParams.get('code')!;
    expect(() => exchangeMobileHandoff(code, verifier, sessionConfig())).toThrow();
  });
  it('the staff page names the HON Staff app', async () => {
    const staffStart = `${session()}; ${STAFF_MOBILE_START_COOKIE}=${issueStaffMobileStart(challenge, sessionConfig())}`;
    const html = await (await finish(req('/auth/staff-mobile/finish', staffStart))).text();
    expect(html).toContain('Continue to the HON Staff app?');
    expect(html).not.toContain('HON Family');
  });
});
