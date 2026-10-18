import { ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { verifyCrmIntakeStages, type CrmIntakeStage, type CrmIntakeStagesReadContext } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

function requireDirectHuman(context: CrmIntakeStagesReadContext): void {
  if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId
    || typeof context.externalSubject !== 'string' || !context.externalSubject.trim() || context.externalSubject.trim() !== context.externalSubject || context.externalSubject.length > 200) {
    throw new ForbiddenException({ code: 'CRM_INTAKE_STAGES_FORBIDDEN' });
  }
}
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === '42501') throw new ForbiddenException({ code: 'CRM_INTAKE_STAGES_FORBIDDEN' });
  if (code === '57014') throw new ServiceUnavailableException({ code: 'CRM_INTAKE_STAGES_TIMEOUT' });
  throw error;
}

/** Function-only bounded read of configured non-terminal intake choices. */
@Injectable()
export class CrmIntakeStagesService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(context: CrmIntakeStagesReadContext): Promise<CrmIntakeStage[]> {
    requireDirectHuman(context);
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client) => {
        await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
        await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true), set_config('app.hon_external_subject',$1,true), set_config('app.hon_action_request_id','',true), set_config('app.hon_delegated_by_principal_id','',true)", [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_current_school_crm_intake_stages($1) AS data', [context.externalSubject]);
        if (result.rows.length !== 1) throw new ServiceUnavailableException({ code: 'CRM_INTAKE_STAGES_UNAVAILABLE' });
        return verifyCrmIntakeStages(result.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }
}
