import { TestingHumanUiGuard } from './testing-human-ui.guard.js';
import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { GradeTestingCandidateDto } from './grade-testing-candidate.dto.js';
import { TestingCandidateService } from './testing-candidate.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/testing/candidates')
@UseGuards(HonIdentityGuard, TestingHumanUiGuard)
export class TestingCandidateGradeController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly candidates: TestingCandidateService,
  ) {}

  /**
   * Records an instructor's assessment of an existing candidate. Promotion and
   * rank advancement are intentionally separate, explicitly authorized flows.
   */
  @Post(':candidateId/grade')
  @HttpCode(HttpStatus.OK)
  async grade(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('candidateId', new ParseUUIDPipe()) candidateId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: GradeTestingCandidateDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A unique Idempotency-Key header of at most 200 characters is required for testing candidate grading.',
      });
    }

    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'testing.manage',
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON testing candidate grading is not authorized for this school.');
    }

    const requestId = randomUUID();
    const context: CommandContext = {
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      principalType: 'HUMAN_USER',
      requestId,
      correlationId: requestId,
      idempotencyKey: normalizedIdempotencyKey,
      source: 'HUMAN_UI',
    };
    const result = await this.candidates.grade(context, candidateId, input);

    response.status(HttpStatus.OK);
    return {
      data: result.candidate,
      meta: {
        requestId,
        correlationId: requestId,
        replayed: result.replayed,
      },
    };
  }
}
