import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { verifyCurriculumEnrollmentPreparation, type CurriculumEnrollmentPreparation, type CurriculumEnrollmentPreparationInput } from '@hon/contracts';
import type { TenantTransactionContext } from '@hon/database';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

export interface CurriculumEnrollmentPreparationContext extends TenantTransactionContext {
  externalSubject: string;
  correlationId: string;
  source: 'HUMAN_UI';
  actionRequestId?: never;
  delegatedByPrincipalId?: never;
  idempotencyKey: '';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function requireDirectHuman(context: CurriculumEnrollmentPreparationContext): void {
  if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId
    || context.idempotencyKey !== '' || typeof context.externalSubject !== 'string' || !context.externalSubject.trim()
    || context.externalSubject.trim() !== context.externalSubject || context.externalSubject.length > 200
    || ![context.organizationId, context.schoolId, context.principalId, context.requestId, context.correlationId].every((id) => UUID.test(id))) {
    throw new ForbiddenException({ code: 'CURRICULUM_ENROLLMENT_PREPARATION_FORBIDDEN' });
  }
}
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === '42501') throw new ForbiddenException({ code: 'CURRICULUM_ENROLLMENT_PREPARATION_FORBIDDEN' });
  if (code === 'P0002') throw new NotFoundException({ code: 'CURRICULUM_ENROLLMENT_PREPARATION_STUDENT_NOT_FOUND' });
  if (['22023', '22P02', '22003'].includes(code)) throw new BadRequestException({ code: 'INVALID_CURRICULUM_ENROLLMENT_PREPARATION_INPUT' });
  if (code === '57014') throw new ServiceUnavailableException({ code: 'CURRICULUM_ENROLLMENT_PREPARATION_TIMEOUT' });
  throw error;
}

/** Read-only function facade: no table query, idempotency allocation, audit, or downstream operation. */
@Injectable()
export class CurriculumEnrollmentPreparationService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async prepare(context: CurriculumEnrollmentPreparationContext, input: CurriculumEnrollmentPreparationInput): Promise<CurriculumEnrollmentPreparation> {
    requireDirectHuman(context);
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client) => {
        await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
        await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true), set_config('app.hon_external_subject',$1,true), set_config('app.hon_action_request_id','',true), set_config('app.hon_delegated_by_principal_id','',true)", [context.externalSubject]);
        const result = await client.query<{ data: unknown }>(
          'SELECT hon.read_staff_curriculum_enrollment_preparation($1,$2::uuid) AS data',
          [context.externalSubject, input.studentProfileId],
        );
        if (result.rows.length !== 1) throw new ServiceUnavailableException({ code: 'CURRICULUM_ENROLLMENT_PREPARATION_UNAVAILABLE' });
        return verifyCurriculumEnrollmentPreparation(result.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }
}
