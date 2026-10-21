import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  CRM_ADULT_MEMBERSHIP_DRAFT_UUID, validateCreateMembershipPlanInput, validateCrmAdultMembershipDraftFromPlanInput, validateReviseMembershipPlanInput,
  verifyCrmAdultMembershipDraftFromPlan, verifyCrmAdultMembershipPlanOptions, verifyMembershipPlanCatalog, verifyMembershipPlanVersionSummary,
  type CreateMembershipPlanInput, type CrmAdultMembershipDraftFromPlan, type CrmAdultMembershipDraftFromPlanInput, type CrmAdultMembershipPlanOptions,
  type MembershipPlanCatalog, type MembershipPlanCommandResult, type MembershipPlanContext, type ReviseMembershipPlanInput,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

type Family = 'MEMBERSHIP_PLAN' | 'CRM_ADULT_MEMBERSHIP';
function human(context: MembershipPlanContext, command: boolean, family: Family): void {
  if (!context || context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI'
    || context.actionRequestId !== undefined || context.delegatedByPrincipalId !== undefined
    || Object.keys(context).some(key => !['organizationId','schoolId','principalId','principalType','source','requestId','correlationId','idempotencyKey','externalSubject'].includes(key))
    || ![context.organizationId,context.schoolId,context.principalId,context.requestId,context.correlationId].every(id => typeof id === 'string' && CRM_ADULT_MEMBERSHIP_DRAFT_UUID.test(id))
    || typeof context.externalSubject !== 'string' || !context.externalSubject || context.externalSubject.trim() !== context.externalSubject || context.externalSubject.length > 200) throw new ForbiddenException({ code: `${family}_FORBIDDEN` });
  if (command ? typeof context.idempotencyKey !== 'string' || !CRM_ADULT_MEMBERSHIP_DRAFT_UUID.test(context.idempotencyKey) : context.idempotencyKey !== '') throw new ConflictException({ code: command ? 'IDEMPOTENCY_KEY_REQUIRED' : 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
}
// Named outcomes the reviewing human can act on; everything else is generic and never implies success.
const NAMED: Record<string, (code: string) => HttpException> = {
  MEMBERSHIP_PLAN_CODE_TAKEN: code => new ConflictException({ code }),
  MEMBERSHIP_PLAN_VERSION_STALE: code => new ConflictException({ code, detail: 'A newer version of this plan was published. Reload the plan and review it again.' }),
  MEMBERSHIP_PLAN_CURRENCY_MISMATCH: code => new ConflictException({ code }),
  MEMBERSHIP_PLAN_LIMIT: code => new ConflictException({ code }),
  MEMBERSHIP_PLAN_UNCHANGED: code => new BadRequestException({ code }),
  MEMBERSHIP_PLAN_UNAVAILABLE: code => new NotFoundException({ code }),
  MEMBERSHIP_PLAN_PROGRAM_UNAVAILABLE: code => new NotFoundException({ code }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code }),
};
function translate(error: unknown, family: Family): never {
  if (error instanceof HttpException) throw error;
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  if (message && Object.hasOwn(NAMED, message)) throw NAMED[message]!(message);
  if (code === '42501') throw new ForbiddenException({ code: `${family}_FORBIDDEN` });
  if (code === 'P0002') throw new NotFoundException({ code: `${family}_UNAVAILABLE` });
  if (['23505','40001','40P01','55P03'].includes(code ?? '')) throw new ConflictException({ code: `${family}_CONFLICT`, detail: 'No change was assumed. Check the current state and try again.' });
  if (['22023','22P02','22003','22007','22008','23514','23503'].includes(code ?? '')) throw new BadRequestException({ code: family === 'MEMBERSHIP_PLAN' ? 'INVALID_MEMBERSHIP_PLAN_INPUT' : 'INVALID_CRM_ADULT_MEMBERSHIP_INPUT' });
  throw new ServiceUnavailableException({ code: `${family}_UNAVAILABLE` });
}
async function session(client: PoolClient, context: MembershipPlanContext, command: boolean): Promise<void> {
  await client.query(command ? "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0"
    : "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
  await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.externalSubject]);
}
function commandResult(data: unknown): { plan: unknown; replayed: boolean } {
  if (!data || typeof data !== 'object' || Object.keys(data).sort().join(',') !== 'plan,replayed' || typeof (data as { replayed?: unknown }).replayed !== 'boolean') throw new Error('Unverified plan command.');
  return data as { plan: unknown; replayed: boolean };
}

