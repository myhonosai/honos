// Minimal OpenID Connect provider for the PRIVATE owner test environment only.
//
// It lets HON's real, unchanged OIDC login (authorization code + PKCE S256 + nonce + signed ID
// token verified against JWKS) run end to end without any external identity account. It is not a
// general identity provider and must never be used for real people:
//   - fixed test identities only (identities.mjs), selected after entering a private access code;
//   - one registered public client and one exact redirect URI;
//   - authorization codes are random, single use, bound to client/redirect/PKCE/nonce, 60 s TTL;
//   - no IdP browser session: every sign-in asks again, so switching identity is explicit;
//   - no tokens other than the ID token; no refresh tokens; no user info endpoint.
import { createHash, createPrivateKey, createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { TEST_IDENTITIES, identityByKey } from './identities.mjs';

const requireFromAuth = createRequire(new URL('../../packages/auth/package.json', import.meta.url));
const { SignJWT, exportJWK } = requireFromAuth(requireFromAuth.resolve('jose'));

const CODE_SECONDS = 60;
const ID_TOKEN_SECONDS = 300;
const MAX_BODY = 8192;
const MAX_FAILURES_PER_MINUTE = 10;

function constantEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function send(res, status, type, body, extra = {}) {
  res.writeHead(status, {
    'Content-Type': type, 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    ...extra,
  });
  res.end(body);
}
// The sign-in form is checked against its Origin header; 'no-referrer' would make browsers send
// "Origin: null", so the page itself uses 'same-origin' (nothing leaks cross-site either way).
const pageHeaders = { 'Referrer-Policy': 'same-origin' };
const json = (res, status, value) => send(res, status, 'application/json', JSON.stringify(value));
async function readForm(req) {
  if (!/^application\/x-www-form-urlencoded(?:\s*;.*)?$/i.test(req.headers['content-type'] ?? '')) throw new Error('form required');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new Error('body too large'); chunks.push(chunk); }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
const single = (params, key) => (params.getAll(key).length === 1 ? params.get(key) : null);

/**
 * @param {{ issuer: string, clientId: string, redirectUri: string, accessCode: string, privateKeyPem: string, keyId: string, now?: () => number }} options
 * Returns a request handler for paths beneath new URL(issuer).pathname.
 */
export async function createTestIdentityProvider(options) {
  const { issuer, clientId, redirectUri, accessCode, privateKeyPem, keyId } = options;
  const now = options.now ?? (() => Date.now());
  if (!issuer.startsWith('https://') || issuer.endsWith('/')) throw new Error('Test issuer must be an https URL without a trailing slash.');
  if (!accessCode || accessCode.length < 16) throw new Error('A private access code of at least 16 characters is required.');
  const privateKey = createPrivateKey(privateKeyPem);
  const publicJwk = { ...(await exportJWK(createPublicKey(privateKey))), kid: keyId, alg: 'RS256', use: 'sig' };
  const base = new URL(issuer).pathname;
  const endpoints = { authorization: `${issuer}/authorize`, token: `${issuer}/token`, jwks: `${issuer}/jwks` };
  const codes = new Map();
  const failures = [];

  function throttled() {
    const cutoff = now() - 60_000;
    while (failures.length && failures[0] < cutoff) failures.shift();
    return failures.length >= MAX_FAILURES_PER_MINUTE;
  }
  function validateAuthorizationRequest(params) {
    const request = {};
    for (const key of ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method']) {
      const value = single(params, key);
      if (value === null || value.length === 0 || value.length > 512) return null;
      request[key] = value;
    }
    if (request.response_type !== 'code' || request.client_id !== clientId || request.redirect_uri !== redirectUri
      || request.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(request.code_challenge)
      || !request.scope.split(' ').includes('openid')) return null;
    const mode = params.get('response_mode');
    if (mode !== null && mode !== 'query') return null;
    return request;
  }
  function page(res, request, message) {
    const hidden = Object.entries(request).map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('');
    const choices = TEST_IDENTITIES.map((identity, index) => `
      <label class="choice"><input type="radio" name="identity" value="${escapeHtml(identity.key)}"${index === 0 ? ' checked' : ''}>
        <span><strong>${escapeHtml(identity.name)}</strong><br><small>${escapeHtml(identity.email)}</small><br><small>${escapeHtml(identity.role)}</small></span></label>`).join('');
    send(res, message ? 401 : 200, 'text/html; charset=utf-8', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HON OS test sign-in</title><style>
body{font-family:system-ui,sans-serif;margin:0;background:#f4f4f5;color:#18181b}main{max-width:560px;margin:32px auto;padding:0 16px}
.card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.1)}h1{font-size:1.4rem;margin:0 0 8px}
.warn{background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:12px;margin:16px 0;font-size:.9rem}
.err{background:#fee2e2;border:1px solid #ef4444;border-radius:8px;padding:12px;margin:16px 0}
.choice{display:flex;gap:12px;align-items:flex-start;border:1px solid #d4d4d8;border-radius:8px;padding:12px;margin:8px 0;cursor:pointer}
label.code{display:block;margin-top:16px;font-weight:600}input[type=password]{width:100%;box-sizing:border-box;padding:10px;font-size:1rem;margin-top:6px;border:1px solid #a1a1aa;border-radius:6px}
button{margin-top:16px;width:100%;padding:12px;font-size:1rem;background:#18181b;color:#fff;border:0;border-radius:8px;cursor:pointer}
</style></head><body><main><div class="card"><h1>HON OS private test environment</h1>
<p>Choose which <strong>test person</strong> to sign in as. This page is a local test identity provider, not a real account system.</p>
<div class="warn">Signing in only identifies the test person. What they can see is decided by HON OS itself: HQ access comes from the HQ owner grant, school access only from an accepted HQ invitation.</div>
${message ? `<div class="err" role="alert">${escapeHtml(message)}</div>` : ''}
<form method="post" action="${escapeHtml(endpoints.authorization)}">${hidden}<fieldset style="border:0;padding:0;margin:0"><legend><strong>Test person</strong></legend>${choices}</fieldset>
<label class="code" for="access_code">Private access code</label><input id="access_code" name="access_code" type="password" autocomplete="off" required>
<button type="submit">Sign in to HON OS</button></form></div></main></body></html>`, pageHeaders);
  }

  async function authorize(req, res) {
    if (req.method === 'GET') {
      const request = validateAuthorizationRequest(new URL(req.url, issuer).searchParams);
      // Never redirect an unvalidated request anywhere.
      if (!request) return send(res, 400, 'text/plain; charset=utf-8', 'Invalid sign-in request. Start again from HON OS.');
      return page(res, request);
    }
    if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed.', { Allow: 'GET, POST' });
    const origin = new URL(issuer).origin;
    if (req.headers.origin !== origin || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) return send(res, 403, 'text/plain; charset=utf-8', 'Cross-site sign-in refused.');
    let form;
    try { form = await readForm(req); } catch { return send(res, 400, 'text/plain; charset=utf-8', 'Invalid sign-in form.'); }
    const request = validateAuthorizationRequest(form);
    if (!request) return send(res, 400, 'text/plain; charset=utf-8', 'Invalid sign-in request. Start again from HON OS.');
    if (throttled()) return page(res, request, 'Too many incorrect access codes. Wait one minute and try again.');
    const identity = identityByKey(single(form, 'identity') ?? '');
    if (!constantEqual(single(form, 'access_code') ?? '', accessCode)) { failures.push(now()); return page(res, request, 'The private access code is incorrect.'); }
    if (!identity) return page(res, request, 'Choose a test person.');
    const code = randomBytes(32).toString('base64url');
    codes.set(code, { identity, clientId: request.client_id, redirectUri: request.redirect_uri, challenge: request.code_challenge, nonce: request.nonce, expiresAt: now() + CODE_SECONDS * 1000 });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', request.state);
    target.searchParams.set('iss', issuer);
    res.writeHead(303, { Location: target.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  }

  async function token(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'invalid_request' });
    if (req.headers.authorization) return json(res, 401, { error: 'invalid_client' });
    let form;
    try { form = await readForm(req); } catch { return json(res, 400, { error: 'invalid_request' }); }
    const code = single(form, 'code') ?? '';
    const grant = codes.get(code);
    codes.delete(code); // single use, even when the rest of the request is wrong
    if (single(form, 'grant_type') !== 'authorization_code' || !grant || grant.expiresAt < now()
      || single(form, 'client_id') !== grant.clientId || single(form, 'redirect_uri') !== grant.redirectUri || form.has('client_secret')) {
      return json(res, 400, { error: 'invalid_grant' });
    }
    const verifier = single(form, 'code_verifier') ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !constantEqual(challenge, grant.challenge)) return json(res, 400, { error: 'invalid_grant' });
    const issuedAt = Math.floor(now() / 1000);
    const idToken = await new SignJWT({ nonce: grant.nonce, name: grant.identity.name, email: grant.identity.email, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: keyId, typ: 'JWT' })
      .setIssuer(issuer).setAudience(clientId).setSubject(grant.identity.sub)
      .setIssuedAt(issuedAt).setExpirationTime(issuedAt + ID_TOKEN_SECONDS)
      .sign(privateKey);
    return json(res, 200, { id_token: idToken, token_type: 'Bearer', expires_in: ID_TOKEN_SECONDS });
  }

  function handler(req, res) {
    const path = new URL(req.url, issuer).pathname;
    for (const [key, value] of codes) if (value.expiresAt < now()) codes.delete(key);
    if (path === `${base}/authorize`) return authorize(req, res);
    if (path === `${base}/token`) return token(req, res);
    if (path === `${base}/jwks`) return json(res, 200, { keys: [publicJwk] });
    return send(res, 404, 'text/plain; charset=utf-8', 'Not found.');
  }
  return { handler, endpoints, basePath: base };
}
