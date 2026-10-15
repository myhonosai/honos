export type AuthMode = 'MANUS_DEVELOPMENT' | 'OIDC';
export type Environment = Readonly<Record<string, string | undefined>>;

// Error messages deliberately contain no environment values, tokens, or provider errors.
export class AuthConfigurationError extends Error {
  constructor() { super('HON authentication configuration is incomplete or invalid.'); }
}
export class AuthValidationError extends Error {
  constructor() { super('HON could not validate the authentication request.'); }
}

const manusFields = ['MANUS_PROJECT_ID', 'MANUS_JWT_SECRET', 'MANUS_OAUTH_API_URL', 'MANUS_OAUTH_PORTAL_URL'] as const;
export function authMode(env: Environment = process.env): AuthMode {
  if (env.HON_AUTH_MODE === 'OIDC' || env.HON_AUTH_MODE === 'MANUS_DEVELOPMENT') return env.HON_AUTH_MODE;
  // Only an absent setting can use the legacy development adapter; typos/empty settings never can.
  if (env.HON_AUTH_MODE === undefined && env.NODE_ENV !== 'production' && manusFields.every((key) => Boolean(env[key]?.trim()))) return 'MANUS_DEVELOPMENT';
  throw new AuthConfigurationError();
}

export interface SessionConfig { mode: AuthMode; secret: string; audience: string; }
export function sessionConfig(env: Environment = process.env): SessionConfig {
  const mode = authMode(env);
  const secret = env.HON_SESSION_JWT_SECRET;
  const audience = env.HON_SESSION_AUDIENCE ?? (mode === 'MANUS_DEVELOPMENT' ? env.MANUS_PROJECT_ID : undefined);
  if (!secret || Buffer.byteLength(secret) < 32 || secret !== secret.trim() || /[\x00-\x1f\x7f<>]/.test(secret) || secret.startsWith('REPLACE_') || !audience || audience !== audience.trim() || /[\x00-\x20\x7f<>]/.test(audience) || audience.length > 256) throw new AuthConfigurationError();
  // Reusing the development adapter key is not a HON-owned trust boundary.
  if (mode === 'MANUS_DEVELOPMENT' && secret === env.MANUS_JWT_SECRET) throw new AuthConfigurationError();
  return { mode, secret, audience };
}

function required(env: Environment, key: string): string {
  const value = env[key];
  if (!value || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new AuthConfigurationError();
  return value;
}
function protectedUrl(value: string, originOnly = false, allowLocal = false): string {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(allowLocal && local && url.protocol === 'http:')) || url.username || url.password || url.hash || (originOnly && (url.pathname !== '/' || url.search))) throw new Error();
    return originOnly ? url.origin : value;
  } catch { throw new AuthConfigurationError(); }
}
export function configuredPublicOrigin(env: Environment): string | undefined {
  return env.HON_PUBLIC_ORIGIN === undefined ? undefined : protectedUrl(required(env, 'HON_PUBLIC_ORIGIN'), true, true);
}

export interface OidcConfig extends SessionConfig {
  mode: 'OIDC';
  publicOrigin: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  clientId: string;
  scopes: string;
  redirectUri: string;
  tokenEndpointAuthMethod: 'none' | 'client_secret_basic' | 'client_secret_post';
  clientSecret?: string;
  algorithms: string[];
}
export function oidcConfig(env: Environment = process.env): OidcConfig {
  const session = sessionConfig(env);
  if (session.mode !== 'OIDC') throw new AuthConfigurationError();
  const publicOrigin = protectedUrl(required(env, 'HON_PUBLIC_ORIGIN'), true);
  const issuer = protectedUrl(required(env, 'HON_OIDC_ISSUER'));
  if (new URL(issuer).search) throw new AuthConfigurationError();
  const authorizationEndpoint = protectedUrl(required(env, 'HON_OIDC_AUTHORIZATION_ENDPOINT'));
  const tokenEndpoint = protectedUrl(required(env, 'HON_OIDC_TOKEN_ENDPOINT'));
  const jwksUri = protectedUrl(required(env, 'HON_OIDC_JWKS_URI'));
  const clientId = required(env, 'HON_OIDC_CLIENT_ID');
  const scopes = required(env, 'HON_OIDC_SCOPES');
  if (!/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(scopes) || !scopes.split(' ').includes('openid')) throw new AuthConfigurationError();
  const redirectUri = protectedUrl(required(env, 'HON_OIDC_REDIRECT_URI'));
  if (redirectUri !== `${publicOrigin}/auth/callback`) throw new AuthConfigurationError();
  const method = required(env, 'HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD');
  if (method !== 'none' && method !== 'client_secret_basic' && method !== 'client_secret_post') throw new AuthConfigurationError();
  const clientSecret = method === 'none' ? undefined : required(env, 'HON_OIDC_CLIENT_SECRET');
  if (method === 'none' && env.HON_OIDC_CLIENT_SECRET) throw new AuthConfigurationError();
  const algorithms = (env.HON_OIDC_ID_TOKEN_ALGORITHMS ?? 'RS256').split(',');
  const supported = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];
  if (!algorithms.length || algorithms.some((alg) => !supported.includes(alg)) || new Set(algorithms).size !== algorithms.length) throw new AuthConfigurationError();
  return { ...session, mode: 'OIDC', publicOrigin, issuer, authorizationEndpoint, tokenEndpoint, jwksUri, clientId, scopes, redirectUri, tokenEndpointAuthMethod: method, algorithms, ...(clientSecret === undefined ? {} : { clientSecret }) };
}

export interface ManusConfig extends SessionConfig {
  mode: 'MANUS_DEVELOPMENT'; projectId: string; jwtSecret: string; apiUrl: string; portalUrl: string;
}
export function manusConfig(env: Environment = process.env): ManusConfig {
  const session = sessionConfig(env);
  if (session.mode !== 'MANUS_DEVELOPMENT') throw new AuthConfigurationError();
  return { ...session, mode: 'MANUS_DEVELOPMENT', projectId: required(env, 'MANUS_PROJECT_ID'), jwtSecret: required(env, 'MANUS_JWT_SECRET'), apiUrl: protectedUrl(required(env, 'MANUS_OAUTH_API_URL')), portalUrl: protectedUrl(required(env, 'MANUS_OAUTH_PORTAL_URL')) };
}

// Pure configuration readiness: deliberately no discovery, JWKS request, token exchange, or secret values.
export function authReadiness(env: Environment = process.env): { mode: AuthMode | null; ready: boolean; code: 'AUTH_READY' | 'AUTH_NOT_CONFIGURED' } {
  let mode: AuthMode | null = null;
  try {
    mode = authMode(env);
    if (mode === 'OIDC') oidcConfig(env); else manusConfig(env);
    return { mode, ready: true, code: 'AUTH_READY' };
  } catch { return { mode, ready: false, code: 'AUTH_NOT_CONFIGURED' }; }
}
