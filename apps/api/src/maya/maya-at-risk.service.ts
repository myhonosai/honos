import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { validateMayaAtRiskQuery, verifyMayaAtRiskStudents, type MayaAtRiskStudents } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";

/** Exact 0259 refusals; every other database failure is unavailable, never an empty list. */
export function translateMayaAtRiskError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  if (sqlState === '42501') throw new ForbiddenException({ code: 'MAYA_AT_RISK_FORBIDDEN' });
  if (['40001', '40P01', '55P03'].includes(sqlState)) throw new ConflictException({ code: 'MAYA_AT_RISK_CONFLICT' });
  const message = (error as { message?: string })?.message ?? '';
  if (sqlState === '22023' && message === 'SCHOOL_TIMEZONE_INVALID') throw new ConflictException({ code: 'SCHOOL_TIMEZONE_INVALID', detail: 'The school timezone is not a valid IANA timezone.' });
  if (['22023', '22P02'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'MAYA_AT_RISK_UNAVAILABLE' });
}

/**
 * Maya M1 (0259): the current school's students at risk with their reasons and a suggested next step. One protected
 * definer read re-proves the direct human, retention.review.read at the exact school and the paid entitlement, and
 * shows overdue tuition only to staff who may also read billing. Nothing is written, sent or sent to an AI provider.
 */
@Injectable()
export class MayaAtRiskService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(context: MembershipLifecycleContext, value: unknown): Promise<MayaAtRiskStudents> {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'MAYA_AT_RISK_FORBIDDEN' });
    if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    let query;
    try { query = validateMayaAtRiskQuery(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_maya_at_risk_students($1,$2::jsonb) AS data', [subject, JSON.stringify(query)]);
        if (result.rows.length !== 1) throw new Error('Unverified at-risk list.');
        return verifyMayaAtRiskStudents(result.rows[0]!.data);
      });
    } catch (error) { return translateMayaAtRiskError(error); }
  }
}
