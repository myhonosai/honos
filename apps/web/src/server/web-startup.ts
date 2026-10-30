import { oidcConfig, type Environment } from '@hon/auth';
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_SERVER } from 'next/constants';

const DEPLOYMENTS = ['production', 'staging', 'preview', 'development'] as const;
type StartupFailure = 'DEPLOYMENT_ENVIRONMENT_REQUIRED' | 'DEPLOYMENT_ENVIRONMENT_INVALID'
  | 'DEVELOPMENT_DEPLOYMENT_IN_PRODUCTION_SERVER' | 'OIDC_AUTH_REQUIRED' | 'OIDC_CONFIGURATION_INVALID';

/** Value-free failures only: never retain the environment or an upstream validator error. */
export class WebStartupConfigurationError extends Error {
  constructor(readonly code: StartupFailure) {
    super(`HON web startup refused: ${code}.`);
    this.name = 'WebStartupConfigurationError';
  }
}

/**
 * Next's existing server entry point loads this before accepting requests. Build/export phases
 * deliberately require no runtime credentials. An explicit isolated preview retains the existing
 * fail-closed route validators and can show reference pages without configuring a sign-in provider.
 * A preview label does not establish private hosting, identity or tenant authority.
 */
export function assertWebStartupConfiguration(phase: string, env: Environment = process.env): void {
  if (phase !== PHASE_PRODUCTION_SERVER && phase !== PHASE_DEVELOPMENT_SERVER) return;
  const deployment = env.HON_DEPLOYMENT_ENVIRONMENT;
  const productionServer = phase === PHASE_PRODUCTION_SERVER || env.NODE_ENV === 'production';
  if (deployment === undefined) {
    if (productionServer) throw new WebStartupConfigurationError('DEPLOYMENT_ENVIRONMENT_REQUIRED');
    return;
  }
  if (!(DEPLOYMENTS as readonly string[]).includes(deployment)) {
    throw new WebStartupConfigurationError('DEPLOYMENT_ENVIRONMENT_INVALID');
  }
  if (deployment === 'development' && productionServer) {
    throw new WebStartupConfigurationError('DEVELOPMENT_DEPLOYMENT_IN_PRODUCTION_SERVER');
  }
  if (deployment !== 'production' && deployment !== 'staging') return;
  if (env.HON_AUTH_MODE !== 'OIDC') throw new WebStartupConfigurationError('OIDC_AUTH_REQUIRED');
  // Pure, shared validation: session key/audience, HTTPS origin/endpoints, exact callback,
  // issuer, client, scopes, algorithms and token-auth method. No discovery or provider traffic.
  try { oidcConfig(env); } catch { throw new WebStartupConfigurationError('OIDC_CONFIGURATION_INVALID'); }
}
