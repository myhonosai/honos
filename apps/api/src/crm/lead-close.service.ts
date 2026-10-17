import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { CRM_LEAD_CLOSE_UUID, validateCloseCrmLeadInput, type CloseCrmLeadInput, type CrmLeadCloseContext, type CrmLeadCloseReceipt } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

export function crmCloseUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !CRM_LEAD_CLOSE_UUID.test(value)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
}
function human(c: CrmLeadCloseContext): void {
  if (!c || c.principalType !== 'HUMAN_USER' || c.source !== 'HUMAN_UI' || c.actionRequestId !== undefined || c.delegatedByPrincipalId !== undefined
    || Object.keys(c).some(k => !['organizationId','schoolId','principalId','principalType','source','requestId','correlationId','idempotencyKey','externalSubject'].includes(k))) {
    throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  }
  for (const id of [c.organizationId,c.schoolId,c.principalId,c.requestId,c.correlationId]) crmCloseUuid(id);
  if (typeof c.externalSubject !== 'string' || !c.externalSubject || c.externalSubject.trim() !== c.externalSubject || c.externalSubject.length > 200) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
}
@Injectable()
export class LeadCloseService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  async close(c: CrmLeadCloseContext, leadId: string, input: CloseCrmLeadInput): Promise<{ receipt: CrmLeadCloseReceipt; replayed: boolean }> {
    human(c); crmCloseUuid(leadId); crmCloseUuid(c.idempotencyKey);
    try { validateCloseCrmLeadInput(input); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    try {
      return await this.database.withTenantTransaction(c, async client => {
        await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [c.source]);
        await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
        return (await client.query<{ data: { receipt: CrmLeadCloseReceipt; replayed: boolean } }>(
          'SELECT hon.close_crm_lead($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid,$6::uuid) data',
          [c.externalSubject,leadId,JSON.stringify(input),c.idempotencyKey,c.requestId,c.correlationId],
        )).rows[0]!.data;
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '42501') throw new ForbiddenException({ code: 'CRM_LEAD_CLOSE_FORBIDDEN' });
      if (code === 'P0002') throw new NotFoundException({ code: 'CRM_LEAD_UNAVAILABLE' });
      if (['40001','23505','55P03','40P01'].includes(code ?? '')) throw new ConflictException({ code: 'CRM_LEAD_CLOSE_CONFLICT', detail: 'Explicitly reload the authorized lead list before a new close command.' });
      if (code === '57014') throw new ServiceUnavailableException({ code: 'CRM_LEAD_CLOSE_TIMEOUT', detail: 'No success assumed. Only an unchanged retained request may be retried.' });
      if (['22023','22P02','23514','23503','22003'].includes(code ?? '')) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
      throw e;
    }
  }
}
