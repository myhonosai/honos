import type { PoolClient } from 'pg';
import { INTAKE_CONSENT_CHANNELS, isIntakeConsentChannels, type CommandContext, type IntakeConsentChannel } from '@hon/contracts';

/**
 * IC1 (0555) automatic intake consent for staff adds and imports. Called inside the same transaction that created
 * the people; hon.record_staff_intake_consent re-checks the signed-in staff member and touches only people created in
 * this transaction. Staff may untick a channel; omitted means both (owner default 2026-11-19).
 * Only a direct human UI command records anything: AI, automation, delegated or action-engine commands never do.
 */
export type StaffIntakeConsentTarget =
  | { method: 'STAFF_ADD'; personId: string }
  | { method: 'LEAD_IMPORT' | 'STUDENT_IMPORT'; batchId: string };

export function intakeConsentChannels(value: IntakeConsentChannel[] | undefined): IntakeConsentChannel[] {
  if (value === undefined) return [...INTAKE_CONSENT_CHANNELS];
  if (!isIntakeConsentChannels(value)) throw new Error('HON intake consent channels are invalid.');
  return [...value].sort();
}

export function isDirectHumanCommand(context: CommandContext & { externalSubject?: string }): context is CommandContext & { externalSubject: string } {
  return context.principalType === 'HUMAN_USER' && context.source === 'HUMAN_UI' && !context.actionRequestId && !context.delegatedByPrincipalId
    && typeof context.externalSubject === 'string' && context.externalSubject.length > 0;
}

export async function recordStaffIntakeConsent(
  client: Pick<PoolClient, 'query'>,
  context: CommandContext & { externalSubject?: string },
  target: StaffIntakeConsentTarget,
  channels: IntakeConsentChannel[] | undefined,
): Promise<{ people: number; recorded: number } | null> {
  if (!isDirectHumanCommand(context)) return null;
  const selected = intakeConsentChannels(channels);
  if (selected.length === 0) return { people: 0, recorded: 0 };
  await client.query(
    "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)",
    [context.externalSubject],
  );
  const result = await client.query<{ result: { people: number; recorded: number } }>(
    'SELECT hon.record_staff_intake_consent($1,$2::jsonb) AS result',
    [context.externalSubject, JSON.stringify({ ...target, channels: selected })],
  );
  return result.rows[0]?.result ?? null;
}
