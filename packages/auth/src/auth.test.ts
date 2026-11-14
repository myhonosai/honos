import { beforeAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTVerifyGetKey } from 'jose';
import { AuthConfigurationError, AuthValidationError, authMode, authReadiness, oidcConfig, manusConfig, sessionConfig, type Environment } from './config.js';
import { issueSession, verifySession, issueManusSession, verifyManusSession, cookieValue, SESSION_SECONDS } from './session.js';
import { callbackParameters, createTransaction, issueTransaction, pkceChallenge, publicOrigin, verifyTransaction } from './transaction.js';
import { exchangeOidcCode, oidcAuthorizationUrl, oidcLogoutUrl, verifyIdToken } from './oidc.js';
import { exchangeManusCode, manusAuthorizationUrl, manusState } from './manus.js';

const secret = 'TEST_ONLY_HON_KEY_123456789012345678901234';
const env: Environment = { NODE_ENV: 'production', HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: secret, HON_SESSION_AUDIENCE: 'hon-test-app', HON_PUBLIC_ORIGIN: 'https://hon.example', HON_OIDC_ISSUER: 'https://issuer.example/tenant', HON_OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/authorize', HON_OIDC_TOKEN_ENDPOINT: 'https://issuer.example/token', HON_OIDC_JWKS_URI: 'https://issuer.example/jwks', HON_OIDC_CLIENT_ID: 'hon-client', HON_OIDC_SCOPES: 'openid profile email', HON_OIDC_REDIRECT_URI: 'https://hon.example/auth/callback', HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'none' };
const devEnv: Environment = { NODE_ENV: 'development', HON_SESSION_JWT_SECRET: secret, MANUS_PROJECT_ID: 'dev-app', MANUS_JWT_SECRET: 'TEST_ONLY_MANUS_KEY_12345678901234567890', MANUS_OAUTH_API_URL: 'https://dev-api.example', MANUS_OAUTH_PORTAL_URL: 'https://dev-portal.example' };
const config = oidcConfig(env);
const identity = { externalSubject: 'account-123', displayName: 'Test Account', email: 'test@example.invalid' };
const now = Math.floor(Date.now() / 1000);
const claims = { ...identity, iss: config.mode, aud: config.audience, iat: now, exp: now + SESSION_SECONDS };
const signed = (payload: Record<string, unknown>, key = secret) => jwt.sign(payload, key, { algorithm: 'HS256' });

describe('protected runtime config', () => {
  it('requires no Manus variables in OIDC and performs no network readiness request', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network permitted'));
    expect(authReadiness(env)).toEqual({ mode: 'OIDC', ready: true, code: 'AUTH_READY' });
    expect(config.mode).toBe('OIDC'); expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
  });
  it.each(['', 'oidc', 'AUTO', 'MANUS', ' OIDC'])('rejects explicit invalid mode %s even with legacy variables', (mode) => {
    expect(() => authMode({ ...devEnv, HON_AUTH_MODE: mode })).toThrow(AuthConfigurationError);
  });
  it('only implicitly selects Manus with complete variables outside production', () => {
    expect(authMode(devEnv)).toBe('MANUS_DEVELOPMENT');
    expect(() => authMode({ ...devEnv, NODE_ENV: 'production' })).toThrow();
    expect(() => authMode({ ...devEnv, MANUS_JWT_SECRET: undefined })).toThrow();
    expect(() => authMode({ NODE_ENV: 'development' })).toThrow();
    expect(authMode({ ...devEnv, NODE_ENV: 'production', HON_AUTH_MODE: 'MANUS_DEVELOPMENT' })).toBe('MANUS_DEVELOPMENT');
  });
  it.each(['HON_SESSION_JWT_SECRET', 'HON_SESSION_AUDIENCE', 'HON_PUBLIC_ORIGIN', 'HON_OIDC_ISSUER', 'HON_OIDC_AUTHORIZATION_ENDPOINT', 'HON_OIDC_TOKEN_ENDPOINT', 'HON_OIDC_JWKS_URI', 'HON_OIDC_CLIENT_ID', 'HON_OIDC_SCOPES', 'HON_OIDC_REDIRECT_URI', 'HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD'])('fails closed when %s is missing', (field) => {
    expect(() => oidcConfig({ ...env, [field]: undefined })).toThrow(AuthConfigurationError);
    expect(authReadiness({ ...env, [field]: undefined }).ready).toBe(false);
  });
  it.each([
    { HON_SESSION_JWT_SECRET: 'short' }, { HON_SESSION_AUDIENCE: ' ' }, { HON_OIDC_ISSUER: 'http://issuer.example' },
    { HON_OIDC_TOKEN_ENDPOINT: 'https://user:password@issuer.example/token' }, { HON_OIDC_JWKS_URI: 'https://issuer.example/jwks#bad' },
    { HON_PUBLIC_ORIGIN: 'https://hon.example/other' }, { HON_OIDC_REDIRECT_URI: 'https://attacker.example/auth/callback' },
    { HON_OIDC_REDIRECT_URI: 'https://hon.example/auth/callback?redirect=evil' }, { HON_OIDC_SCOPES: 'profile email' },
    { HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'unknown' }, { HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'client_secret_basic' },
    { HON_OIDC_CLIENT_SECRET: 'browser-must-not-see' }, { HON_OIDC_ID_TOKEN_ALGORITHMS: 'HS256' }, { HON_OIDC_ID_TOKEN_ALGORITHMS: 'none' },
  ])('rejects unsafe config patch %j', (patch) => expect(() => oidcConfig({ ...env, ...patch })).toThrow(AuthConfigurationError));
  it('uses a separate HON-owned key even in development', () => {
    expect(() => sessionConfig({ ...devEnv, HON_SESSION_JWT_SECRET: undefined })).toThrow();
    expect(() => sessionConfig({ ...devEnv, HON_SESSION_JWT_SECRET: devEnv.MANUS_JWT_SECRET })).toThrow();
  });
  it('never includes a secret value in readiness or error messages', () => {
    const bad = { ...env, HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'bad-secret-mode', HON_OIDC_CLIENT_SECRET: 'SENSITIVE_SECRET' };
    expect(JSON.stringify(authReadiness(bad))).not.toContain('SENSITIVE_SECRET');
    expect(() => oidcConfig(bad)).toThrow('HON authentication configuration is incomplete or invalid.');
  });
  it('does not probe OIDC or Manus in development readiness', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    expect(authReadiness(devEnv).ready).toBe(true); expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
  });
});

