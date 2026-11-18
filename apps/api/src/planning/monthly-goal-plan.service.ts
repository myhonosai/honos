import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { validateMonthlyGoalPlanQuery, verifyMonthlyGoalPlan, type MonthlyGoalPlan, type MonthlyGoalPlanQuery } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (sqlState === '42501') throw new ForbiddenException({ code: 'MONTHLY_GOAL_PLAN_FORBIDDEN' });
  if (message === 'SCHOOL_TIMEZONE_INVALID' && sqlState === '22023') {
    throw new ConflictException({ code: 'SCHOOL_TIMEZONE_INVALID', detail: 'The school timezone is not a valid IANA timezone.' });
  }
  if (['22023', '22P02'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'MONTHLY_GOAL_PLAN_UNAVAILABLE' });
}

/**
 * G1 (0491): the monthly goal plan. One protected definer function re-proves the direct human and the live school-scoped
 * reporting.view permission (the 0331 rule) before and after the read, and returns counts and money totals only.
 * Nothing is written, sent, charged or scheduled, and no AI is called.
 */
@Injectable()
export class MonthlyGoalPlanService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(context: MembershipLifecycleContext, value: unknown): Promise<MonthlyGoalPlan> {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'The monthly goal plan is for a signed-in staff member only.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'MONTHLY_GOAL_PLAN_FORBIDDEN' });
    let query: MonthlyGoalPlanQuery;
    try { query = validateMonthlyGoalPlanQuery(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_monthly_goal_plan($1,$2::jsonb) AS data', [subject, JSON.stringify(query)]);
        if (result.rows.length !== 1) throw new Error('Unverified monthly goal plan.');
        return verifyMonthlyGoalPlan(result.rows[0]!.data, context.schoolId, query);
      });
    } catch (error) { return translate(error); }
  }
}
