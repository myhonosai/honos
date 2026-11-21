import { ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyParentAttendanceStreaks, type ParentAttendanceStreaks } from '@hon/contracts';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";

export function translateParentAttendanceStreaksError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if ((error as { code?: string })?.code === '42501') throw new ForbiddenException({ code: 'ATTENDANCE_STREAKS_FORBIDDEN' });
  throw new ServiceUnavailableException({ code: 'ATTENDANCE_STREAKS_UNAVAILABLE', detail: 'No verified attendance streak is available.' });
}

/**
 * 0602 weekly attendance streaks. The one live family grant decides the school and family, with no selector trusted. The read
 * returns each ACTIVE child's name and streak in weeks; nothing else.
 */
@Injectable()
export class ParentAttendanceStreaksService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(subject: string): Promise<ParentAttendanceStreaks> {
    if (typeof subject !== 'string' || !subject || subject.length > 200 || subject.trim() !== subject) throw new ForbiddenException({ code: 'ATTENDANCE_STREAKS_FORBIDDEN' });
    try {
      const scopes: ResolvedParentFamilyScope[] = await this.database.resolveParentJourneyScopes(subject);
      if (scopes.length !== 1) throw new ForbiddenException({ code: 'ATTENDANCE_STREAKS_FORBIDDEN' });
      const scope = scopes[0]!;
      const context = { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId: randomUUID() };
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_parent_attendance_streaks($1) AS data', [subject]);
        if (result.rows.length !== 1) throw new Error('Unverified attendance streak read.');
        return verifyParentAttendanceStreaks(result.rows[0]!.data);
      });
    } catch (error) { return translateParentAttendanceStreaksError(error); }
  }
}
