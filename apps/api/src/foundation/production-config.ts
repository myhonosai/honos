import { sessionConfig } from '@hon/auth';
import { isLoopbackDatabaseUrl, verifiedDatabaseConnection, type DatabaseEnvironment } from '@hon/database';
import { runtimePoolMax } from './runtime-pool-options.js';

export type DeploymentEnvironment = 'production' | 'staging' | 'preview' | 'development';
const DEPLOYMENTS: readonly DeploymentEnvironment[] = ['production', 'staging', 'preview', 'development'];

export interface DeploymentConfigurationResult {
  deployment: DeploymentEnvironment;
  // Stable, value-free codes: safe to log and to assert in tests.
  failures: string[];
}

function databaseUser(url: string): string | undefined {
  try { return decodeURIComponent(new URL(url).username).split('.', 1)[0]; } catch { return undefined; }
}

/**
 * Startup gate for the API process. A production build (NODE_ENV=production) must declare which
 * deployment it is, so a mislabelled environment cannot silently run with development defaults.
 * Production and staging must also: use a non-local runtime database over verified TLS, keep the
 * privileged migration credential out of the API process, and use OIDC sign-in.
 */
export function validateDeploymentConfiguration(env: DatabaseEnvironment = process.env): DeploymentConfigurationResult {
  const failures: string[] = [];
  const declared = env.HON_DEPLOYMENT_ENVIRONMENT;
  let deployment: DeploymentEnvironment = 'development';
  if (declared === undefined) {
    if (env.NODE_ENV === 'production') failures.push('DEPLOYMENT_ENVIRONMENT_REQUIRED');
  } else if ((DEPLOYMENTS as readonly string[]).includes(declared)) {
    deployment = declared as DeploymentEnvironment;
    if (deployment === 'development' && env.NODE_ENV === 'production') failures.push('DEVELOPMENT_DEPLOYMENT_IN_PRODUCTION_BUILD');
  } else {
    failures.push('DEPLOYMENT_ENVIRONMENT_INVALID');
  }

  try { runtimePoolMax(env); } catch { failures.push('RUNTIME_POOL_MAX_INVALID'); }

  const runtimeUrl = env.HON_RUNTIME_DATABASE_URL;
  if (runtimeUrl) {
    // Applies in every environment: a non-local database always needs a verified CA.
    try { verifiedDatabaseConnection(runtimeUrl, env); } catch { failures.push('RUNTIME_DATABASE_TLS_INVALID'); }
  }

  const workerUrl = env.HON_COMMUNICATION_WORKER_DATABASE_URL;
  if (workerUrl) {
    try { verifiedDatabaseConnection(workerUrl, env); } catch { failures.push('COMMUNICATION_WORKER_DATABASE_TLS_INVALID'); }
    const workerUser = databaseUser(workerUrl);
    if ((runtimeUrl && workerUser === databaseUser(runtimeUrl)) || (env.DATABASE_URL && workerUser === databaseUser(env.DATABASE_URL))) {
      failures.push('COMMUNICATION_WORKER_ROLE_REUSED');
    }
  }

  const strict = deployment === 'production' || deployment === 'staging' || (declared === undefined && env.NODE_ENV === 'production');
  if (strict) {
    if (!runtimeUrl) failures.push('RUNTIME_DATABASE_URL_REQUIRED');
    else {
      try { if (isLoopbackDatabaseUrl(runtimeUrl)) failures.push('RUNTIME_DATABASE_LOOPBACK_FORBIDDEN'); } catch { /* reported above */ }
    }
    if (env.DATABASE_URL) {
      failures.push('MIGRATION_CREDENTIAL_IN_API_PROCESS');
      if (runtimeUrl && databaseUser(env.DATABASE_URL) === databaseUser(runtimeUrl)) failures.push('RUNTIME_USES_MIGRATION_ROLE');
    }
    // The deterministic fake message provider never runs in production or staging.
    if (env.HON_COMMUNICATION_FAKE_PROVIDER !== undefined) failures.push('COMMUNICATION_FAKE_PROVIDER_FORBIDDEN');
    // 0347: the deterministic fake Zernio social adapter never runs in production or staging either.
    if (env.HON_ZERNIO_FAKE_PROVIDER !== undefined) failures.push('ZERNIO_FAKE_PROVIDER_FORBIDDEN');
    if (env.HON_AUTH_MODE !== 'OIDC') failures.push('OIDC_AUTH_REQUIRED');
    else {
      // The API verifies HON session cookies only; OIDC endpoints are web-server configuration.
      try { sessionConfig(env); } catch { failures.push('SESSION_CONFIGURATION_INVALID'); }
    }
  }
  return { deployment, failures: [...new Set(failures)] };
}
