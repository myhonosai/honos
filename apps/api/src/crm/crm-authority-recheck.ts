import { ForbiddenException } from '@nestjs/common';
import type { CommandContext } from '@hon/contracts';

interface Queryable {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Re-resolves a human's exact-school authority inside the command or read transaction, after any lock wait and
 * immediately before the guarded statement.
 *
 * The controller resolves authority before the service waits on a lock, and a grant or principal can be revoked
 * during that wait. A fresh READ COMMITTED statement sees the revocation; the re-resolved principal, organization and
 * school must equal the original scope or the command fails closed with 403 and its transaction rolls back.
 * `hon.resolve_authorized_scope` also re-checks the human identity and lifecycle: one active HUMAN_USER principal for
 * the user, an ACTIVE organization and school, and an unrevoked effective role grant carrying the permission. A school or
 * organization suspended after the controller authorized the request is therefore refused here.
 */
export async function assertCurrentCrmAuthority(
  client: Queryable,
  externalSubject: string,
  context: CommandContext,
  permissionCodes: CrmPermission | readonly CrmPermission[],
  refusal: string,
): Promise<void> {
  // Any one of the listed permissions suffices (trial reads accept schedule or manage, as their controller does).
  for (const permissionCode of typeof permissionCodes === 'string' ? [permissionCodes] : permissionCodes) {
    const current = await client.query<{ principal_id: string; organization_id: string; school_id: string }>(
      'SELECT principal_id, organization_id, school_id FROM hon.resolve_authorized_scope($1, $2::uuid, $3)',
      [externalSubject, context.schoolId, permissionCode],
    );
    const still = current.rows[0];
    if (still && still.principal_id === context.principalId && still.organization_id === context.organizationId
      && still.school_id === context.schoolId) return;
  }
  throw new ForbiddenException(refusal);
}

export type CrmPermission = 'crm.trial.schedule' | 'crm.trial.manage' | 'crm.lead.read' | 'crm.lead.create' | 'crm.pipeline.manage';
