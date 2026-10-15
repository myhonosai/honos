import { Body, ConflictException, Controller, ForbiddenException, Headers, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/manus-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { ProvisionOrganizationDto } from './provision-organization.dto.js';
import { HqOnboardingService } from './hq-onboarding.service.js';

@Controller('hq/organizations')
@UseGuards(HonIdentityGuard)
export class HqOnboardingController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly onboarding: HqOnboardingService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async provision(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: ProvisionOrganizationDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required for tenant provisioning.' });
    }
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const hqScope = await this.database.resolveHqOperatorScope(identity.externalSubject, 'hq.onboarding.manage');
    if (!hqScope) throw new ForbiddenException('HON HQ onboarding is not authorized for this account.');
    const result = await this.onboarding.provisionInitialSchool(identity, { ...input, idempotencyKey });
    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return { data: result, meta: { replayed: result.replayed } };
  }
}
