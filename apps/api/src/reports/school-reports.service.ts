import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException, UnprocessableEntityException,
} from '@nestjs/common';
import { validateSchoolReportsQuery, verifySchoolReportLocations, verifySchoolReports, type SchoolReportLocations, type SchoolReports } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (sqlState === '42501') throw new ForbiddenException({ code: 'SCHOOL_REPORTS_FORBIDDEN' });
  if (message === 'SCHOOL_TIMEZONE_INVALID' && sqlState === '22023') {
    throw new ConflictException({ code: 'SCHOOL_TIMEZONE_INVALID', detail: 'The school timezone is not a valid IANA timezone.' });
  }
  if (message === 'SCHOOL_REPORTS_TOO_MANY_LOCATIONS' && sqlState === '22023') {
    throw new UnprocessableEntityException({ code: 'SCHOOL_REPORTS_TOO_MANY_LOCATIONS', detail: 'More than 20 locations: open each school report instead.' });
  }
  if (['22023', '22P02'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'SCHOOL_REPORTS_UNAVAILABLE' });
}

/**
 * R1 (0331): month by month school reports. One protected definer function re-proves the direct human subject and the live
 * school-scoped reporting.view permission and returns counts and money totals only. Nothing is written, sent or charged.
 */
@Injectable()
export class SchoolReportsService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(context: MembershipLifecycleContext, value: unknown): Promise<SchoolReports> {
    return this.run(context, value, 'SELECT hon.read_school_reports($1,$2::jsonb) AS data', (data, query) => verifySchoolReports(data, context.schoolId, query));
  }

  /** R2 (0332): the same totals for every location of the organization where this person may see reports. */
  async readLocations(context: MembershipLifecycleContext, value: unknown): Promise<SchoolReportLocations> {
    return this.run(context, value, 'SELECT hon.read_school_reports_locations($1,$2::jsonb) AS data',
      (data, query) => verifySchoolReportLocations(data, context.organizationId, context.schoolId, query));
  }

  private async run<T>(context: MembershipLifecycleContext, value: unknown, statement: string,
    verify: (data: unknown, query: ReturnType<typeof validateSchoolReportsQuery>) => T): Promise<T> {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'School reports are for a signed-in staff member only.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'SCHOOL_REPORTS_FORBIDDEN' });
    let query: ReturnType<typeof validateSchoolReportsQuery>;
    try { query = validateSchoolReportsQuery(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        const result = await client.query<{ data: unknown }>(statement, [subject, JSON.stringify(query)]);
        if (result.rows.length !== 1) throw new Error('Unverified school reports.');
        return verify(result.rows[0]!.data, query);
      });
    } catch (error) { return translate(error); }
  }
}
