import { Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import { SubmitTestingRegistrationInterestDto, DecideTestingRegistrationInterestDto } from './testing-registration.dto.js';
import { TestingRegistrationHumanUiGuard } from './testing-registration-human-ui.guard.js';
import { TestingRegistrationService } from './testing-registration.service.js';

function retryKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header of at most 200 characters is required.' });
  return key;
}
function identity(request: HonRequest): string {
  if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
  return request.honIdentity.externalSubject;
}

/** No family, school, organization, actor, eligibility, candidate, payment or roster selectors are accepted. */
@Controller('parent/testing')
@UseGuards(HonIdentityGuard, TestingRegistrationHumanUiGuard)
export class ParentTestingRegistrationController {
  constructor(private readonly registrations: TestingRegistrationService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async view(@Req() request: HonRequest) {
    const result = await this.registrations.parentView(identity(request));
    return { data: result.view, meta: { requestId: result.context.requestId, correlationId: result.context.correlationId } };
  }

  @Post('interests')
  @HttpCode(HttpStatus.CREATED)
  async submit(@Headers('idempotency-key') key: string | undefined, @Body() input: SubmitTestingRegistrationInterestDto, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    const result = await this.registrations.submitInterest(identity(request), retryKey(key), input);
    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return { data: result.receipt, meta: { requestId: result.context.requestId, correlationId: result.context.correlationId, replayed: result.replayed } };
  }
}

/** Staff queue has a database-derived single scope; no staff page may choose a school or family. */
@Controller('staff/testing/registrations')
@UseGuards(HonIdentityGuard, TestingRegistrationHumanUiGuard)
export class StaffTestingRegistrationController {
  constructor(private readonly registrations: TestingRegistrationService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async view(@Req() request: HonRequest) {
    const result = await this.registrations.staffView(identity(request));
    return { data: result.view, meta: { requestId: result.context.requestId, correlationId: result.context.correlationId } };
  }

  @Post(':interestId/decision')
  @HttpCode(HttpStatus.OK)
  async decide(@Param('interestId', new ParseUUIDPipe()) interestId: string, @Headers('idempotency-key') key: string | undefined, @Body() input: DecideTestingRegistrationInterestDto, @Req() request: HonRequest) {
    const result = await this.registrations.review(identity(request), interestId, retryKey(key), input);
    return { data: result.receipt, meta: { requestId: result.context.requestId, correlationId: result.context.correlationId, replayed: result.replayed } };
  }
}
