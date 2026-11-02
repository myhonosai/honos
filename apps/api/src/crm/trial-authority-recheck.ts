import { ForbiddenException } from '@nestjs/common';
import type { CommandContext } from '@hon/contracts';

interface Queryable {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Re-resolves a human's exact-school authority inside the command transaction, after its lock waits.
 *
 * The controller resolves authority before the service waits on a lock, and a grant or principal can be revoked
 * during that wait. A fresh READ COMMITTED statement sees the revocation; the re-resolved principal, organization and
 * school must equal the original scope or the command fails closed with 403 and its transaction rolls back.
 * `hon.resolve_authorized_scope` also re-checks the human identity: active HUMAN_USER principal, mapped user, active
 * school and an effective role grant carrying the permission.
 */
export async function assertCurrentTrialAuthority(
  client: Queryable,
  externalSubject: string,
  context: CommandContext,
  permissionCode: 'crm.trial.schedule' | 'crm.trial.manage',
  refusal: string,
): Promise<void> {
  const current = await client.query<{ principal_id: string; organization_id: string; school_id: string }>(
    'SELECT principal_id, organization_id, school_id FROM hon.resolve_authorized_scope($1, $2::uuid, $3)',
    [externalSubject, context.schoolId, permissionCode],
  );
  const still = current.rows[0];
  if (!still || still.principal_id !== context.principalId || still.organization_id !== context.organizationId
    || still.school_id !== context.schoolId) {
    throw new ForbiddenException(refusal);
  }
}
