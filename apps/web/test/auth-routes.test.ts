import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { NextRequest } from 'next/server';
import { AUTH_TRANSACTION_COOKIE, HON_SESSION_COOKIE, MANUS_SESSION_COOKIE, createTransaction, issueTransaction, issueSession, issueManusSession, manusConfig, oidcConfig, sessionConfig, verifySession } from '@hon/auth';
import { GET as login } from '../src/app/auth/login/route';
import { GET as callback } from '../src/app/auth/callback/route';
import { POST as logout } from '../src/app/auth/logout/route';
import { GET as me } from '../src/app/api/identity/me/route';
import { GET as readiness } from '../src/app/api/identity/readiness/route';

const testEnv = { NODE_ENV: 'production', HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: 'TEST_ONLY_HON_KEY_123456789012345678901234', HON_SESSION_AUDIENCE: 'hon-web-test', HON_PUBLIC_ORIGIN: 'https://hon.example', HON_OIDC_ISSUER: 'https://provider.example/issuer', HON_OIDC_AUTHORIZATION_ENDPOINT: 'https://provider.example/authorize', HON_OIDC_TOKEN_ENDPOINT: 'https://provider.example/token', HON_OIDC_JWKS_URI: 'https://provider.example/jwks', HON_OIDC_CLIENT_ID: 'hon-web-client', HON_OIDC_SCOPES: 'openid profile email', HON_OIDC_REDIRECT_URI: 'https://hon.example/auth/callback', HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'none' };
const identity = { externalSubject: 'dev-account', displayName: 'Test User', email: 'test@example.invalid' };
let saved: NodeJS.ProcessEnv;
let privateKey: CryptoKey; let jwk: JWK;
beforeAll(async () => { const pair = await generateKeyPair('RS256'); privateKey = pair.privateKey; jwk = { ...await exportJWK(pair.publicKey), kid: 'web-test-key', alg: 'RS256', use: 'sig' }; });
beforeEach(() => {
  saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (/^(MANUS_|HON_AUTH_|HON_SESSION_|HON_OIDC_|HON_PUBLIC_ORIGIN$)/.test(key)) delete process.env[key];
  Object.assign(process.env, testEnv);
});
afterEach(() => { process.env = saved; vi.restoreAllMocks(); });
const req = (path: string, cookie?: string) => new NextRequest(`https://hon.example${path}`, { headers: { host: 'hon.example', ...(cookie ? { cookie } : {}) } });
const configureDev = () => Object.assign(process.env, { HON_AUTH_MODE: 'MANUS_DEVELOPMENT', MANUS_PROJECT_ID: 'dev-app', MANUS_JWT_SECRET: 'TEST_ONLY_DEV_KEY_1234567890123456789012', MANUS_OAUTH_API_URL: 'https://manus-dev-api.example', MANUS_OAUTH_PORTAL_URL: 'https://manus-dev-portal.example' });
async function providerToken(nonce: string, patch: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: testEnv.HON_OIDC_ISSUER, aud: testEnv.HON_OIDC_CLIENT_ID, sub: 'oidc-account', name: identity.displayName, email: identity.email, nonce, iat: now, exp: now + 300, ...patch }).setProtectedHeader({ alg: 'RS256', kid: 'web-test-key' }).sign(privateKey);
}
async function startLogin() {
  const response = await login(req('/auth/login'));
  const authorization = new URL(response.headers.get('location')!);
  const txCookie = response.cookies.get(AUTH_TRANSACTION_COOKIE)!.value;
  return { response, authorization, txCookie };
}

