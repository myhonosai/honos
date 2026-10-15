import { BadRequestException, Controller, ForbiddenException, Get, Header, HttpCode, HttpStatus, Post, Body, Headers, Query, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { IssueTestingCertificateDto, TestingCertificateHumanUiGuard } from './testing-certificate.dto.js';
import { TestingCertificateService, type TestingCertificateContext } from './testing-certificate.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function knownUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Known school and testing candidate UUID selectors are required.' });
  }
}

@Controller('staff/testing/certificates')
@UseGuards(HonIdentityGuard, TestingCertificateHumanUiGuard)
export class TestingCertificateController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly certificates: TestingCertificateService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async read(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    if (!query || Object.keys(query).length !== 2 || !Object.hasOwn(query, 'schoolId') || !Object.hasOwn(query, 'testingCandidateId')) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Only known schoolId and testingCandidateId selectors are accepted.' });
    }
    knownUuid(query.schoolId); knownUuid(query.testingCandidateId);
    const context = await this.context(request, query.schoolId);
    return { data: { certificate: await this.certificates.read(context, query.testingCandidateId) }, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async issue(
    @Body() input: IssueTestingCertificateDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    knownUuid(input.schoolId); knownUuid(input.testingCandidateId);
    const normalizedKey = idempotencyKey?.trim();
    if (!normalizedKey || normalizedKey.length > 200 || /[\u0000-\u001f\u007f]/.test(normalizedKey)) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A bounded Idempotency-Key header is required.' });
    }
    const context = await this.context(request, input.schoolId, normalizedKey);
    const issued = await this.certificates.issue(context, {
      testingCandidateId: input.testingCandidateId,
      expectedCandidateVersion: input.expectedCandidateVersion,
      expectedCertificateVersion: input.expectedCertificateVersion,
      title: input.title,
    });
    response.status(issued.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return { data: { certificate: issued.certificate }, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: issued.replayed } };
  }

  private async context(request: HonRequest, schoolId: string, idempotencyKey = `read-${randomUUID()}`): Promise<TestingCertificateContext> {
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const scope = await this.database.resolveTestingCertificateScope(request.honIdentity.externalSubject, schoolId);
    if (!scope || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'TESTING_CERTIFICATE_SCOPE_DENIED' });
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
