import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type { AttendanceCommandContext, AttendanceProgressionPolicy, ConfigureAttendancePolicyInput } from '@hon/contracts';
import { validateAttendancePolicy } from '@hon/domain';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { attendanceDatabaseError } from './attendance-database-error.js';

export function requireAttendanceHuman(context: AttendanceCommandContext): void {
  if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI'
    || context.actionRequestId || context.delegatedByPrincipalId || !context.externalSubject) {
    throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED' });
  }
}
export async function markAttendanceHuman(client: import('pg').PoolClient, context: AttendanceCommandContext): Promise<void> {
  await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_correlation_id',$3,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source, context.externalSubject, context.correlationId]);
  await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
}
@Injectable()
export class AttendancePolicyService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  async get(context: AttendanceCommandContext, programId: string): Promise<AttendanceProgressionPolicy> {
    requireAttendanceHuman(context);
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await markAttendanceHuman(client, context);
        const result = await client.query<{ data: AttendanceProgressionPolicy }>('SELECT hon.read_attendance_policy($1,$2::uuid) data', [context.externalSubject, programId]);
        if (!result.rows[0]) throw new Error('Attendance policy read did not return a result.');
        return result.rows[0].data;
      });
    } catch (error) { return attendanceDatabaseError(error); }
  }
  async configure(context: AttendanceCommandContext, programId: string, input: ConfigureAttendancePolicyInput): Promise<{ policy: AttendanceProgressionPolicy; replayed: boolean }> {
    requireAttendanceHuman(context);
    try { validateAttendancePolicy(input); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    if (!context.idempotencyKey || context.idempotencyKey.length > 200 || context.idempotencyKey !== context.idempotencyKey.trim() || /[\x00-\x1f\x7f]/.test(context.idempotencyKey)) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await markAttendanceHuman(client, context);
        const result = await client.query<{ data: { policy: AttendanceProgressionPolicy; replayed: boolean } }>(
          'SELECT hon.configure_attendance_policy($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) data',
          [context.externalSubject, programId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
        );
        if (!result.rows[0]) throw new Error('Attendance policy configuration did not return a result.');
        return result.rows[0].data;
      });
    } catch (error) { return attendanceDatabaseError(error); }
  }
}