describe('Next generic OIDC integration', () => {
  it('constructs authorization only from protected config with HTTPS SameSite=None cookies and no secrets', async () => {
    Object.assign(process.env, { HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'client_secret_basic', HON_OIDC_CLIENT_SECRET: 'NEVER_BROWSER_SECRET' });
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const response = await login(new NextRequest('https://hon.example/auth/login?client_id=evil&redirect_uri=https://evil.example', { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' } }));
    expect(response.status).toBe(307); expect(fetcher).not.toHaveBeenCalled();
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe('https://provider.example');
    expect(location.searchParams.get('redirect_uri')).toBe(testEnv.HON_OIDC_REDIRECT_URI);
    expect(location.searchParams.get('client_id')).toBe(testEnv.HON_OIDC_CLIENT_ID);
    expect(location.searchParams.get('scope')).toBe(testEnv.HON_OIDC_SCOPES);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    const setCookie = response.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/); expect(setCookie).toMatch(/Secure/); expect(setCookie).toMatch(/SameSite=none/i); expect(setCookie).toMatch(/Path=\/auth/);
    expect(location.href + setCookie).not.toContain('NEVER_BROWSER_SECRET'); expect(location.searchParams.has('code_verifier')).toBe(false);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('completes authorization code + JWKS validation with no Manus settings, issuing only HON identity claims', async () => {
    const { authorization, txCookie } = await startLogin();
    const token = await providerToken(authorization.searchParams.get('nonce')!);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (String(url) === testEnv.HON_OIDC_JWKS_URI) return Response.json({ keys: [jwk] });
      expect(String(url)).toBe(testEnv.HON_OIDC_TOKEN_ENDPOINT);
      expect(options?.method).toBe('POST');
      const form = new URLSearchParams(options?.body as string);
      expect(form.get('code')).toBe('AUTH_CODE'); expect(form.get('code_verifier')).toHaveLength(43);
      expect(form.get('redirect_uri')).toBe(testEnv.HON_OIDC_REDIRECT_URI);
      return Response.json({ id_token: token, access_token: 'RAW_ACCESS_TOKEN', refresh_token: 'RAW_REFRESH_TOKEN' });
    });
    const response = await callback(req(`/auth/callback?code=AUTH_CODE&state=${authorization.searchParams.get('state')}&returnTo=https://evil.example&role=HQ&schoolId=untrusted`, `${AUTH_TRANSACTION_COOKIE}=${txCookie}`));
    expect(response.status).toBe(307); expect(response.headers.get('location')).toBe('https://hon.example/auth/continue');
    const honToken = response.cookies.get(HON_SESSION_COOKIE)!.value;
    const profile = verifySession(honToken, sessionConfig());
    expect(profile.externalSubject).toBe(`oidc:${encodeURIComponent(testEnv.HON_OIDC_ISSUER)}:oidc-account`);
    expect(profile.displayName).toBe(identity.displayName);
    expect(response.cookies.get(AUTH_TRANSACTION_COOKIE)?.value).toBe('');
    expect(response.cookies.get(MANUS_SESSION_COOKIE)?.value).toBe('');
    expect(JSON.stringify(profile) + response.headers.get('set-cookie')).not.toMatch(/RAW_ACCESS_TOKEN|RAW_REFRESH_TOKEN/);
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('https://provider.example'))).toBe(true);
    const current = await me(req('/api/identity/me', `${HON_SESSION_COOKIE}=${honToken}`));
    expect(current.status).toBe(200); expect(await current.json()).toEqual({ data: profile });
  });
  it('fails state/missing/tampered/expired/PKCE bindings before any provider request and clears transactions', async () => {
    const config = oidcConfig(); const transaction = createTransaction(config.redirectUri);
    const valid = issueTransaction(transaction, config);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external auth allowed'));
    const cases: [string, string | undefined][] = [
      ['wrong-state', valid], [transaction.state, undefined], [transaction.state, 'RAW_FORGED_COOKIE'],
      [transaction.state, issueTransaction(transaction, config, Math.floor(Date.now() / 1000) - 601)],
      [transaction.state, issueTransaction({ ...transaction, verifier: 'x'.repeat(43) }, config)],
      [transaction.state, issueTransaction({ ...transaction, redirectUri: 'https://evil.example/auth/callback' }, config)],
    ];
    for (const [state, token] of cases) {
      const response = await callback(req(`/auth/callback?code=RAW_CODE&state=${state}`, token ? `${AUTH_TRANSACTION_COOKIE}=${token}` : undefined));
      expect(response.status).toBe(400); expect(response.cookies.get(AUTH_TRANSACTION_COOKIE)?.value).toBe('');
      expect(await response.text()).not.toContain('RAW_');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{ nonce: 'wrong-nonce' }, { iss: 'https://evil.example' }, { aud: 'another-app' }, { exp: 1 }])('rejects invalid id_token %j without issuing a session or leaking raw token', async (patch) => {
    const { authorization, txCookie } = await startLogin();
    const token = await providerToken(authorization.searchParams.get('nonce')!, patch);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url) === testEnv.HON_OIDC_JWKS_URI ? Response.json({ keys: [jwk] }) : Response.json({ id_token: token }));
    const response = await callback(req(`/auth/callback?code=RAW_CODE&state=${authorization.searchParams.get('state')}`, `${AUTH_TRANSACTION_COOKIE}=${txCookie}`));
    expect(response.status).toBe(503); expect(response.cookies.get(HON_SESSION_COOKIE)).toBeUndefined();
    expect(await response.text()).not.toMatch(/RAW_|eyJ|Authorization/);
  });
  it('sanitizes upstream transport errors and authorization credentials', async () => {
    const { authorization, txCookie } = await startLogin();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Authorization: Basic RAW_TOKEN CLIENT_SECRET'));
    const response = await callback(req(`/auth/callback?code=RAW_CODE&state=${authorization.searchParams.get('state')}`, `${AUTH_TRANSACTION_COOKIE}=${txCookie}`));
    expect(response.status).toBe(503); expect(await response.text()).not.toMatch(/RAW_|Authorization|CLIENT_SECRET/);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('does not accept legacy Manus cookies or authorization headers in OIDC mode', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const response = await me(req('/api/identity/me', `${MANUS_SESSION_COOKIE}=RAW_LEGACY_SESSION`));
    expect(response.status).toBe(401); expect(fetcher).not.toHaveBeenCalled();
    const bearer = await me(new NextRequest('https://hon.example/api/identity/me', { headers: { authorization: 'Bearer RAW_TOKEN' } }));
    expect(bearer.status).toBe(401); expect(await bearer.text()).not.toContain('RAW_TOKEN');
  });
  it.each(['HON_AUTH_MODE', 'HON_SESSION_JWT_SECRET', 'HON_OIDC_TOKEN_ENDPOINT', 'HON_OIDC_CLIENT_ID'])('fails closed with missing %s, and readiness never calls a provider', async (key) => {
    delete process.env[key]; const fetcher = vi.spyOn(globalThis, 'fetch');
    expect((await login(req('/auth/login'))).status).toBe(503);
    expect((await callback(req('/auth/callback?code=RAW_CODE&state=RAW_STATE'))).status).toBe(503);
    const result = await readiness(); expect(result.status).toBe(503); expect(await result.text()).not.toMatch(/RAW_|https:|TEST_ONLY/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects invalid mode even with configured development variables', async () => {
    configureDev(); process.env.HON_AUTH_MODE = 'AUTO';
    expect((await login(req('/auth/login'))).status).toBe(503); expect((await me(req('/api/identity/me'))).status).toBe(503);
  });
});

describe('explicit Manus development adapter compatibility', () => {
  it('keeps portal/RPC flow while issuing a separate normalized HON session at callback', async () => {
    configureDev(); const { authorization, txCookie } = await startLogin();
    expect(authorization.origin).toBe('https://manus-dev-portal.example'); expect(authorization.pathname).toBe('/app-auth');
    const state = authorization.searchParams.get('state')!;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).endsWith('/ExchangeToken') ? Response.json({ accessToken: 'RAW_MANUS_TOKEN' }) : Response.json({ openId: identity.externalSubject, name: identity.displayName, email: identity.email }));
    const response = await callback(req(`/auth/callback?code=DEV_CODE&state=${encodeURIComponent(state)}`, `${AUTH_TRANSACTION_COOKIE}=${txCookie}`));
    expect(response.status).toBe(307); expect(verifySession(response.cookies.get(HON_SESSION_COOKIE)!.value, sessionConfig())).toEqual(identity);
    expect(response.headers.get('location')).toBe('https://hon.example/auth/continue');
    expect(response.cookies.get(MANUS_SESSION_COOKIE)?.value).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(2); expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('https://manus-dev-api.example'))).toBe(true);
  });
  it('converts a still-valid legacy web development cookie but never falls back on an invalid HON session', async () => {
    configureDev(); const legacy = issueManusSession(identity, manusConfig());
    const response = await me(req('/api/identity/me', `${MANUS_SESSION_COOKIE}=${legacy}`));
    expect(response.status).toBe(200); expect(verifySession(response.cookies.get(HON_SESSION_COOKIE)!.value, sessionConfig())).toEqual(identity);
    const invalid = await me(req('/api/identity/me', `${HON_SESSION_COOKIE}=RAW_FORGED_HON; ${MANUS_SESSION_COOKIE}=${legacy}`));
    expect(invalid.status).toBe(401); expect(invalid.cookies.get(HON_SESSION_COOKIE)).toBeUndefined();
  });
  it('readiness is pure and preserves public preview origin without OIDC network traffic', async () => {
    configureDev(); delete process.env.HON_PUBLIC_ORIGIN;
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const status = await readiness(); expect(status.status).toBe(200); expect(await status.json()).toEqual({ data: { mode: 'MANUS_DEVELOPMENT', ready: true, code: 'AUTH_READY' } });
    const response = await login(new NextRequest('http://localhost:3000/auth/login', { headers: { 'x-forwarded-host': '3000-preview.example', 'x-forwarded-proto': 'https' } }));
    expect(new URL(response.headers.get('location')!).searchParams.get('redirectUri')).toBe('https://3000-preview.example/auth/callback');
    expect(response.headers.get('set-cookie')).toMatch(/Secure/); expect(response.headers.get('set-cookie')).toMatch(/SameSite=none/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('web identity rejects expired and cross-app HON sessions in either mode', async () => {
    for (const mode of ['OIDC', 'MANUS_DEVELOPMENT']) {
      if (mode === 'MANUS_DEVELOPMENT') configureDev();
      const config = sessionConfig();
      for (const token of [issueSession(identity, { ...config, audience: 'other-app' }), issueSession(identity, { ...config, secret: 'attacker-key' }), issueSession(identity, config, Math.floor(Date.now() / 1000) - 43_201)]) {
        expect((await me(req('/api/identity/me', `${HON_SESSION_COOKIE}=${token}`))).status).toBe(401);
      }
    }
  });
});

describe('sign-out route', () => {
  const post = (headers: Record<string, string>) => logout(new NextRequest('https://hon.example/auth/logout', { method: 'POST', headers: { host: 'hon.example', ...headers } }));
  it('expires the HON and Manus session cookies and sends the browser to a fixed home path', async () => {
    const session = issueSession(identity, sessionConfig());
    const response = await post({ origin: 'https://hon.example', cookie: `${HON_SESSION_COOKIE}=${session}` });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
    expect(response.headers.get('cache-control')).toBe('no-store');
    for (const name of [HON_SESSION_COOKIE, MANUS_SESSION_COOKIE]) {
      const cookie = response.cookies.get(name)!;
      expect(cookie.value).toBe(''); expect(cookie.maxAge).toBe(0); expect(cookie.path).toBe('/'); expect(cookie.secure).toBe(true); expect(cookie.httpOnly).toBe(true);
    }
    expect(response.cookies.get(AUTH_TRANSACTION_COOKIE)!.path).toBe('/auth');
  });
  it('refuses cross-site or origin-less requests and never clears cookies for them', async () => {
    for (const headers of [{ origin: 'https://evil.example' }, {}, { origin: 'null' }, { origin: 'http://hon.example' }]) {
      const response = await post(headers);
      expect(response.status).toBe(403);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });
  it('accepts a null or missing Origin only when Fetch Metadata says same-origin (no-referrer pages)', async () => {
    for (const headers of [{ origin: 'null', 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'same-origin' }]) {
      const response = await post(headers);
      expect(response.status).toBe(303);
      expect(response.cookies.get(HON_SESSION_COOKIE)!.maxAge).toBe(0);
    }
    for (const site of ['cross-site', 'same-site', 'none']) {
      for (const headers of [{ origin: 'null', 'sec-fetch-site': site }, { 'sec-fetch-site': site }]) {
        const response = await post(headers);
        expect(response.status).toBe(403);
        expect(response.headers.get('set-cookie')).toBeNull();
      }
    }
    const mismatched = await post({ origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' });
    expect(mismatched.status).toBe(403);
  });
  it('trusts the configured OIDC origin, not forwarding headers', async () => {
    const response = await post({ origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' });
    expect(response.status).toBe(403);
  });
  it('also ends the sign-in provider session so the next sign-in can choose another account', async () => {
    process.env.HON_OIDC_END_SESSION_ENDPOINT = 'https://provider.example/v2/logout';
    const response = await post({ origin: 'https://hon.example', 'x-forwarded-host': 'evil.example' });
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://provider.example/v2/logout');
    expect(location.searchParams.get('client_id')).toBe(testEnv.HON_OIDC_CLIENT_ID);
    expect(location.searchParams.get('returnTo')).toBe('https://hon.example/');
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe('https://hon.example/');
    expect(response.cookies.get(HON_SESSION_COOKIE)!.maxAge).toBe(0);
    expect(response.cookies.get(MANUS_SESSION_COOKIE)!.maxAge).toBe(0);
  });
  it('never redirects to the provider for a rejected sign-out', async () => {
    process.env.HON_OIDC_END_SESSION_ENDPOINT = 'https://provider.example/v2/logout';
    const response = await post({ origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(response.headers.get('location')).toBeNull();
  });
  it('still clears HON cookies and goes home when the provider logout setting is invalid', async () => {
    process.env.HON_OIDC_END_SESSION_ENDPOINT = 'http://provider.example/v2/logout';
    const response = await post({ origin: 'https://hon.example' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
    expect(response.cookies.get(HON_SESSION_COOKIE)!.maxAge).toBe(0);
  });
  it('still signs out when sign-in configuration is broken', async () => {
    delete process.env.HON_OIDC_CLIENT_ID;
    const response = await post({ origin: 'https://hon.example' });
    expect(response.status).toBe(303);
    expect(response.cookies.get(HON_SESSION_COOKIE)!.maxAge).toBe(0);
  });
});
