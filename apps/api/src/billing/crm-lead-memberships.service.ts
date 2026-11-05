import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { verifyCrmLeadMemberships, type CrmLeadMemberships } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from './membership.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const CONTEXT_KEYS = ['organizationId', 'schoolId', 'principalId', 'principalType', 'source', 'requestId', 'correlationId', 'idempotencyKey', 'externalSubject'];

function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const code = (error as { code?: string })?.code ?? '';
  if (code === '42501') throw new ForbiddenException({ code: 'CRM_LEAD_MEMBERSHIPS_FORBIDDEN' });
  if (code === 'P0002') throw new NotFoundException({ code: 'CRM_LEAD_MEMBERSHIPS_UNAVAILABLE' });
  if (['40001', '40P01', '55P03'].includes(code)) throw new ConflictException({ code: 'CRM_LEAD_MEMBERSHIPS_CONFLICT', detail: 'No state was assumed. Try this read again.' });
  if (['22023', '22P02'].includes(code)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  // Timeouts, unknown failures and unverifiable rows never imply that a lead has, or lacks, a membership.
  throw new ServiceUnavailableException({ code: 'CRM_LEAD_MEMBERSHIPS_UNAVAILABLE' });
}

@Injectable()
export class CrmLeadMembershipsService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  /** D-M1 (0200): read-only discovery of the memberships one lead's own CRM workflow created. No DML or effect. */
  async read(context: MembershipLifecycleContext, leadId: string): Promise<CrmLeadMemberships> {
    if (!context || context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId !== undefined
      || context.delegatedByPrincipalId !== undefined || Object.keys(context).some(key => !CONTEXT_KEYS.includes(key))
      || typeof context.externalSubject !== 'string' || !context.externalSubject || context.externalSubject.trim() !== context.externalSubject
      || context.externalSubject.length > 200) throw new ForbiddenException({ code: 'CRM_LEAD_MEMBERSHIPS_FORBIDDEN' });
    if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    if (typeof leadId !== 'string' || !UUID.test(leadId)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_crm_lead_memberships($1,$2::uuid) AS data', [context.externalSubject, leadId]);
        if (result.rows.length !== 1) throw new Error('Unverified lead membership discovery.');
        return verifyCrmLeadMemberships(result.rows[0]!.data, leadId);
      });
    } catch (error) { return translate(error); }
  }
}
