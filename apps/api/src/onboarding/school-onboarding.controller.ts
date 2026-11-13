import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { SchoolOnboardingReadHumanUiGuard, SchoolOnboardingSaveHumanUiGuard } from './school-onboarding.guard.js';
import { SchoolOnboardingService, type SchoolOnboardingContext } from './school-onboarding.service.js';

const PERMISSION = 'onboarding.manage';

/** Onboarding (0323). Route ids are never authority: scope comes from the verified session and the database re-proves it. */
@Controller('organizations/:organizationId/schools/:schoolId/onboarding')
@UseGuards(HonIdentityGuard)
export class SchoolOnboardingController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly onboarding: SchoolOnboardingService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolOnboardingReadHumanUiGuard)
  async read(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.onboarding.read(context), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post('profile')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(SchoolOnboardingSaveHumanUiGuard)
  async save(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    if (!idempotencyKey || idempotencyKey.length > 200 || idempotencyKey.trim() !== idempotencyKey) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const context = await this.context(request, organizationId, schoolId, idempotencyKey);
    const result = await this.onboarding.save(context, input);
    return { data: result.profile, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<SchoolOnboardingContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'ONBOARDING_INVALID' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, PERMISSION);
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'ONBOARDING_FORBIDDEN' });
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
