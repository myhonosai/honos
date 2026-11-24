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

/**
 * Holds the rows a CRM trial command's authority rests on (0629 `hon.hold_crm_trial_authority`): FOR SHARE locks on the
 * organization, school, user, human principals, this school's grants, their roles and role permissions, and the
 * organization's entitlements, in the platform IAM lock order, until the transaction ends. Call it after the command's
 * own serialization lock and before `assertCurrentCrmAuthority`: a revocation or suspension that committed first is seen
 * by that re-check, and one that arrives later waits for this transaction, so a later wait inside the command (an
 * idempotency reservation, a row lock) can no longer let the command commit on authority that was withdrawn meanwhile.
 */
export async function holdCrmTrialAuthority(client: Queryable, externalSubject: string, context: CommandContext, refusal: string): Promise<void> {
  try {
    // The hold refuses anything but a direct human UI command; it reads the command's source from these GUCs.
    await client.query(
      "SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)",
      [context.source, externalSubject, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? ''],
    );
    await client.query('SELECT hon.hold_crm_trial_authority($1)', [externalSubject]);
  } catch (error) {
    const refused = error as { code?: string; message?: string } | null;
    // Only the hold's own refusal is a 403; a missing EXECUTE grant (also 42501) must surface as a server error.
    if (refused?.code === '42501' && refused.message === 'CRM_TRIAL_FORBIDDEN') throw new ForbiddenException(refusal);
    throw error;
  }
}

export type CrmPermission = 'crm.trial.schedule' | 'crm.trial.manage' | 'crm.lead.read' | 'crm.lead.create' | 'crm.pipeline.manage';
