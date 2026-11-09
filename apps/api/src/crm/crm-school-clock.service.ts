import { ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { verifyCrmSchoolClock, type CrmSchoolClock } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (sqlState === '42501') throw new ForbiddenException({ code: 'CRM_SCHOOL_CLOCK_FORBIDDEN' });
  if (message === 'SCHOOL_TIMEZONE_INVALID') throw new ConflictException({ code: message, detail: 'The school timezone is not a valid IANA timezone.' });
  throw new ServiceUnavailableException({ code: 'CRM_SCHOOL_CLOCK_UNAVAILABLE' });
}

/**
 * B-CRM-3 (0236): the session school's IANA timezone and local date, so CRM screens take and show times in school
 * time. The definer re-proves the direct human subject, a live CRM trial or follow-up permission at the exact school
 * and paid access, before and after the read. Commands are unchanged: they still receive offset-qualified instants.
 */
@Injectable()
export class CrmSchoolClockService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(context: MembershipLifecycleContext): Promise<CrmSchoolClock> {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'The CRM school clock is read only for a direct human operator.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'CRM_SCHOOL_CLOCK_FORBIDDEN' });
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client) => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_crm_school_clock($1) AS data', [subject]);
        if (result.rows.length !== 1) throw new Error('Unverified CRM school clock.');
        return verifyCrmSchoolClock(result.rows[0]!.data, context.schoolId);
      });
    } catch (error) { return translate(error); }
  }
}
