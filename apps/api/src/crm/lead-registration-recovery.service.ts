import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { CRM_LEAD_REGISTRATION_UUID, verifyCrmLeadRegistrationRecovery, type CrmLeadRegistrationRecovery, type CrmLeadRegistrationRecoveryContext } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

function human(context: CrmLeadRegistrationRecoveryContext, leadId: string): void {
  if (!context || context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId !== undefined || context.delegatedByPrincipalId !== undefined
    || Object.keys(context).some(key => !['organizationId','schoolId','principalId','principalType','source','requestId','correlationId','idempotencyKey','externalSubject'].includes(key))
    || ![context.organizationId,context.schoolId,context.principalId,context.requestId,context.correlationId].every(id => typeof id === 'string' && CRM_LEAD_REGISTRATION_UUID.test(id))
    || typeof context.externalSubject !== 'string' || !context.externalSubject || context.externalSubject.trim() !== context.externalSubject || context.externalSubject.length > 200) throw new ForbiddenException({ code: 'CRM_LEAD_REGISTRATION_RECOVERY_FORBIDDEN' });
  if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
  if (typeof leadId !== 'string' || !CRM_LEAD_REGISTRATION_UUID.test(leadId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
}
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const code = (error as { code?: string })?.code;
  if (code === '42501') throw new ForbiddenException({ code: 'CRM_LEAD_REGISTRATION_RECOVERY_FORBIDDEN' });
  if (code === 'P0002') throw new NotFoundException({ code: 'CRM_LEAD_REGISTRATION_RECOVERY_UNAVAILABLE' });
  if (['40001','40P01','55P03'].includes(code ?? '')) throw new ConflictException({ code: 'CRM_LEAD_REGISTRATION_RECOVERY_CONFLICT', detail: 'No state was assumed. Try this read again.' });
  if (['22023','22P02'].includes(code ?? '')) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  // Timeouts, unknown failures and unverifiable rows never imply a workflow state.
  throw new ServiceUnavailableException({ code: 'CRM_LEAD_REGISTRATION_RECOVERY_UNAVAILABLE' });
}
@Injectable()
export class LeadRegistrationRecoveryService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  /** Lock-backed reader: no DML, audit, outbox, idempotency, billing, payment or provider effect. */
  async recover(context: CrmLeadRegistrationRecoveryContext, leadId: string): Promise<CrmLeadRegistrationRecovery> {
    human(context, leadId);
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
        await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_crm_lead_registration_recovery($1,$2::uuid) AS data', [context.externalSubject, leadId]);
        if (result.rows.length !== 1) throw new Error('Unverified registration recovery.');
        return verifyCrmLeadRegistrationRecovery(result.rows[0]!.data, leadId);
      });
    } catch (error) { return translate(error); }
  }
}