/** School membership plan catalog: published terms only. No schedule, invoice, payment, charge, discount, agreement or provider effect. */
@Injectable()
export class MembershipPlanService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async catalog(context: MembershipPlanContext): Promise<MembershipPlanCatalog> {
    human(context, false, 'MEMBERSHIP_PLAN');
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await session(client, context, false);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_school_membership_plan_catalog($1) AS data', [context.externalSubject]);
        if (result.rows.length !== 1) throw new Error('Unverified catalog.');
        return verifyMembershipPlanCatalog(result.rows[0]!.data);
      });
    } catch (error) { return translate(error, 'MEMBERSHIP_PLAN'); }
  }

  async create(context: MembershipPlanContext, value: CreateMembershipPlanInput): Promise<MembershipPlanCommandResult> {
    human(context, true, 'MEMBERSHIP_PLAN');
    let input: CreateMembershipPlanInput;
    try { input = validateCreateMembershipPlanInput(value); } catch { throw new BadRequestException({ code: 'INVALID_MEMBERSHIP_PLAN_INPUT' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await session(client, context, true);
        const result = await client.query<{ data: unknown }>('SELECT hon.create_school_membership_plan($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data',
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        if (result.rows.length !== 1) throw new Error('Unverified plan command.');
        const data = commandResult(result.rows[0]!.data);
        const plan = verifyMembershipPlanVersionSummary(data.plan);
        if (plan.planCode !== input.planCode || plan.version !== 1) throw new Error('Unverified plan command.');
        return { plan, replayed: data.replayed };
      });
    } catch (error) { return translate(error, 'MEMBERSHIP_PLAN'); }
  }

  async revise(context: MembershipPlanContext, planId: string, value: ReviseMembershipPlanInput): Promise<MembershipPlanCommandResult> {
    human(context, true, 'MEMBERSHIP_PLAN');
    let input: ReviseMembershipPlanInput;
    if (typeof planId !== 'string' || !CRM_ADULT_MEMBERSHIP_DRAFT_UUID.test(planId)) throw new BadRequestException({ code: 'INVALID_MEMBERSHIP_PLAN_INPUT' });
    try { input = validateReviseMembershipPlanInput(value); } catch { throw new BadRequestException({ code: 'INVALID_MEMBERSHIP_PLAN_INPUT' }); }
    const selected = planId.toLowerCase();
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await session(client, context, true);
        const result = await client.query<{ data: unknown }>('SELECT hon.revise_school_membership_plan($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data',
          [context.externalSubject, selected, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        if (result.rows.length !== 1) throw new Error('Unverified plan command.');
        const data = commandResult(result.rows[0]!.data);
        const plan = verifyMembershipPlanVersionSummary(data.plan);
        if (plan.planId !== selected || plan.version !== input.expectedVersion + 1) throw new Error('Unverified plan command.');
        return { plan, replayed: data.replayed };
      });
    } catch (error) { return translate(error, 'MEMBERSHIP_PLAN'); }
  }

  /** Staff enrollment read: AVAILABLE plans at their current version, for the adult DRAFT actor. */
  async adultDraftPlanOptions(context: MembershipPlanContext): Promise<CrmAdultMembershipPlanOptions> {
    human(context, false, 'CRM_ADULT_MEMBERSHIP');
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await session(client, context, false);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_crm_adult_membership_plan_options($1) AS data', [context.externalSubject]);
        if (result.rows.length !== 1) throw new Error('Unverified plan options.');
        return verifyCrmAdultMembershipPlanOptions(result.rows[0]!.data);
      });
    } catch (error) { return translate(error, 'CRM_ADULT_MEMBERSHIP'); }
  }

  async draftAdultMembershipFromPlan(context: MembershipPlanContext, value: CrmAdultMembershipDraftFromPlanInput): Promise<CrmAdultMembershipDraftFromPlan & { replayed: boolean }> {
    human(context, true, 'CRM_ADULT_MEMBERSHIP');
    let input: CrmAdultMembershipDraftFromPlanInput;
    try { input = validateCrmAdultMembershipDraftFromPlanInput(value); } catch { throw new BadRequestException({ code: 'INVALID_CRM_ADULT_MEMBERSHIP_INPUT' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await session(client, context, true);
        const result = await client.query<{ data: { receipt: unknown; plan: unknown; replayed: boolean } }>('SELECT hon.draft_crm_adult_membership_from_plan($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data',
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'plan,receipt,replayed' || typeof data.replayed !== 'boolean') throw new Error('Unverified draft.');
        return { ...verifyCrmAdultMembershipDraftFromPlan({ receipt: data.receipt, plan: data.plan }, input), replayed: data.replayed };
      });
    } catch (error) { return translate(error, 'CRM_ADULT_MEMBERSHIP'); }
  }
}
