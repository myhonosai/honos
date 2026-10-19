import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { CRM_ADULT_MEMBERSHIP_DRAFT_UUID, validateCrmAdultMembershipDraftConfirmationInput, validateCrmAdultMembershipDraftInput, validateCrmAdultMembershipPreparationInput, verifyCrmAdultMembershipDraftConfirmation, verifyCrmAdultMembershipDraftReceipt, verifyCrmAdultMembershipPreparation, type CrmAdultMembershipDraftConfirmation, type CrmAdultMembershipDraftConfirmationInput, type CrmAdultMembershipDraftContext, type CrmAdultMembershipDraftInput, type CrmAdultMembershipDraftReceipt, type CrmAdultMembershipPreparation, type CrmAdultMembershipPreparationInput } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

function human(context: CrmAdultMembershipDraftContext, command: boolean): void {
  if (!context || context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI'
    || context.actionRequestId !== undefined || context.delegatedByPrincipalId !== undefined
    || Object.keys(context).some(key => !['organizationId','schoolId','principalId','principalType','source','requestId','correlationId','idempotencyKey','externalSubject'].includes(key))
    || ![context.organizationId,context.schoolId,context.principalId,context.requestId,context.correlationId].every(id => typeof id === 'string' && CRM_ADULT_MEMBERSHIP_DRAFT_UUID.test(id))
    || typeof context.externalSubject !== 'string' || !context.externalSubject || context.externalSubject.trim() !== context.externalSubject || context.externalSubject.length > 200) throw new ForbiddenException({ code: 'CRM_ADULT_MEMBERSHIP_FORBIDDEN' });
  if (command ? typeof context.idempotencyKey !== 'string' || !CRM_ADULT_MEMBERSHIP_DRAFT_UUID.test(context.idempotencyKey) : context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
}
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const code = (error as { code?: string })?.code;
  if (code === '42501') throw new ForbiddenException({ code: 'CRM_ADULT_MEMBERSHIP_FORBIDDEN' });
  if (code === 'P0002') throw new NotFoundException({ code: 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' });
  if (['23505','40001','55P03','40P01'].includes(code ?? '')) throw new ConflictException({ code: 'CRM_ADULT_MEMBERSHIP_CONFLICT' });
  if (['22023','22P02','22003','22007','22008','23514','23503'].includes(code ?? '')) throw new BadRequestException({ code: 'INVALID_CRM_ADULT_MEMBERSHIP_INPUT' });
  // Unknown persistence/receipt failures never imply success or reveal source matches.
  throw new ServiceUnavailableException({ code: 'CRM_ADULT_MEMBERSHIP_UNAVAILABLE' });
}
@Injectable()
export class CrmAdultMembershipDraftService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  async prepare(context: CrmAdultMembershipDraftContext, value: CrmAdultMembershipPreparationInput): Promise<CrmAdultMembershipPreparation> {
    human(context, false);
    let input: CrmAdultMembershipPreparationInput;
    try { input = validateCrmAdultMembershipPreparationInput(value); } catch { throw new BadRequestException({ code: 'INVALID_CRM_ADULT_MEMBERSHIP_INPUT' }); }
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
        await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_crm_adult_membership_preparation($1,$2::uuid) AS data', [context.externalSubject,input.studentProfileId]);
        if (result.rows.length !== 1) throw new Error('Unverified preparation.');
        return verifyCrmAdultMembershipPreparation(result.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }
  /** Lock-backed reader: no DML, audit, outbox, idempotency, or provider effect. */
  async confirmCurrentDraft(context: CrmAdultMembershipDraftContext, value: CrmAdultMembershipDraftConfirmationInput): Promise<CrmAdultMembershipDraftConfirmation> {
    human(context, false);
    let input: CrmAdultMembershipDraftConfirmationInput;
    try { input = validateCrmAdultMembershipDraftConfirmationInput(value); } catch { throw new BadRequestException({ code: 'INVALID_CRM_ADULT_MEMBERSHIP_INPUT' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
        await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_crm_adult_membership_draft_confirmation($1,$2::uuid) AS data', [context.externalSubject,input.studentProfileId]);
        if (result.rows.length !== 1) throw new Error('Unverified current confirmation.');
        return verifyCrmAdultMembershipDraftConfirmation(result.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }
  async draft(context: CrmAdultMembershipDraftContext, value: CrmAdultMembershipDraftInput): Promise<{ receipt: CrmAdultMembershipDraftReceipt; replayed: boolean }> {
    human(context, true);
    let input: CrmAdultMembershipDraftInput;
    try { input = validateCrmAdultMembershipDraftInput(value); } catch { throw new BadRequestException({ code: 'INVALID_CRM_ADULT_MEMBERSHIP_INPUT' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0");
        await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.externalSubject]);
        const result = await client.query<{ data: { receipt: unknown; replayed: boolean } }>('SELECT hon.draft_crm_adult_membership($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', [context.externalSubject,JSON.stringify(input),context.idempotencyKey,context.requestId,context.correlationId]);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') throw new Error('Unverified draft.');
        return { receipt: verifyCrmAdultMembershipDraftReceipt(data.receipt, input), replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }
}
