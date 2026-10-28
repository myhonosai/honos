import type { PoolConfig } from 'pg';
import { verifiedDatabaseConnection, type DatabaseEnvironment } from '@hon/database';

export const DEFAULT_RUNTIME_POOL_MAX = 8;
const MAX_RUNTIME_POOL_MAX = 40;

// Size per API instance. Supabase's Session Pooler caps clients per project, so the total across
// instances (instances x max) must stay below the pooler's pool size: see docs/operations.
export function runtimePoolMax(env: DatabaseEnvironment): number {
  const raw = env.HON_RUNTIME_DATABASE_POOL_MAX;
  if (raw === undefined) return DEFAULT_RUNTIME_POOL_MAX;
  if (!/^[1-9][0-9]?$/.test(raw) || Number(raw) > MAX_RUNTIME_POOL_MAX) {
    throw new Error(`HON_RUNTIME_DATABASE_POOL_MAX must be an integer from 1 to ${MAX_RUNTIME_POOL_MAX}.`);
  }
  return Number(raw);
}

export function runtimePoolOptions(connectionString: string, env: DatabaseEnvironment = process.env): PoolConfig {
  const connection = verifiedDatabaseConnection(connectionString, env);
  return {
    connectionString: connection.connectionString,
    ssl: connection.ssl,
    max: runtimePoolMax(env),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Recycle connections so pooler failover, rebalancing and credential rotation take effect
    // without a restart, and detect half-open TCP connections after network faults.
    maxLifetimeSeconds: 1_800,
    keepAlive: true,
    application_name: 'hon-api',
  };
}
