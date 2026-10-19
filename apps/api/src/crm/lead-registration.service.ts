import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { CRM_LEAD_REGISTRATION_UUID, validateRegisterCrmLeadInput, verifyCrmLeadRegistrationResult, type CrmLeadRegistrationContext, type RegisterCrmLeadInput } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

export function crmRegistrationUuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !CRM_LEAD_REGISTRATION_UUID.test(value)) throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
function human(context: CrmLeadRegistrationContext): void {
  if (!context || context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId !== undefined || context.delegatedByPrincipalId !== undefined
    || Object.keys(context).some(key => !['organizationId','schoolId','principalId','principalType','source','requestId','correlationId','idempotencyKey','externalSubject'].includes(key))) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  for (const value of [context.organizationId, context.schoolId, context.principalId, context.requestId, context.correlationId, context.idempotencyKey]) crmRegistrationUuid(value);
  if (typeof context.externalSubject !== 'string' || !context.externalSubject || context.externalSubject.trim() !== context.externalSubject || context.externalSubject.length > 200) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
}
@Injectable()
export class LeadRegistrationService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  async register(context: CrmLeadRegistrationContext, leadId: string, input: RegisterCrmLeadInput) {
    human(context); crmRegistrationUuid(leadId);
    try { validateRegisterCrmLeadInput(input); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source, context.externalSubject]);
        await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0");
        const row = await client.query<{ data: { result: unknown; replayed: boolean } }>('SELECT hon.register_crm_lead_person($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) data', [context.externalSubject, leadId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        const data = row.rows[0]?.data;
        if (!data || typeof data.replayed !== 'boolean') throw new Error('Unverified CRM registration response.');
        return { result: verifyCrmLeadRegistrationResult(data.result, leadId, input), replayed: data.replayed };
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '42501') throw new ForbiddenException({ code: 'CRM_LEAD_REGISTRATION_FORBIDDEN' });
      if (code === 'P0002') throw new NotFoundException({ code: 'CRM_LEAD_REGISTRATION_UNAVAILABLE' });
      if (['40001','23505','55P03','40P01'].includes(code ?? '')) throw new ConflictException({ code: 'CRM_LEAD_REGISTRATION_CONFLICT', detail: 'Explicitly return to the authorized lead row before preparing a new command.' });
      if (code === '57014') throw new ServiceUnavailableException({ code: 'CRM_LEAD_REGISTRATION_TIMEOUT', detail: 'No success is assumed. Only the unchanged in-memory request may be retried.' });
      if (['22023','22P02','23514','23503','22003'].includes(code ?? '')) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
      throw error;
    }
  }
}
