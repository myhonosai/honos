import { Body, Controller, ForbiddenException, Header, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CurriculumEnrollmentPreparationApiResponse } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CurriculumEnrollmentPreparationDto } from './curriculum-enrollment-preparation.dto.js';
import { CurriculumEnrollmentPreparationGuard, CurriculumEnrollmentPreparationNoStoreGuard } from './curriculum-enrollment-preparation.guard.js';
import { CurriculumEnrollmentPreparationService, type CurriculumEnrollmentPreparationContext } from './curriculum-enrollment-preparation.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/curricula/enrollment-preparation')
@UseGuards(CurriculumEnrollmentPreparationNoStoreGuard, HonIdentityGuard, CurriculumEnrollmentPreparationGuard)
export class CurriculumEnrollmentPreparationController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly preparation: CurriculumEnrollmentPreparationService) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async prepare(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Body() input: CurriculumEnrollmentPreparationDto,
    @Req() request: HonRequest,
  ): Promise<CurriculumEnrollmentPreparationApiResponse> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'curriculum.progress.record');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException({ code: 'CURRICULUM_ENROLLMENT_PREPARATION_SCOPE_DENIED' });
    }
    const requestId = randomUUID();
    const context: CurriculumEnrollmentPreparationContext = {
      ...scope,
      externalSubject: identity.externalSubject,
      principalType: 'HUMAN_USER',
      source: 'HUMAN_UI',
      requestId,
      correlationId: requestId,
      idempotencyKey: '',
    };
    return {
      data: await this.preparation.prepare(context, input),
      meta: { requestId, correlationId: requestId, replayed: false },
    };
  }
}
