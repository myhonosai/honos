import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { RecordTestingScorecardEvaluationDto, TestingScorecardHumanUiGuard } from './testing-scorecard.dto.js';
import { TestingScorecardService, type TestingScorecardContext } from './testing-scorecard.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function knownUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Known school, testing candidate, and testing event UUID selectors are required.' });
  }
}

@Controller('staff/testing/scorecards')
@UseGuards(HonIdentityGuard, TestingScorecardHumanUiGuard)
export class TestingScorecardController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly scorecards: TestingScorecardService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async read(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    if (!query || Object.keys(query).length !== 3 || !Object.hasOwn(query, 'schoolId') || !Object.hasOwn(query, 'testingCandidateId') || !Object.hasOwn(query, 'testingEventId')) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Only known schoolId, testingCandidateId, and testingEventId selectors are accepted.' });
    }
    knownUuid(query.schoolId); knownUuid(query.testingCandidateId); knownUuid(query.testingEventId);
    const context = await this.context(request, query.schoolId);
    return { data: { scorecard: await this.scorecards.read(context, query.testingCandidateId, query.testingEventId) }, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async record(
    @Body() input: RecordTestingScorecardEvaluationDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    knownUuid(input.schoolId); knownUuid(input.testingCandidateId); knownUuid(input.testingEventId);
    const normalizedKey = idempotencyKey?.trim();
    if (!normalizedKey || normalizedKey.length > 200 || /[\u0000-\u001f\u007f]/.test(normalizedKey)) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A bounded Idempotency-Key header is required.' });
    }
    const context = await this.context(request, input.schoolId, normalizedKey);
    const recorded = await this.scorecards.record(context, {
      testingCandidateId: input.testingCandidateId,
      testingEventId: input.testingEventId,
      criterionCode: input.criterionCode,
      assessment: input.assessment,
      expectedCandidateVersion: input.expectedCandidateVersion,
      expectedTestingEventVersion: input.expectedTestingEventVersion,
      expectedScorecardVersion: input.expectedScorecardVersion,
    });
    response.status(recorded.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return { data: { scorecard: recorded }, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: recorded.replayed } };
  }

  private async context(request: HonRequest, schoolId: string, idempotencyKey = `read-${randomUUID()}`): Promise<TestingScorecardContext> {
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const scope = await this.database.resolveTestingScorecardScope(request.honIdentity.externalSubject, schoolId);
    if (!scope || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'TESTING_SCORECARD_SCOPE_DENIED' });
    const requestId = randomUUID();
    return {
      ...scope,
      externalSubject: request.honIdentity.externalSubject,
      principalType: 'HUMAN_USER',
      source: 'HUMAN_UI',
      idempotencyKey,
      requestId,
      correlationId: requestId,
    };
  }
}