describe('one strictly normalized HON session', () => {
  it('round trips only identity/mode/audience/time, never upstream tokens or authority', () => {
    const token = issueSession(identity, config, now);
    expect(verifySession(token, config, now)).toEqual(identity);
    expect(Object.keys(jwt.decode(token)!)).toEqual(['externalSubject', 'displayName', 'email', 'iss', 'aud', 'iat', 'exp']);
    expect(verifySession(issueSession({ externalSubject: 'only-subject' }, config), config)).toEqual({ externalSubject: 'only-subject' });
  });
  it.each([
    { aud: 'other-app' }, { aud: [config.audience, 'other-app'] }, { iss: 'MANUS_DEVELOPMENT' }, { iss: 'https://issuer.example/tenant' },
    { exp: now }, { exp: now - 1 }, { exp: undefined }, { iat: undefined }, { iat: now + 1 }, { exp: now + SESSION_SECONDS + 1 },
    { iat: now + 0.1 }, { exp: 'tomorrow' }, { externalSubject: '' }, { externalSubject: ' padded' }, { displayName: 'padded ' },
    { email: 123 }, { externalSubject: undefined }, { roles: ['OWNER'] }, { access_token: 'secret-upstream-token' }, { sub: 'unapproved-subject' },
  ])('rejects invalid session claim patch %j', (patch) => {
    // jsonwebtoken rejects structurally invalid exp itself; either signer or verifier must refuse.
    expect(() => verifySession(signed({ ...claims, ...patch }), config, now)).toThrow();
  });
  it('rejects forged, tampered, unsigned, wrong-key, expired and wrong-header sessions', () => {
    const token = issueSession(identity, config, now);
    expect(() => verifySession(signed(claims, 'attacker-key'), config)).toThrow(AuthValidationError);
    expect(() => verifySession(token.replace(/.$/, token.endsWith('a') ? 'b' : 'a'), config)).toThrow();
    expect(() => verifySession(jwt.sign(claims, '', { algorithm: 'none' }), config)).toThrow();
    expect(() => verifySession(jwt.sign(claims, secret, { algorithm: 'HS384' }), config)).toThrow();
    expect(() => verifySession(jwt.sign(claims, secret, { header: { alg: 'HS256', kid: 'untrusted' } }), config)).toThrow();
    expect(() => verifySession(token, config, now + SESSION_SECONDS)).toThrow();
    expect(() => verifySession(token, { ...config, audience: 'other-app' })).toThrow();
  });
  it('rejects malformed or ambiguous cookies without decoding errors leaking values', () => {
    expect(cookieValue('other=1; hon_session=abc', 'hon_session')).toBe('abc');
    expect(() => cookieValue('hon_session=one; hon_session=two', 'hon_session')).toThrow(AuthValidationError);
    expect(() => cookieValue('hon_session=%XX', 'hon_session')).toThrow(AuthValidationError);
  });
  it('keeps development profiles compatible but never accepts a Manus JWT as a HON JWT', () => {
    const dev = manusConfig(devEnv); const legacy = issueManusSession(identity, dev);
    expect(verifyManusSession(legacy, dev)).toEqual(identity);
    expect(() => verifySession(legacy, dev)).toThrow();
    expect(verifySession(issueSession(verifyManusSession(legacy, dev), dev), dev)).toEqual(identity);
    expect(() => verifyManusSession(legacy, { ...dev, projectId: 'other-app' })).toThrow();
    expect(() => verifyManusSession(jwt.sign({ appId: dev.projectId, openId: 'a', exp: now - 1 }, dev.jwtSecret), dev)).toThrow();
    expect(() => verifySession(issueSession(identity, dev), config)).toThrow();
  });
});

