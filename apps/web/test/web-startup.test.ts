import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHASE_DEVELOPMENT_SERVER, PHASE_EXPORT, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from 'next/constants';
import { assertWebStartupConfiguration, WebStartupConfigurationError } from '../src/server/web-startup';
import configureNext from '../next.config';

const valid = {
  NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'production', HON_AUTH_MODE: 'OIDC',
  HON_SESSION_JWT_SECRET: 'TEST_ONLY_STARTUP_KEY_1234567890123456789012', HON_SESSION_AUDIENCE: 'startup-test',
  HON_PUBLIC_ORIGIN: 'https://hon.example.invalid', HON_OIDC_ISSUER: 'https://identity.example.invalid',
  HON_OIDC_AUTHORIZATION_ENDPOINT: 'https://identity.example.invalid/authorize',
  HON_OIDC_TOKEN_ENDPOINT: 'https://identity.example.invalid/token', HON_OIDC_JWKS_URI: 'https://identity.example.invalid/keys',
  HON_OIDC_CLIENT_ID: 'test-client', HON_OIDC_SCOPES: 'openid email',
  HON_OIDC_REDIRECT_URI: 'https://hon.example.invalid/auth/callback', HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'none',
};
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const check = (env: Record<string, string | undefined>, code: string) => {
  try { assertWebStartupConfiguration(PHASE_PRODUCTION_SERVER, env); throw new Error('Unexpected success'); }
  catch (error) { expect(error).toBeInstanceOf(WebStartupConfigurationError); expect((error as WebStartupConfigurationError).code).toBe(code); }
};

describe('web deployment startup boundary', () => {
  it.each(['production', 'staging'])('accepts complete %s OIDC without any external requests', deployment => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No provider access'));
    expect(() => assertWebStartupConfiguration(PHASE_PRODUCTION_SERVER, { ...valid, HON_DEPLOYMENT_ENVIRONMENT: deployment })).not.toThrow();
    expect(() => assertWebStartupConfiguration(PHASE_DEVELOPMENT_SERVER, { ...valid, HON_DEPLOYMENT_ENVIRONMENT: deployment })).not.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires an explicit deployment even if a production server has NODE_ENV unset or development', () => {
    for (const NODE_ENV of [undefined, 'development', 'production']) check({ NODE_ENV }, 'DEPLOYMENT_ENVIRONMENT_REQUIRED');
    check({ ...valid, HON_DEPLOYMENT_ENVIRONMENT: 'development' }, 'DEVELOPMENT_DEPLOYMENT_IN_PRODUCTION_SERVER');
  });
  it.each(['', 'prod', 'Production', ' preview', 'unknown\nSECRET'])('rejects invalid deployment labels without echoing %j', label => {
    check({ ...valid, HON_DEPLOYMENT_ENVIRONMENT: label }, 'DEPLOYMENT_ENVIRONMENT_INVALID');
  });
  it.each([undefined, '', 'MANUS_DEVELOPMENT', 'AUTO', 'oidc'])('rejects customer-facing mode %s even with development credentials', mode => {
    check({ ...valid, HON_AUTH_MODE: mode, MANUS_PROJECT_ID: 'test', MANUS_JWT_SECRET: 'TEST_ONLY' }, 'OIDC_AUTH_REQUIRED');
  });
  it.each(Object.keys(valid).filter(k => k.startsWith('HON_') && k !== 'HON_DEPLOYMENT_ENVIRONMENT' && k !== 'HON_AUTH_MODE'))('requires %s using the existing shared validator', field => {
    check({ ...valid, [field]: undefined }, 'OIDC_CONFIGURATION_INVALID');
  });
  it.each([
    { HON_SESSION_JWT_SECRET: 'short' }, { HON_SESSION_AUDIENCE: ' ' },
    { HON_PUBLIC_ORIGIN: 'http://localhost:3000' }, { HON_OIDC_ISSUER: 'http://identity.example.invalid' },
    { HON_OIDC_TOKEN_ENDPOINT: 'https://user:password@identity.example.invalid/token' },
    { HON_OIDC_JWKS_URI: 'https://identity.example.invalid/keys#fragment' },
    { HON_OIDC_REDIRECT_URI: 'https://other.example.invalid/auth/callback' },
    { HON_OIDC_SCOPES: 'email' }, { HON_OIDC_ID_TOKEN_ALGORITHMS: 'HS256' },
    { HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'client_secret_basic' },
    { HON_OIDC_CLIENT_SECRET: 'unexpected-secret' }, { HON_SESSION_VERIFIED_EMAIL_ENABLED: 'yes' },
  ])('rejects unsafe OIDC/session configuration %j', patch => check({ ...valid, ...patch }, 'OIDC_CONFIGURATION_INVALID'));
  it.each(['client_secret_basic', 'client_secret_post'])('preserves supported confidential client method %s', method => {
    expect(() => assertWebStartupConfiguration(PHASE_PRODUCTION_SERVER, { ...valid, HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: method, HON_OIDC_CLIENT_SECRET: 'TEST_ONLY_PRIVATE' })).not.toThrow();
  });
  it('never logs or embeds credentials, URLs, invalid values or validator causes', () => {
    const logger = vi.spyOn(console, 'error');
    try { assertWebStartupConfiguration(PHASE_PRODUCTION_SERVER, { ...valid, HON_OIDC_TOKEN_ENDPOINT: 'https://user:SECRET_MARKER@bad.example/#SECRET_MARKER' }); }
    catch (error) { expect(String(error) + JSON.stringify(error)).not.toMatch(/SECRET_MARKER|bad\.example|user:/); expect((error as Error).cause).toBeUndefined(); }
    expect(logger).not.toHaveBeenCalled();
  });
  it('keeps secret-free build/export and explicit isolated previews working without asserting auth readiness', () => {
    for (const phase of [PHASE_PRODUCTION_BUILD, PHASE_EXPORT]) {
      expect(() => assertWebStartupConfiguration(phase, { NODE_ENV: 'production' })).not.toThrow();
    }
    for (const HON_AUTH_MODE of [undefined, 'MANUS_DEVELOPMENT', 'OIDC']) {
      expect(() => assertWebStartupConfiguration(PHASE_PRODUCTION_SERVER, { NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', HON_AUTH_MODE })).not.toThrow();
    }
  });
  it('keeps local development with absent deployment identity and existing auth-route failure behavior', () => {
    expect(() => assertWebStartupConfiguration(PHASE_DEVELOPMENT_SERVER, {})).not.toThrow();
    expect(() => assertWebStartupConfiguration(PHASE_DEVELOPMENT_SERVER, { NODE_ENV: 'development', HON_DEPLOYMENT_ENVIRONMENT: 'development' })).not.toThrow();
    expect(() => assertWebStartupConfiguration(PHASE_DEVELOPMENT_SERVER, { ...valid, HON_AUTH_MODE: 'MANUS_DEVELOPMENT' })).toThrow('OIDC_AUTH_REQUIRED');
    expect(() => assertWebStartupConfiguration(PHASE_DEVELOPMENT_SERVER, { NODE_ENV: 'production' })).toThrow('DEPLOYMENT_ENVIRONMENT_REQUIRED');
  });
  it('wires the guard into the actual Next server configuration while keeping builds credential-free', () => {
    vi.stubEnv('HON_DEPLOYMENT_ENVIRONMENT', '');
    expect(() => configureNext(PHASE_PRODUCTION_SERVER)).toThrow('DEPLOYMENT_ENVIRONMENT_INVALID');
    expect(configureNext(PHASE_PRODUCTION_BUILD).transpilePackages).toEqual(['@hon/design-system']);
  });
});
