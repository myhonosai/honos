// node --test scripts/testenv/testenv.test.mjs  (after `pnpm prepare:workspace`)
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { oidcConfig, verifyIdToken } from '../../packages/auth/dist/index.js';
import { honExternalSubject, TEST_IDENTITIES } from './identities.mjs';
import { createTestIdentityProvider } from './test-identity-provider.mjs';
import { applicationEnvironment, refuseUnsafeInvocation, stateDirectory, TESTENV } from './testenv.mjs';

const requireFromAuth = createRequire(new URL('../../packages/auth/package.json', import.meta.url));
const { createLocalJWKSet } = requireFromAuth(requireFromAuth.resolve('jose'));
const ORIGIN = 'https://localhost:3443';
const ISSUER = `${ORIGIN}/__test-idp`;
const REDIRECT = `${ORIGIN}/auth/callback`;
const ACCESS = 'correct-horse-battery-staple';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

async function harness() {
  let clock = Date.now();
  const idp = await createTestIdentityProvider({ issuer: ISSUER, clientId: 'client', redirectUri: REDIRECT, accessCode: ACCESS, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'k1', now: () => clock });
  const server = createServer(idp.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const verifier = randomBytes(32).toString('base64url');
  const params = { response_type: 'code', client_id: 'client', redirect_uri: REDIRECT, scope: 'openid profile email', state: 's'.repeat(43), nonce: 'n'.repeat(43), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' };
  const post = (path, form, headers = { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' }) => fetch(`${base}/__test-idp/${path}`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form).toString() });
  const authorize = (extra = {}, headers) => post('authorize', { ...params, identity: 'hq-owner', access_code: ACCESS, ...extra }, headers);
  const codeFrom = (response) => new URL(response.headers.get('location')).searchParams.get('code');
  const token = (code, extra = {}) => post('token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: 'client', code_verifier: verifier, ...extra }, {});
  return { base, params, authorize, codeFrom, token, advance: (ms) => { clock += ms; }, close: () => server.close() };
}

test('a real HON OIDC verifier accepts the test provider ID token and derives the stable subject', async () => {
  const h = await harness();
  try {
    const consent = await h.authorize();
    assert.equal(consent.status, 303);
    const location = new URL(consent.headers.get('location'));
    assert.equal(location.origin + location.pathname, REDIRECT);
    assert.equal(location.searchParams.get('state'), h.params.state);
    assert.equal(location.searchParams.get('iss'), ISSUER);
    const response = await h.token(location.searchParams.get('code'));
    assert.equal(response.status, 200);
    const { id_token: idToken } = await response.json();
    const jwks = await (await fetch(`${h.base}/__test-idp/jwks`)).json();
    assert.equal(jwks.keys.length, 1);
    assert.equal(jwks.keys[0].d, undefined, 'JWKS must never expose private key material');
    const config = oidcConfig({ HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: 'x'.repeat(48), HON_SESSION_AUDIENCE: 'aud', HON_PUBLIC_ORIGIN: ORIGIN, HON_OIDC_ISSUER: ISSUER, HON_OIDC_AUTHORIZATION_ENDPOINT: `${ISSUER}/authorize`, HON_OIDC_TOKEN_ENDPOINT: `${ISSUER}/token`, HON_OIDC_JWKS_URI: `${ISSUER}/jwks`, HON_OIDC_CLIENT_ID: 'client', HON_OIDC_SCOPES: 'openid profile email', HON_OIDC_REDIRECT_URI: REDIRECT, HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'none' });
    const identity = await verifyIdToken(idToken, config, h.params.nonce, createLocalJWKSet(jwks));
    const hq = TEST_IDENTITIES.find((i) => i.key === 'hq-owner');
    assert.equal(identity.externalSubject, honExternalSubject(ISSUER, hq.sub));
    assert.equal(identity.email, hq.email);
    assert.equal(identity.emailVerified, true);
  } finally { h.close(); }
});

test('codes are single use, PKCE-bound, redirect-bound and expire', async () => {
  const h = await harness();
  try {
    const code = h.codeFrom(await h.authorize());
    assert.equal((await h.token(code, { code_verifier: randomBytes(32).toString('base64url') })).status, 400);
    assert.equal((await h.token(code)).status, 400, 'a code is burned by any attempt');
    const second = h.codeFrom(await h.authorize());
    assert.equal((await h.token(second, { redirect_uri: `${ORIGIN}/elsewhere` })).status, 400);
    const third = h.codeFrom(await h.authorize());
    assert.equal((await h.token(third, { client_secret: 'x' })).status, 400);
    const late = h.codeFrom(await h.authorize());
    h.advance(61_000);
    assert.equal((await h.token(late)).status, 400);
  } finally { h.close(); }
});

test('sign-in refuses wrong access codes, unknown identities, foreign clients, cross-site posts and repeated guessing', async () => {
  const h = await harness();
  try {
    assert.equal((await h.authorize({ access_code: 'wrong' })).status, 401);
    assert.equal((await h.authorize({ identity: 'root' })).status, 401);
    assert.equal((await h.authorize({ client_id: 'other' })).status, 400);
    assert.equal((await h.authorize({ redirect_uri: 'https://evil.example/cb' })).status, 400);
    assert.equal((await h.authorize({ code_challenge_method: 'plain' })).status, 400);
    assert.equal((await h.authorize({}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await h.authorize({}, { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const get = await fetch(`${h.base}/__test-idp/authorize?${new URLSearchParams({ ...h.params, redirect_uri: 'https://evil.example/cb' })}`, { redirect: 'manual' });
    assert.equal(get.status, 400, 'an invalid request is never redirected');
    for (let i = 0; i < 10; i += 1) await h.authorize({ access_code: `wrong-${i}` });
    const locked = await h.authorize();
    assert.equal(locked.status, 401, 'correct code is refused while throttled');
    assert.match(await locked.text(), /Too many incorrect access codes/);
    h.advance(61_000);
    assert.equal((await h.authorize()).status, 303);
  } finally { h.close(); }
});

test('launcher refuses inherited credentials, dotenv files and in-repository state', () => {
  const root = mkdtempSync(join(tmpdir(), 'hon-testenv-'));
  assert.deepEqual(refuseUnsafeInvocation({}, root), []);
  assert.equal(refuseUnsafeInvocation({ DATABASE_URL: 'postgresql://x', OPENROUTER_API_KEY: 'k', STRIPE_TEST_SECRET_KEY: 'k' }, root).length, 3);
  writeFileSync(join(root, '.env.local'), 'X=1');
  writeFileSync(join(root, '.env.example'), 'X=1');
  assert.equal(refuseUnsafeInvocation({}, root).length, 1);
  assert.throws(() => stateDirectory({ HON_TESTENV_HOME: join(process.cwd(), 'state') }));
});

test('application processes get loopback-only, provider-free, preview-labelled configuration', () => {
  const env = applicationEnvironment({ sessionSecret: 's'.repeat(64), sessionAudience: 'hon-testenv-x' }, { runtime: 'postgresql://hon_runtime:p@127.0.0.1:55440/hon_testenv' }, { ca: '/tmp/ca.pem' });
  for (const child of [env.api, env.web]) {
    assert.equal(child.HON_DEPLOYMENT_ENVIRONMENT, 'preview');
    assert.equal(child.HON_AUTH_MODE, 'OIDC');
    for (const key of Object.keys(child)) assert.doesNotMatch(key, /OPENROUTER|STRIPE|ZERNIO|OPENAI|ANTHROPIC|TWILIO|^DATABASE_URL$|MANUS/);
  }
  assert.equal(env.api.HON_API_LISTEN_HOST, '127.0.0.1');
  assert.equal(env.web.DATABASE_URL, undefined);
  assert.equal(env.web.HON_RUNTIME_DATABASE_URL, undefined, 'the web process never receives a database credential');
  assert.equal(env.web.HON_OIDC_REDIRECT_URI, `${TESTENV.ORIGIN}/auth/callback`);
  assert.equal(env.web.HON_OIDC_CLIENT_SECRET, undefined);
});