describe('CSRF/state/PKCE and origin binding', () => {
  const tx = createTransaction(config.redirectUri);
  it('binds opaque state, verifier, S256 challenge, redirect and ten minute expiration', () => {
    expect(tx.verifier).toHaveLength(43); expect(tx.challenge).toBe(pkceChallenge(tx.verifier));
    const token = issueTransaction(tx, config, now);
    expect(verifyTransaction(token, tx.state, config.redirectUri, config, now)).toEqual(tx);
    expect(() => verifyTransaction(token, 'other-state', config.redirectUri, config)).toThrow();
    expect(() => verifyTransaction(undefined, tx.state, config.redirectUri, config)).toThrow();
    expect(() => verifyTransaction(token, tx.state, 'https://attacker.example/auth/callback', config)).toThrow();
    expect(() => verifyTransaction(token, tx.state, config.redirectUri, config, now + 600)).toThrow();
    expect(() => verifyTransaction(token, tx.state, config.redirectUri, { ...config, audience: 'other-app' })).toThrow();
    expect(() => verifySession(token, config)).toThrow();
    expect(() => verifyTransaction(issueSession(identity, config), tx.state, config.redirectUri, config)).toThrow();
  });
  it('rejects changed PKCE or nonce bytes and unsigned/forged browser transactions', () => {
    expect(() => verifyTransaction(issueTransaction({ ...tx, verifier: createTransaction(config.redirectUri).verifier }, config), tx.state, config.redirectUri, config)).toThrow();
    expect(() => verifyTransaction(issueTransaction({ ...tx, challenge: 'X'.repeat(43) }, config), tx.state, config.redirectUri, config)).toThrow();
    expect(() => verifyTransaction(issueTransaction({ ...tx, nonce: '' }, config), tx.state, config.redirectUri, config)).toThrow();
    expect(() => verifyTransaction(issueTransaction(tx, { ...config, secret: 'attacker-key' }), tx.state, config.redirectUri, config)).toThrow();
  });
  it('uses only protected endpoints, client/scopes/redirect with no client secret in authorization URLs', () => {
    const confidential = oidcConfig({ ...env, HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'client_secret_basic', HON_OIDC_CLIENT_SECRET: 'NEVER_BROWSER_SECRET' });
    const url = oidcAuthorizationUrl(confidential, tx);
    expect(url.origin).toBe('https://issuer.example');
    expect(url.searchParams.get('client_id')).toBe(config.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('state')).toBe(tx.state); expect(url.searchParams.get('nonce')).toBe(tx.nonce);
    expect(url.searchParams.get('code_challenge')).toBe(tx.challenge); expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.href).not.toContain('NEVER_BROWSER_SECRET'); expect(url.href).not.toContain(tx.verifier);
  });
  it('builds the provider logout URL only from protected config, returning to the HON home page', () => {
    expect(config.endSessionEndpoint).toBeUndefined();
    expect(oidcLogoutUrl(config)).toBeNull();
    const withLogout = oidcConfig({ ...env, HON_OIDC_END_SESSION_ENDPOINT: 'https://issuer.example/v2/logout?client_id=evil&returnTo=https://evil.example' });
    const url = oidcLogoutUrl(withLogout)!;
    expect(url.origin + url.pathname).toBe('https://issuer.example/v2/logout');
    expect(url.searchParams.getAll('client_id')).toEqual([config.clientId]);
    expect(url.searchParams.getAll('post_logout_redirect_uri')).toEqual(['https://hon.example/']);
    expect(url.searchParams.getAll('returnTo')).toEqual(['https://hon.example/']);
    for (const bad of ['http://issuer.example/logout', 'https://user:pw@issuer.example/logout', 'https://issuer.example/logout#x', ' https://issuer.example/logout']) {
      expect(() => oidcConfig({ ...env, HON_OIDC_END_SESSION_ENDPOINT: bad })).toThrow(AuthConfigurationError);
    }
    // An empty Render dashboard slot is treated as not set, so sign-in keeps working.
    expect(oidcLogoutUrl(oidcConfig({ ...env, HON_OIDC_END_SESSION_ENDPOINT: '' }))).toBeNull();
  });
  it('preserves safe HTTPS preview origin and refuses forwarded host/protocol injection', () => {
    expect(publicOrigin(new Headers({ 'x-forwarded-host': '3000-preview.example', 'x-forwarded-proto': 'https' }), {})).toBe('https://3000-preview.example');
    expect(publicOrigin(new Headers({ host: 'localhost:3000', 'x-forwarded-proto': 'http' }), {})).toBe('http://localhost:3000');
    expect(publicOrigin(new Headers({ host: 'attacker.example' }), env)).toBe('https://hon.example');
    const hostileHeaders: Record<string, string>[] = [{ host: 'evil.example, hon.example' }, { host: 'user@evil.example' }, { host: 'hon.example/path' }, { host: 'hon.example', 'x-forwarded-proto': 'javascript' }, { host: 'hon.example', 'x-forwarded-proto': 'http' }];
    for (const headers of hostileHeaders) expect(() => publicOrigin(new Headers(headers), {})).toThrow();
  });
  it.each(['?code=x&code=y&state=s', '?code=x&state=s&state=t', '?code=x', '?state=s', '?code=x&state=s&error=SECRET_PROVIDER_ERROR'])('rejects invalid callback query %s', (query) => expect(() => callbackParameters(new URL(`https://hon.example/auth/callback${query}`))).toThrow());
});

