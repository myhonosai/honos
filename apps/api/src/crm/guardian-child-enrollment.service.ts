import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  CRM_LEAD_REGISTRATION_UUID, validateCrmGuardianChildAdditionInput, validateCrmGuardianChildMembershipDraftFromPlanInput, validateCrmGuardianChildPayerDesignationInput,
  verifyCrmGuardianChildAdditionResult, verifyCrmGuardianChildEnrollment, verifyCrmGuardianChildMembershipDraftFromPlan, verifyCrmGuardianChildPayerDesignationReceipt,
  type CrmGuardianChildAdditionInput, type CrmGuardianChildAdditionResult, type CrmGuardianChildEnrollment, type CrmGuardianChildEnrollmentContext,
  type CrmGuardianChildMembershipDraftFromPlan, type CrmGuardianChildMembershipDraftFromPlanInput, type CrmGuardianChildPayerDesignationInput,
  type CrmGuardianChildPayerDesignationReceipt,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

function human(context: CrmGuardianChildEnrollmentContext, command: boolean): void {
  if (!context || context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId !== undefined || context.delegatedByPrincipalId !== undefined
    || Object.keys(context).some(key => !['organizationId','schoolId','principalId','principalType','source','requestId','correlationId','idempotencyKey','externalSubject'].includes(key))
    || ![context.organizationId,context.schoolId,context.principalId,context.requestId,context.correlationId].every(id => typeof id === 'string' && CRM_LEAD_REGISTRATION_UUID.test(id))
    || typeof context.externalSubject !== 'string' || !context.externalSubject || context.externalSubject.trim() !== context.externalSubject || context.externalSubject.length > 200) throw new ForbiddenException({ code: 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN' });
  if (command ? typeof context.idempotencyKey !== 'string' || !CRM_LEAD_REGISTRATION_UUID.test(context.idempotencyKey) : context.idempotencyKey !== '') throw new ConflictException({ code: command ? 'IDEMPOTENCY_KEY_REQUIRED' : 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
}
function lead(value: unknown): string {
  if (typeof value !== 'string' || !CRM_LEAD_REGISTRATION_UUID.test(value)) throw new BadRequestException({ code: 'INVALID_CRM_GUARDIAN_CHILD_ENROLLMENT_INPUT' });
  return value.toLowerCase();
}
// Named outcomes the reviewing human can act on; everything else is generic and never implies success.
const NAMED: Record<string, (code: string) => HttpException> = {
  CRM_GUARDIAN_CHILD_BILLING_ACCOUNT_REQUIRED: code => new ConflictException({ code, detail: 'Create or reuse the guardian\'s canonical billing account first, then designate the payer.' }),
  CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_REQUIRED: code => new ConflictException({ code, detail: 'Designate the guardian as payer before drafting a child membership.' }),
  CRM_GUARDIAN_CHILD_LIMIT: code => new ConflictException({ code }),
  MEMBERSHIP_PLAN_VERSION_STALE: code => new ConflictException({ code, detail: 'A newer version of this plan was published. Reload the plan and review it again.' }),
  MEMBERSHIP_PLAN_CURRENCY_MISMATCH: code => new ConflictException({ code }),
  MEMBERSHIP_PLAN_UNAVAILABLE: code => new NotFoundException({ code }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code }),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  if (message && Object.hasOwn(NAMED, message)) throw NAMED[message]!(message);
  if (code === '42501') throw new ForbiddenException({ code: 'CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN' });
  if (code === 'P0002') throw new NotFoundException({ code: 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' });
  if (['23505','40001','40P01','55P03'].includes(code ?? '')) throw new ConflictException({ code: 'CRM_GUARDIAN_CHILD_ENROLLMENT_CONFLICT', detail: 'No change was assumed. Check the current state and try again.' });
  if (['22023','22P02','22003','22007','22008','23514','23503'].includes(code ?? '')) throw new BadRequestException({ code: 'INVALID_CRM_GUARDIAN_CHILD_ENROLLMENT_INPUT' });
  // Timeouts, unknown failures and unverifiable rows never imply a workflow state or success.
  throw new ServiceUnavailableException({ code: 'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' });
}
async function session(client: PoolClient, context: CrmGuardianChildEnrollmentContext, command: boolean): Promise<void> {
  await client.query(command ? "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0"
    : "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
  await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.externalSubject]);
}
function command<K extends string>(data: unknown, keys: readonly K[]): Record<K, unknown> & { replayed: boolean } {
  if (!data || typeof data !== 'object' || Object.keys(data).sort().join(',') !== [...keys, 'replayed'].sort().join(',')
    || typeof (data as { replayed?: unknown }).replayed !== 'boolean') throw new Error('Unverified guardian/child command.');
  return data as Record<K, unknown> & { replayed: boolean };
}

/**
 * Guardian/child CRM enrollment (0176). Payer designation, additional children and one plan-bound DRAFT per child;
 * no schedule, invoice, payment, agreement, consent, provider, activation, communication, AI or automation effect.
 */
@Injectable()
export class GuardianChildEnrollmentService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  /** Lock-backed reader (it takes SHARE locks, so it cannot run READ ONLY): no DML of any kind. */
  async read(context: CrmGuardianChildEnrollmentContext, leadId: string): Promise<CrmGuardianChildEnrollment> {
    human(context, false);
    const selected = lead(leadId);
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await session(client, context, false);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_crm_guardian_child_enrollment($1,$2::uuid) AS data', [context.externalSubject, selected]);
        if (result.rows.length !== 1) throw new Error('Unverified guardian/child enrollment.');
        return verifyCrmGuardianChildEnrollment(result.rows[0]!.data, selected);
      });
    } catch (error) { return translate(error); }
  }

  async designatePayer(context: CrmGuardianChildEnrollmentContext, leadId: string, value: CrmGuardianChildPayerDesignationInput): Promise<{ receipt: CrmGuardianChildPayerDesignationReceipt; replayed: boolean }> {
    human(context, true);
    const selected = lead(leadId);
    let input: CrmGuardianChildPayerDesignationInput;
    try { input = validateCrmGuardianChildPayerDesignationInput(value); } catch { throw new BadRequestException({ code: 'INVALID_CRM_GUARDIAN_CHILD_ENROLLMENT_INPUT' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await session(client, context, true);
        const result = await client.query<{ data: unknown }>('SELECT hon.designate_crm_guardian_child_payer($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data',
          [context.externalSubject, selected, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        if (result.rows.length !== 1) throw new Error('Unverified guardian/child command.');
        const data = command(result.rows[0]!.data, ['receipt']);
        return { receipt: verifyCrmGuardianChildPayerDesignationReceipt(data.receipt), replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }

  async addChild(context: CrmGuardianChildEnrollmentContext, leadId: string, value: CrmGuardianChildAdditionInput): Promise<{ result: CrmGuardianChildAdditionResult; replayed: boolean }> {
    human(context, true);
    const selected = lead(leadId);
    let input: CrmGuardianChildAdditionInput;
    try { input = validateCrmGuardianChildAdditionInput(value); } catch { throw new BadRequestException({ code: 'INVALID_CRM_GUARDIAN_CHILD_ENROLLMENT_INPUT' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await session(client, context, true);
        const result = await client.query<{ data: unknown }>('SELECT hon.add_crm_guardian_child_additional_child($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) AS data',
          [context.externalSubject, selected, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        if (result.rows.length !== 1) throw new Error('Unverified guardian/child command.');
        const data = command(result.rows[0]!.data, ['result']);
        return { result: verifyCrmGuardianChildAdditionResult(data.result, selected, input), replayed: data.replayed };
      });
    } catch (error) {
      // A possible existing record rolled the whole transaction back (key reservation included): nothing was written.
      if ((error as { message?: string })?.message === 'CRM_GUARDIAN_CHILD_NEEDS_STAFF_REVIEW') return { result: { outcome: 'NEEDS_STAFF_REVIEW' }, replayed: false };
      return translate(error);
    }
  }

  async draftMembershipFromPlan(context: CrmGuardianChildEnrollmentContext, value: CrmGuardianChildMembershipDraftFromPlanInput): Promise<CrmGuardianChildMembershipDraftFromPlan & { replayed: boolean }> {
    human(context, true);
    let input: CrmGuardianChildMembershipDraftFromPlanInput;
    try { input = validateCrmGuardianChildMembershipDraftFromPlanInput(value); } catch { throw new BadRequestException({ code: 'INVALID_CRM_GUARDIAN_CHILD_ENROLLMENT_INPUT' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await session(client, context, true);
        const result = await client.query<{ data: unknown }>('SELECT hon.draft_crm_guardian_child_membership_from_plan($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data',
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        if (result.rows.length !== 1) throw new Error('Unverified guardian/child command.');
        const data = command(result.rows[0]!.data, ['receipt', 'plan']);
        return { ...verifyCrmGuardianChildMembershipDraftFromPlan({ receipt: data.receipt, plan: data.plan }, input), replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }
}
