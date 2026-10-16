import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { parsePromotionReadiness, readinessUuid, type PromotionReadiness, type PromotionReadinessContext } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
export function readinessError(error: unknown): never {
 const code = (error as { code?: string })?.code;
 if (code === '42501') throw new ForbiddenException({ code: 'PROMOTION_READINESS_FORBIDDEN' });
 if (code === 'P0002') throw new NotFoundException({ code: 'PROMOTION_READINESS_NOT_FOUND' });
 if (['22023', '22P02'].includes(code ?? '')) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
 throw new ServiceUnavailableException({ code: 'PROMOTION_READINESS_UNAVAILABLE', detail: 'No verified readiness result is available.' });
}
@Injectable()
export class PromotionReadinessService {
 constructor(private readonly database: RuntimeDatabaseService) {}
 async read(context: PromotionReadinessContext, curriculumId: string, enrollmentId: string): Promise<PromotionReadiness> {
  if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId || typeof context.externalSubject !== 'string' || !context.externalSubject || context.externalSubject.length > 200) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  if (![context.organizationId, context.schoolId, context.principalId, context.requestId, context.correlationId, curriculumId, enrollmentId].every(readinessUuid)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  try {
   return await this.database.withTenantReadOnlyTransaction(context, async client => {
    await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.externalSubject]);
    await client.query("SET LOCAL statement_timeout='5s'");
    const result = await client.query<{ data: unknown }>('SELECT hon.read_promotion_readiness($1,$2::uuid,$3::uuid) data', [context.externalSubject, curriculumId, enrollmentId]);
    return parsePromotionReadiness(result.rows[0]?.data, { organizationId: context.organizationId, schoolId: context.schoolId, curriculumId, enrollmentId });
   });
  } catch (error) { return readinessError(error); }
 }
}
