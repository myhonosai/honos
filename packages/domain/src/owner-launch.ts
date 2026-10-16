import type { OwnerLaunchContext } from '@hon/contracts';
/** Identity/scope is still independently rechecked and locked by PostgreSQL. */
export function assertOwnerLaunchHuman(context: OwnerLaunchContext): void {
  if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId || !context.externalSubject) throw new Error('REGISTRATION_FORBIDDEN');
}
