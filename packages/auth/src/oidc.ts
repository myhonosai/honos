import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { AuthValidationError, type OidcConfig } from './config.js';
import { normalizedIdentity, textClaim, type NormalizedIdentity } from './session.js';
import { constantEqual, pkceChallenge, type AuthTransaction } from './transaction.js';

export type AuthFetch = typeof fetch;
const jwksCache = new Map<string, JWTVerifyGetKey>();
function configuredJwks(config: OidcConfig): JWTVerifyGetKey {
  let keys = jwksCache.get(config.jwksUri);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(config.jwksUri), { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 600_000 });
    jwksCache.set(config.jwksUri, keys);
  }
  return keys;
}
export function oidcAuthorizationUrl(config: OidcConfig, transaction: AuthTransaction): URL {
  const url = new URL(config.authorizationEndpoint);
  // Replace any configured duplicates; these security parameters cannot come from a request.
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, scope: config.scopes, state: transaction.state, nonce: transaction.nonce, code_challenge: transaction.challenge, code_challenge_method: 'S256', response_mode: 'query' })) url.searchParams.set(key, value);
  return url;
}
export async function verifyIdToken(token: string, config: OidcConfig, nonce: string, key: JWTVerifyGetKey = configuredJwks(config)): Promise<NormalizedIdentity> {
  try {
    if (token.length > 32_768) throw new Error();
    const { payload, protectedHeader } = await jwtVerify(token, key, { algorithms: config.algorithms, issuer: config.issuer, audience: config.clientId, requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'nonce'], maxTokenAge: '10m', clockTolerance: 0 });
    if (protectedHeader.jku || protectedHeader.x5u || protectedHeader.jwk || !constantEqual(nonce, payload.nonce)) throw new Error();
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat! > Math.floor(Date.now() / 1000) || payload.exp! <= payload.iat!) throw new Error();
    if (Array.isArray(payload.aud) && (payload.aud.length === 0 || payload.aud.some((aud) => typeof aud !== 'string') || payload.aud.length > 1 && payload.azp !== config.clientId)) throw new Error();
    if (payload.azp !== undefined && payload.azp !== config.clientId) throw new Error();
    const sub = textClaim(payload.sub, 512)!;
    if (sub !== payload.sub) throw new Error();
    // Pairwise namespacing avoids mapping another issuer's coincidentally identical subject to HON IAM.
    return normalizedIdentity({ externalSubject: `oidc:${encodeURIComponent(config.issuer)}:${encodeURIComponent(sub)}`, displayName: payload.name, email: payload.email, ...(payload.email_verified === true ? { emailVerified: true } : {}) });
  } catch { throw new AuthValidationError(); }
}

export async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new AuthValidationError(); }
  // Bounded streaming avoids keeping arbitrarily large provider bodies/tokens in memory or errors.
  if (!response.body) throw new AuthValidationError();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 65_536) { await reader.cancel(); throw new AuthValidationError(); }
      chunks.push(chunk.value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new AuthValidationError(); } finally { reader.releaseLock(); }
}
function formEncode(value: string): string { return new URLSearchParams({ value }).toString().slice('value='.length); }
export async function exchangeOidcCode(code: string, transaction: AuthTransaction, config: OidcConfig, fetcher: AuthFetch = fetch, key?: JWTVerifyGetKey): Promise<NormalizedIdentity> {
  try {
    if (transaction.redirectUri !== config.redirectUri || !/^[A-Za-z0-9_-]{43}$/.test(transaction.verifier) || !constantEqual(transaction.challenge, pkceChallenge(transaction.verifier))) throw new Error();
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, client_id: config.clientId, code_verifier: transaction.verifier });
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (config.tokenEndpointAuthMethod === 'client_secret_basic') headers.Authorization = `Basic ${Buffer.from(`${formEncode(config.clientId)}:${formEncode(config.clientSecret!)}`).toString('base64')}`;
    if (config.tokenEndpointAuthMethod === 'client_secret_post') form.set('client_secret', config.clientSecret!);
    const tokens = await jsonResponse(await fetcher(config.tokenEndpoint, { method: 'POST', headers, body: form.toString(), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) }));
    if (tokens.error !== undefined || typeof tokens.id_token !== 'string' || !tokens.id_token) throw new Error();
    return await verifyIdToken(tokens.id_token, config, transaction.nonce, key);
  } catch { throw new AuthValidationError(); }
}