describe('verified generic OIDC and private token exchange', () => {
  let privateKey: CryptoKey; let key: JWTVerifyGetKey;
  const tx = createTransaction(config.redirectUri);
  const idClaims = { iss: config.issuer, aud: config.clientId, sub: 'provider-account', name: ' Test Account ', email: identity.email, nonce: tx.nonce, iat: now, exp: now + 300 };
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256'); privateKey = pair.privateKey;
    key = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }] });
  });
  const idToken = (patch: Record<string, unknown> = {}) => new SignJWT({ ...idClaims, ...patch }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
  it('validates a JWKS-signed id_token and returns only an issuer-namespaced profile', async () => {
    expect(await verifyIdToken(await idToken(), config, tx.nonce, key)).toEqual({ ...identity, externalSubject: `oidc:${encodeURIComponent(config.issuer)}:provider-account` });
  });
  it.each([
    { iss: 'https://other-issuer.example' }, { aud: 'other-client' }, { nonce: 'other-nonce' }, { nonce: undefined }, { sub: undefined },
    { sub: '' }, { sub: ' padded' }, { exp: now - 1 }, { exp: undefined }, { iat: undefined }, { iat: now + 120 }, { iat: now - 601 },
    { aud: [config.clientId, 'other-client'] }, { aud: [config.clientId, 'other-client'], azp: 'other-client' }, { azp: 'other-client' },
  ])('rejects id_token claim patch %j', async (patch) => await expect(verifyIdToken(await idToken(patch), config, tx.nonce, key)).rejects.toThrow(AuthValidationError));
  it('accepts multiple audiences only with matching authorized party', async () => {
    expect((await verifyIdToken(await idToken({ aud: [config.clientId, 'other-client'], azp: config.clientId }), config, tx.nonce, key)).externalSubject).toContain('provider-account');
  });
  it('rejects forged provider signature and symmetric algorithm confusion', async () => {
    const attacker = await generateKeyPair('RS256');
    const forged = await new SignJWT(idClaims).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(attacker.privateKey);
    await expect(verifyIdToken(forged, config, tx.nonce, key)).rejects.toThrow(AuthValidationError);
    await expect(verifyIdToken(jwt.sign(idClaims, 'attacker-key'), config, tx.nonce, key)).rejects.toThrow(AuthValidationError);
  });
  it('exchanges the code only server-side with its bound PKCE verifier, discarding raw upstream tokens', async () => {
    const token = await idToken();
    const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
      expect(_url).toBe(config.tokenEndpoint);
      const form = new URLSearchParams(options?.body as string);
      expect(form.get('code_verifier')).toBe(tx.verifier); expect(form.get('redirect_uri')).toBe(config.redirectUri);
      expect(form.get('grant_type')).toBe('authorization_code'); expect(form.get('client_id')).toBe(config.clientId);
      expect(options?.redirect).toBe('error');
      return Response.json({ id_token: token, access_token: 'RAW_ACCESS_TOKEN', refresh_token: 'RAW_REFRESH_TOKEN' });
    });
    const result = await exchangeOidcCode('CODE', tx, config, fetcher as typeof fetch, key);
    expect(JSON.stringify(result)).not.toMatch(/RAW_ACCESS_TOKEN|RAW_REFRESH_TOKEN/); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['client_secret_basic', 'client_secret_post'])('keeps %s credentials inside the server token exchange', async (method) => {
    const confidential = oidcConfig({ ...env, HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: method, HON_OIDC_CLIENT_SECRET: 'PRIVATE_CLIENT_SECRET' });
    const token = await idToken();
    const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
      const form = new URLSearchParams(options?.body as string); const headers = options?.headers as Record<string, string>;
      if (method === 'client_secret_basic') { expect(headers.Authorization).toMatch(/^Basic /); expect(form.has('client_secret')).toBe(false); }
      else { expect(form.get('client_secret')).toBe('PRIVATE_CLIENT_SECRET'); expect(headers.Authorization).toBeUndefined(); }
      return Response.json({ id_token: token });
    });
    await exchangeOidcCode('CODE', tx, confidential, fetcher as typeof fetch, key);
  });
  it('never leaks authorization headers, raw tokens, bodies or provider errors', async () => {
    for (const fetcher of [vi.fn(async () => { throw new Error('Authorization: Bearer RAW_TOKEN PRIVATE_SECRET'); }), vi.fn(async () => new Response('RAW_PROVIDER_BODY PRIVATE_SECRET', { status: 500 })), vi.fn(async () => Response.json({ access_token: 'RAW_TOKEN' })), vi.fn(async () => Response.json({ id_token: 'RAW_BAD_JWT' }))]) {
      try { await exchangeOidcCode('CODE', tx, config, fetcher as typeof fetch, key); throw new Error('Expected rejection'); }
      catch (error) { expect(error).toBeInstanceOf(AuthValidationError); expect(String(error)).not.toMatch(/RAW_|PRIVATE_SECRET|Authorization/); }
    }
  });
  it('preserves Manus development login and its two RPC calls, without OIDC calls', async () => {
    const dev = manusConfig(devEnv); const auth = manusAuthorizationUrl(dev, tx);
    expect(auth.pathname).toBe('/app-auth'); expect(auth.searchParams.get('appId')).toBe(dev.projectId);
    expect(manusState(auth.searchParams.get('state')!, tx.redirectUri)).toBe(tx.state);
    expect(() => manusState(auth.searchParams.get('state')!, 'https://other.example/auth/callback')).toThrow();
    const fetcher = vi.fn(async (url: unknown) => String(url).endsWith('/ExchangeToken') ? Response.json({ accessToken: 'DEV_ACCESS_TOKEN' }) : Response.json({ openId: identity.externalSubject, name: identity.displayName, email: identity.email }));
    expect(await exchangeManusCode('CODE', tx, dev, fetcher as typeof fetch)).toEqual(identity);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(dev.apiUrl))).toBe(true);
  });
});
