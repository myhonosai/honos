import type { PoolClient } from 'pg';
import type { TenantScope } from '@hon/contracts';

export interface TenantTransactionContext extends TenantScope {
  requestId: string;
  principalId: string;
  principalType: string;
}

export async function withTenantTransaction<T>(
  client: PoolClient,
  context: TenantTransactionContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');

  try {
    await client.query(
      `SELECT
        set_config('app.hon_organization_id', $1, true),
        set_config('app.hon_school_id', $2, true),
        set_config('app.hon_principal_id', $3, true),
        set_config('app.hon_principal_type', $4, true),
        set_config('app.hon_request_id', $5, true)`,
      [
        context.organizationId,
        context.schoolId,
        context.principalId,
        context.principalType,
        context.requestId,
      ],
    );
    await client.query('SELECT hon.require_tenant_context()');

    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export function assertScopedIdentifier(identifier: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error('Unsafe SQL identifier');
  }
  return identifier;
}
