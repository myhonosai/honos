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
import type { HonRequest } from '../foundation/manus-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { RegisterTestingCandidateDto } from './register-testing-candidate.dto.js';
import { TestingCandidateService } from './testing-candidate.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/testing/events')
@UseGuards(HonIdentityGuard)
export class TestingCandidateController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly candidates: TestingCandidateService,
  ) {}

  @Post(':testingEventId/candidates')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('testingEventId', new ParseUUIDPipe()) testingEventId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: RegisterTestingCandidateDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A unique Idempotency-Key header of at most 200 characters is required for testing candidate registration.',
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
      throw new ForbiddenException('HON testing candidate registration is not authorized for this school.');
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
    const result = await this.candidates.register(context, testingEventId, input);

    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
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
